// A PROJECT'S OWN TOOLS, LOADED FROM ITS CHECKOUT.
//
// TypeScript is loaded here as well as JavaScript: typescript.js erases the
// types and the runtime runs what is left, the way Node's own
// `--experimental-strip-types` does.
//
// pi has no plugin system. Its published package contains no such word: the
// only extension points are `harness.hooks.on(...)` and the loop's
// `beforeToolCall`/`afterToolCall`, both in-process, both requiring a caller
// who already holds the object. There is no loader, no path, no manifest
// field — a pi project cannot ship a tool. OpenCode has one (its binary
// bundles `<config_dir>/plugins/*.ts` with Bun at session time), and the pi
// starter DELETES that directory on purpose, because a pi project runs no
// OpenCode to read it.
//
// So a pi project's tools had nowhere to live. That was true while a cell
// could not execute JavaScript. It can now (nodejs.js), so this is the loader:
// a module in `<config_dir>/plugins` is evaluated in the cell's own runtime
// and the tools it returns join the six the agent already has.
//
// THE CONTRACT IS pi's, NOT OPENCODE'S, and deliberately so. An OpenCode
// plugin is handed an OpenCode `client`, a `serverUrl` and a `$` shell — a
// cell has none of those and would have to fake all three. A pi plugin is
// handed what a cell actually has: the workspace, the session, and a guarded
// fetch. A plugin written for OpenCode does not load here, and says so rather
// than half-working.
//
//   export default async function ({ project, session, cwd, fetch, log }) {
//     return {
//       tools: {
//         greet: {
//           description: "Say hello to someone.",
//           parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
//           async execute({ name }) { return `hello ${name}`; },
//         },
//       },
//     };
//   }
import { Type } from "typebox";

/** Where a project's plugins live, under whatever config dir its manifest names. */
export const pluginsDirFor = (configDir) => `${String(configDir ?? ".kortix/pi").replace(/\/+$/, "")}/plugins`;

/** A plugin file: JavaScript or TypeScript, loaded as a module. */
export const PLUGIN_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"];
/** How long one plugin may take to load, and how many a project may ship. */
export const PLUGIN_LOAD_TIMEOUT_MS = 10_000;
export const PLUGIN_MAX = 25;
export const PLUGIN_TOOLS_MAX = 50;

export const isPluginFile = (name) =>
  PLUGIN_EXTENSIONS.some((e) => name.endsWith(e)) && !name.startsWith(".")
  && !/\.(test|spec)\.[mc]?[jt]s$/.test(name) && !name.endsWith(".d.ts");

/**
 * A plugin's declared tools, checked before any of them reaches the model.
 *
 * A tool with no name, no description or no execute is not a tool, and a
 * plugin that returns one has a bug its author should see rather than a model
 * discovering it mid-turn. Every rejection is reported by name.
 */
export function validateTools(returned, pluginName) {
  const tools = [];
  const rejected = [];
  const map = returned && typeof returned === "object" ? (returned.tools ?? returned) : null;
  if (!map || typeof map !== "object") return { tools, rejected: [`${pluginName}: returned no tools`] };
  for (const [name, spec] of Object.entries(map)) {
    if (tools.length >= PLUGIN_TOOLS_MAX) { rejected.push(`${pluginName}: more than ${PLUGIN_TOOLS_MAX} tools`); break; }
    if (!/^[a-z][a-z0-9_]{0,48}$/i.test(name)) { rejected.push(`${pluginName}.${name}: a tool name must be a short identifier`); continue; }
    if (!spec || typeof spec !== "object") { rejected.push(`${pluginName}.${name}: not a tool object`); continue; }
    if (typeof spec.execute !== "function") { rejected.push(`${pluginName}.${name}: has no execute()`); continue; }
    if (typeof spec.description !== "string" || !spec.description.trim()) { rejected.push(`${pluginName}.${name}: has no description, so the model cannot know when to use it`); continue; }
    tools.push({ name, spec, plugin: pluginName });
  }
  return { tools, rejected };
}

/**
 * A plugin's tool in the shape pi takes.
 *
 * `parameters` is a JSON Schema object in the plugin's own words; pi wants a
 * typebox schema, and the two are the same shape for the object-with-properties
 * case every tool actually uses. A plugin that declares nothing gets an empty
 * object rather than a schema that rejects every call.
 */
