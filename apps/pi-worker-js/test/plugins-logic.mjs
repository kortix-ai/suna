// A PROJECT'S OWN TOOLS.
//
// pi ships no plugin system — its package contains no such word, and its only
// extension points are in-process hooks a caller must already hold. OpenCode
// has one, and the pi starter deletes that directory on purpose because a pi
// project runs no OpenCode to read it. So a pi project could not ship a tool
// at all.
//
// It can now, because the cell can execute JavaScript. These claims are about
// the two things that decide whether that is safe to turn on: what counts as a
// tool (a project's bug must be reported, not handed to the model), and what a
// broken plugin costs (nothing — the others load and the agent still runs).
// EXPECTED_PASSES=36
import { watchClaims } from "../../tools/crash-reporter.mjs";
let bad = 0;
const check = watchClaims((n, c, d = "") => { if (c) console.log(`  ok    ${n}`); else { console.log(`  FAIL  ${n}${d ? `\n          ${d}` : ""}`); bad++; } });
const { loadPlugins, pluginsDirFor, isPluginFile, validateTools, toPiTool, pluginsSummary, PLUGIN_MAX, PLUGIN_TOOLS_MAX } = await import("../src/plugins.js");
const { createNodeRuntime, seedRuntime } = await import("../src/nodejs.js");

const enc = new TextEncoder();
// WHAT THE CELL SEEDS EACH PLUGIN RUNTIME WITH: the checkout, so a plugin of
// more than one file — a lib beside it, a package in node_modules — resolves.
const workspace = (tree = {}) => ({
  dirs: [...new Set(Object.keys(tree).map((f) => `/workspace/${f}`.replace(/\/[^/]*$/, "")))],
  files: Object.entries(tree).map(([f, src]) => [`/workspace/${f}`, enc.encode(src)]),
});
const runtimeFor = (ctx = {}, tree) => () => {
  const net = async () => { throw new Error("no network in this claim"); };
  const rt = createNodeRuntime({ fs: null, cwd: "/workspace", fetch: net });
  if (tree) seedRuntime(rt, workspace(tree));
  rt.pluginContext = { project: "p1", session: "s1", cwd: "/workspace", fetch: net, log: () => {}, ...ctx };
  return rt;
};
const load = (files, ctx, tree) => loadPlugins({
  dir: ".kortix/pi/plugins",
  readDir: async () => Object.keys(files),
  readFile: async (p) => { const name = p.split("/").pop(); if (!(name in files)) throw new Error("unreadable"); return files[name]; },
  runtimeFor: runtimeFor(ctx, tree),
});
const textOf = (r) => r.content.map((c) => c.text).join("");

// ── where they live ──
check("plugins live under the config dir the MANIFEST names, so a v3 project and a v2 project each find their own",
  pluginsDirFor(".kortix/pi") === ".kortix/pi/plugins" && pluginsDirFor(".kortix/opencode") === ".kortix/opencode/plugins"
    && pluginsDirFor(".kortix/pi/") === ".kortix/pi/plugins" && pluginsDirFor(null) === ".kortix/pi/plugins", pluginsDirFor(null));
check("a plugin file is JavaScript or TypeScript, and a dotfile, a test or a declaration is not one",
  isPluginFile("a.js") && isPluginFile("b.mjs") && isPluginFile("c.cjs")
    && isPluginFile("d.ts") && isPluginFile("e.mts")
    && !isPluginFile(".hidden.js") && !isPluginFile("a.test.js") && !isPluginFile("a.spec.ts")
    && !isPluginFile("readme.md") && !isPluginFile("types.d.ts"), "");