export function toPiTool({ name, spec, plugin }, { onError } = {}) {
  const props = spec.parameters?.properties;
  const required = new Set(Array.isArray(spec.parameters?.required) ? spec.parameters.required : []);
  const fields = {};
  for (const [key, def] of Object.entries(props ?? {})) {
    const described = { description: typeof def?.description === "string" ? def.description : undefined };
    const base = def?.type === "number" || def?.type === "integer" ? Type.Number(described)
      : def?.type === "boolean" ? Type.Boolean(described)
      : def?.type === "array" ? Type.Array(Type.String(), described)
      : def?.type === "object" ? Type.Object({}, described)
      : Type.String(described);
    fields[key] = required.has(key) ? base : Type.Optional(base);
  }
  return {
    name,
    label: typeof spec.label === "string" ? spec.label : name,
    description: `${spec.description.trim()} (from the project's ${plugin} plugin)`,
    parameters: Type.Object(fields),
    async execute(_id, args, signal) {
      try {
        const value = await spec.execute(args ?? {}, { abortSignal: signal });
        if (value && typeof value === "object" && Array.isArray(value.content)) return value;
        return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value ?? null) }] };
      } catch (e) {
        // A PLUGIN'S THROW IS THE TOOL'S RESULT, not the turn's end. The model
        // can read the message and try something else; an exception out of
        // here would take the whole turn down with it.
        onError?.(plugin, name, e);
        return { content: [{ type: "text", text: `the ${name} tool failed: ${e?.message ?? String(e)}` }] };
      }
    },
  };
}

/**
 * Load every plugin a project ships.
 *
 * `readDir` and `readFile` are the workspace's, so this works over the cell's
 * own tree and over an attached machine without knowing which. `runtimeFor`
 * builds a node runtime for one plugin — one each, so a plugin that scribbles
 * on globals cannot reach its neighbours.
 *
 * Never throws. A project with a broken plugin still has an agent: the failure
 * is reported and the other plugins load.
 */
export async function loadPlugins({ dir, readDir, readFile, runtimeFor, onProgress }) {
  const loaded = [];
  const diagnostics = [];
  let names;
  try { names = await readDir(dir); } catch { return { tools: [], plugins: [], diagnostics: [] }; }
  const files = (names ?? []).filter(isPluginFile).sort().slice(0, PLUGIN_MAX);
  if ((names ?? []).filter(isPluginFile).length > PLUGIN_MAX) {
    diagnostics.push(`only the first ${PLUGIN_MAX} plugins were loaded`);
  }
  const tools = [];
  for (const file of files) {
    const path = `${dir}/${file}`;
    let source;
    try { source = await readFile(path); } catch (e) { diagnostics.push(`${file}: could not be read (${e?.message ?? e})`); continue; }
    const rt = runtimeFor(path);
    // THE PLUGIN'S FILENAME IS WHERE IT ACTUALLY SITS. Naming it `/${path}`
    // made it root-absolute, so `require("./lib/x.js")` resolved to
    // `/.kortix/pi/plugins/lib/x.js` — a path in no workspace — and every
    // multi-file plugin failed with "Cannot find module".
    const root = String(rt.cwd ?? "").replace(/\/+$/, "");
    const r = await rt.load(source, `${root}/${path}`.replace(/\/+/g, "/"));
    if (!r.ok) { diagnostics.push(`${file}: ${r.error}`); continue; }
    const factory = r.exports?.default ?? r.exports;
    if (typeof factory !== "function") { diagnostics.push(`${file}: a plugin must default-export a function`); continue; }
    let returned;
    try {
      returned = await Promise.race([
        factory(rt.pluginContext ?? {}),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`did not finish within ${PLUGIN_LOAD_TIMEOUT_MS} ms`)), PLUGIN_LOAD_TIMEOUT_MS)),
      ]);
    } catch (e) { diagnostics.push(`${file}: ${e?.message ?? e}`); continue; }
    const { tools: valid, rejected } = validateTools(returned, file);
    diagnostics.push(...rejected);
    if (!valid.length) {
      // A PLUGIN THAT LOADS AND CONTRIBUTES NOTHING IS A BUG, and silence is
      // the worst way to report it: the author sees their file in the tree and
      // no tool in the session, with nothing to read. Only say it when
      // validateTools had nothing of its own to say.
      if (!rejected.length) diagnostics.push(`${file}: returned no tools`);
      continue;
    }
    loaded.push({ file, tools: valid.map((t) => t.name) });
    tools.push(...valid);
    onProgress?.(`${file}: ${valid.map((t) => t.name).join(", ")}`);
  }
  return { tools, plugins: loaded, diagnostics };
}

/** What `/plugins` answers, and what the prompt is told. */
export function pluginsSummary({ plugins, diagnostics }) {
  if (!plugins?.length) return "";
  const lines = plugins.map((p) => `- ${p.file}: ${p.tools.join(", ")}`);
  return [`This project ships ${plugins.length} plugin${plugins.length === 1 ? "" : "s"}, whose tools you have:`, ...lines,
    ...(diagnostics?.length ? [`(${diagnostics.length} plugin problem${diagnostics.length === 1 ? "" : "s"} were reported to the project's owner.)`] : [])].join("\n");
}