// ── what counts as a tool ──
{
  const ok = validateTools({ tools: { good: { description: "d", execute() {} } } }, "p.js");
  check("a tool needs a name, a description and an execute — all three", ok.tools.length === 1 && ok.rejected.length === 0, JSON.stringify(ok.rejected));
  const bad1 = validateTools({ tools: { noExec: { description: "d" } } }, "p.js");
  check("no execute is rejected BY NAME, so the project's owner can see which one", bad1.tools.length === 0 && /p\.js\.noExec: has no execute/.test(bad1.rejected[0]), JSON.stringify(bad1.rejected));
  const bad2 = validateTools({ tools: { noDesc: { execute() {} } } }, "p.js");
  check("no description is rejected too — a tool the model cannot know when to use is worse than no tool",
    bad2.tools.length === 0 && /has no description/.test(bad2.rejected[0]), JSON.stringify(bad2.rejected));
  const bad3 = validateTools({ tools: { "bad name!": { description: "d", execute() {} } } }, "p.js");
  check("a name that is not a short identifier is rejected — it becomes a tool name the model must type",
    bad3.tools.length === 0 && /short identifier/.test(bad3.rejected[0]), JSON.stringify(bad3.rejected));
  check("a plugin that returns nothing, or something that is not an object, is reported rather than ignored",
    validateTools(null, "p.js").rejected.length === 1 && validateTools("nope", "p.js").rejected.length === 1
      && validateTools({}, "p.js").tools.length === 0, "");
  check("a bare map of tools works as well as `{ tools }` — the shape a plugin author reaches for first",
    validateTools({ direct: { description: "d", execute() {} } }, "p.js").tools.length === 1, "");
  const many = Object.fromEntries(Array.from({ length: PLUGIN_TOOLS_MAX + 5 }, (_, i) => [`t${i}`, { description: "d", execute() {} }]));
  const capped = validateTools({ tools: many }, "p.js");
  check("and a plugin cannot flood the model with tools — the cap is enforced and said out loud",
    capped.tools.length === PLUGIN_TOOLS_MAX && capped.rejected.some((r) => /more than/.test(r)), `${capped.tools.length} tools`);
}

// ── the shape pi takes ──
{
  const t = toPiTool({ name: "greet", plugin: "hello.js", spec: {
    description: "Greet someone.",
    parameters: { type: "object", properties: { name: { type: "string", description: "who" }, loud: { type: "boolean" }, n: { type: "number" } }, required: ["name"] },
    async execute({ name, loud, n }) { return `hi ${name} ${loud} ${n}`; },
  } });
  check("a plugin's tool carries its own description AND says which plugin it came from",
    t.name === "greet" && /Greet someone\./.test(t.description) && /from the project's hello\.js plugin/.test(t.description), t.description);
  check("its JSON-Schema parameters become a typebox object, with required and optional kept apart",
    t.parameters.type === "object" && "name" in t.parameters.properties && Array.isArray(t.parameters.required) && t.parameters.required.includes("name") && !t.parameters.required.includes("loud"),
    JSON.stringify(t.parameters.required));
  check("string, boolean and number each map to their own type rather than all becoming strings",
    t.parameters.properties.name.type === "string" && t.parameters.properties.n.type === "number", JSON.stringify(Object.entries(t.parameters.properties).map(([k, v]) => `${k}:${v.type}`)));
  check("a tool with no declared parameters still gets a schema that accepts a call",
    toPiTool({ name: "x", plugin: "p.js", spec: { description: "d", execute: async () => "v" } }).parameters.type === "object", "");
  check("a string result becomes the tool's text", textOf(await t.execute("1", { name: "you", loud: true, n: 2 })) === "hi you true 2", "");
  const obj = toPiTool({ name: "o", plugin: "p.js", spec: { description: "d", execute: async () => ({ a: 1 }) } });
  check("an object result is serialised rather than printed as [object Object]", textOf(await obj.execute("1", {})) === '{"a":1}', textOf(await obj.execute("1", {})));
  const passthrough = toPiTool({ name: "p", plugin: "p.js", spec: { description: "d", execute: async () => ({ content: [{ type: "text", text: "own shape" }] }) } });
  check("and a plugin that already speaks the tool-result shape is passed through untouched", textOf(await passthrough.execute("1", {})) === "own shape", "");
  let seen = null;
  const thrower = toPiTool({ name: "boom", plugin: "p.js", spec: { description: "d", execute: async () => { throw new Error("inner"); } } }, { onError: (pl, n, e) => { seen = `${pl}.${n}:${e.message}`; } });
  const res = await thrower.execute("1", {});
  check("A PLUGIN'S THROW IS THE TOOL'S RESULT, NOT THE TURN'S END — the model reads it and can try something else",
    /the boom tool failed: inner/.test(textOf(res)) && seen === "p.js.boom:inner", `${textOf(res)} | ${seen}`);
}

// ── loading, over a fake workspace ──
{
  const r = await load({ "a.js": 'export default async () => ({ tools: { one: { description: "d", async execute() { return "1"; } } } });' });
  check("a plugin that default-exports a function is loaded and its tools collected",
    r.tools.length === 1 && r.tools[0].name === "one" && r.plugins[0].file === "a.js" && r.diagnostics.length === 0, JSON.stringify(r.plugins));
  const cjs = await load({ "b.js": 'module.exports = async () => ({ tools: { two: { description: "d", async execute() { return "2"; } } } });' });
  check("CommonJS works too — `module.exports = fn` is what half of JavaScript still writes", cjs.tools.length === 1 && cjs.tools[0].name === "two", JSON.stringify(cjs.diagnostics));
  const ctx = await load({ "c.js": 'export default async ({ project, session, cwd }) => ({ tools: { where: { description: "d", async execute() { return `${project}/${session}/${cwd}`; } } } });' });
  check("the plugin is handed what a CELL has — the project, the session and the workspace, not an OpenCode client",
    textOf(await toPiTool(ctx.tools[0]).execute("1", {})) === "p1/s1//workspace", "");
}
{
  const r = await load({
    "good.js": 'export default async () => ({ tools: { fine: { description: "d", async execute() { return "ok"; } } } });',
    "throws.js": 'throw new Error("broken at load");',
    "notafunction.js": 'export default { tools: {} };',
    "empty.js": 'export default async () => ({});',
  });
  check("ONE BROKEN PLUGIN DOES NOT COST THE OTHERS — the good one loads and the agent still runs",
    r.tools.length === 1 && r.tools[0].name === "fine", JSON.stringify(r.plugins));
  check("and each failure is reported by file and reason",
    r.diagnostics.some((d) => /throws\.js: Error: broken at load/.test(d))
      && r.diagnostics.some((d) => /notafunction\.js: a plugin must default-export a function/.test(d))
      && r.diagnostics.some((d) => /empty\.js: returned no tools/.test(d)),
    JSON.stringify(r.diagnostics));
}
{
  // A TYPESCRIPT PLUGIN LOADS. It used to be named and skipped — "ship .js" —
  // which is the wrong answer for a project whose repo is TypeScript. The
  // types come off (typescript.js) and what is left runs.
  const r = await load({ "typed.ts": 'export default async ({ cwd }: { cwd?: string }) => ({ tools: { t: { description: "d", parameters: {}, async execute(): Promise<string> { return "ran"; } } } });' });
  check("a TYPESCRIPT plugin LOADS and its tool runs — a project whose repo is .ts can ship a tool",
    r.tools.length === 1 && r.tools[0].name === "t" && r.diagnostics.length === 0, JSON.stringify(r.diagnostics));
  check("and a TypeScript construct that needs a compiler is refused by name rather than mangled",
    (await load({ "e.ts": "enum E { A }\nexport default async () => ({});" })).diagnostics.some((d) => /e\.ts: .*enum .*needs a compiler/.test(d)),
    JSON.stringify((await load({ "e.ts": "enum E { A }\nexport default async () => ({});" })).diagnostics));
}
{
  const files = Object.fromEntries(Array.from({ length: PLUGIN_MAX + 3 }, (_, i) => [`p${String(i).padStart(2, "0")}.js`, 'export default async () => ({ tools: { t: { description: "d", async execute() {} } } });']));
  const r = await load(files);
  check("a project cannot load unbounded plugins; the cap holds and says so", r.plugins.length === PLUGIN_MAX && r.diagnostics.some((d) => /only the first/.test(d)), `${r.plugins.length} loaded`);
}
{
  const r = await loadPlugins({ dir: ".kortix/pi/plugins", readDir: async () => { throw new Error("ENOENT"); }, readFile: async () => "", runtimeFor: runtimeFor() });
  check("a project with NO plugins directory is not an error — most projects have none", r.tools.length === 0 && r.plugins.length === 0 && r.diagnostics.length === 0, JSON.stringify(r));
}
{
  const r = await load({ "slow.js": "export default async () => new Promise(() => {});" });
  check("a plugin that never finishes loading is given up on, not waited on forever", r.tools.length === 0 && r.diagnostics.some((d) => /did not finish within/.test(d)), JSON.stringify(r.diagnostics));
}
{
  const r = await load({ "uses.js": 'const p = require("path"); export default async () => ({ tools: { j: { description: "d", async execute() { return p.join("a","b"); } } } });' });
  check("a plugin may require the runtime's own modules — it is real JavaScript, not a sandboxed expression",
    r.tools.length === 1 && textOf(await toPiTool(r.tools[0]).execute("1", {})) === "a/b", JSON.stringify(r.diagnostics));
}
{
  // Each plugin gets its own runtime, so one cannot reach another's globals.
  const r = await load({
    "first.js": 'globalThis.__leak = "from first"; export default async () => ({ tools: { a: { description: "d", async execute() { return "a"; } } } });',
    "second.js": 'export default async () => ({ tools: { b: { description: "d", async execute() { return String(globalThis.__leak); } } } });',
  });
  const second = r.tools.find((t) => t.name === "b");
  check("one plugin's globals are not another's — each is loaded in its own runtime",
    textOf(await toPiTool(second).execute("1", {})) === "undefined", textOf(await toPiTool(second).execute("1", {})));
}

// ── A PLUGIN IS NOT ONE FILE ──
//
// The loader used to build each runtime with `fs: null`, so `require` could
// resolve nothing and a plugin could only ever be a single self-contained
// file — while the `node` command beside it preloaded the whole checkout. A
// plugin with a lib next to it, or one that uses a package the project already
// has, is the normal case, not the exotic one.
{
  const tree = {
    ".kortix/pi/plugins/lib/rot.js": "module.exports.rot13 = (s) => s.replace(/[a-z]/gi, (c) => String.fromCharCode((c <= 'Z' ? 90 : 122) >= (c = c.charCodeAt(0) + 13) ? c : c - 26));",
    "node_modules/tiny-case/package.json": '{"name":"tiny-case","version":"1.0.0","main":"index.js"}',
    "node_modules/tiny-case/index.js": "exports.shout = (s) => String(s).toUpperCase();",
  };
  const r = await load({
    "multi.js": `const { rot13 } = require("./lib/rot.js");
const { shout } = require("tiny-case");
export default async () => ({ tools: { both: { description: "d", parameters: {}, async execute() { return shout(rot13("hello")); } } } });`,
  }, undefined, tree);
  check("a plugin can require a FILE BESIDE IT — a plugin of more than one file is the normal case",
    r.tools.length === 1, JSON.stringify(r.diagnostics));
  check("and a PACKAGE the project already has, resolved the way node resolves it",
    r.tools.length === 1 && (await toPiTool(r.tools[0]).execute("id", {}, null)).content[0].text === "URYYB",
    JSON.stringify(r.diagnostics));
}
{
  const tree = { ".kortix/pi/plugins/lib/dbl.ts": "export const twice = (n: number): number => n * 2;" };
  const r = await load({
    "typed.ts": `import { twice } from "./lib/dbl.js";
export default async (): Promise<any> => ({ tools: { t: { description: "d", parameters: {}, async execute(): Promise<string> { return String(twice(21)); } } } });`,
  }, undefined, tree);
  check("a TypeScript plugin's own TypeScript imports resolve — `./lib/dbl.js` is dbl.ts, which is what TypeScript means",
    r.tools.length === 1 && (await toPiTool(r.tools[0]).execute("id", {}, null)).content[0].text === "42",
    JSON.stringify(r.diagnostics));
}
{
  // THE CONTRACT SAYS `fetch`, so the contract has to hand one over: a plugin
  // that calls an API is the first thing anyone writes, and it was documented
  // and then not passed.
  let saw = "";
  const r = await load({
    "ctx.js": 'export default async (ctx) => { ctx.log(Object.keys(ctx).sort().join(",")); return { tools: { t: { description: "d", parameters: {}, async execute() { return "x"; } } } }; };',
  }, { log: (m) => { saw = String(m); } });
  check("the context a plugin is handed carries project, session, cwd, fetch and log — all five the contract names",
    r.tools.length === 1 && ["project", "session", "cwd", "fetch", "log"].every((k) => saw.split(",").includes(k)), saw);
}

// ── what the model is told ──
check("the prompt names the project's plugins and their tools, so the model knows they are its own",
  /ships 1 plugin/.test(pluginsSummary({ plugins: [{ file: "a.js", tools: ["one", "two"] }], diagnostics: [] }))
    && /a\.js: one, two/.test(pluginsSummary({ plugins: [{ file: "a.js", tools: ["one", "two"] }], diagnostics: [] })), "");
check("a project with no plugins adds NOTHING to the prompt — the common case costs no context",
  pluginsSummary({ plugins: [], diagnostics: [] }) === "" && pluginsSummary({}) === "", "");
check("and the count of problems is mentioned without spending the prompt on each one",
  /1 plugin problem/.test(pluginsSummary({ plugins: [{ file: "a.js", tools: ["t"] }], diagnostics: ["a: bad"] })), pluginsSummary({ plugins: [{ file: "a.js", tools: ["t"] }], diagnostics: ["a: bad"] }));

console.log(bad ? `\n${bad} FAILED` : "\nall claims hold");
process.exit(bad ? 1 : 0);
