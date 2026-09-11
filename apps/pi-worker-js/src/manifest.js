// THE PROJECT'S MANIFEST, AS MUCH OF IT AS A CELL NEEDS.
//
// `kortix.yaml` (or `.yml`, or the original `kortix.toml`) says where a
// project keeps its agents, skills and commands, and the answer MOVED with the
// schema: `manifestDefaultConfigDir` in packages/manifest-schema returns
// `.kortix/opencode` up to v2 and `.kortix/pi` from v3, unless the manifest
// spells the directory out under `pi.config_dir` or `opencode.config_dir`.
//
// The cell hard-coded `.kortix/opencode/skills` and so read a v3 project's
// skills from a directory that project no longer uses. Measured on the pi-js
// e2e project 2026-09-10: its manifest was bumped to `kortix_version: 3` on
// 2026-09-06 while its files stayed under `.kortix/opencode`, and the control
// plane — which does resolve the directory this way — then compiled the
// project's agent with NO PROMPT, because `.kortix/pi/agents/kortix.md` does
// not exist. Every session on that project ran the cell's built-in three
// sentences and nobody could see why.
//
// WHY NOT A YAML LIBRARY. Three scalars are wanted — the version and the two
// `config_dir`s — and the isolate pays for every byte of bundle. So this reads
// exactly those, from either syntax, and reads nothing else: a manifest field
// this does not name is a field the cell does not have an opinion about.
// `parseManifestText` on the control plane remains the authority on the whole
// document; this must only agree with it about where the config dir is.

/** The manifest filenames, in the control plane's own resolution order. */
export const MANIFEST_FILES = ["kortix.yaml", "kortix.yml", "kortix.toml"];

/** The config dir a manifest of this schema version implies when it names none. */
export const defaultConfigDir = (version) => (Number(version) >= 3 ? ".kortix/pi" : ".kortix/opencode");

const unquote = (raw) => {
  const s = String(raw ?? "").trim();
  const quoted = (s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"));
  const body = quoted && s.length >= 2 ? s.slice(1, -1) : s;
  // A trailing slash is not part of the directory: `configDirOf` strips it too,
  // and `.kortix/pi/` joined naively would ask for `.kortix/pi//skills`.
  let end = body.length;
  while (end > 0 && body[end - 1] === "/") end--;
  return body.slice(0, end);
};

// A `#` starts a comment in BOTH syntaxes — but only outside a quoted value,
// or `config_dir: "a#b"` would be cut in half. Tracking the quote state costs
// one pass and removes the whole class.
function strip(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "#") return line.slice(0, i);
  }
  return line;
}

/**
 * `{ version, configDir: { pi, opencode }, defaultAgent }` from a manifest's
 * text — never throws, and a field it cannot find is null.
 *
 * The two syntaxes differ in exactly two ways that matter here: TOML opens a
 * table with `[pi]` and separates a key from its value with `=`, YAML nests by
 * INDENTATION and separates with `:`. So one line loop reads both, tracking
 * which block the current line belongs to.
 */
export function readManifest(text) {
  const out = { version: null, configDir: { pi: null, opencode: null }, defaultAgent: null };
  if (typeof text !== "string" || !text.trim()) return out;
  let table = null;   // the TOML `[pi]` currently open — its keys are NOT indented
  let block = null;   // the YAML key currently open — its keys ARE indented
  for (const rawLine of text.split(/\r?\n/)) {
    const line = strip(rawLine);
    if (!line.trim()) continue;
    const indented = /^\s/.test(line);
    const body = line.trim();
    const header = body.match(/^\[\s*([A-Za-z0-9_.-]+)\s*\]$/);
    if (header) { table = header[1]; block = null; continue; }
    const pair = body.match(/^([A-Za-z0-9_-]+)\s*[:=]\s*(.*)$/);
    if (!pair) { if (!indented) block = null; continue; }
    const [, key, valueRaw] = pair;
    const value = unquote(valueRaw);
    // WHOSE KEY THIS IS. Indented means the open YAML block's; un-indented
    // means the open TOML table's, and with no table open it is the document's.
    // A top-level YAML key with nothing after the colon OPENS a block instead.
    let owner;
    if (indented) owner = block;
    else if (!value) { block = key; continue; }
    else { block = null; owner = table; }
    if (owner === null) {
      if (key === "kortix_version") out.version = Number(value) || null;
      if (key === "default_agent") out.defaultAgent = value || null;
      continue;
    }
    if (key === "config_dir" && (owner === "pi" || owner === "opencode")) out.configDir[owner] ||= value || null;
  }
  return out;
}

/** Where this project keeps its agents and skills. The control plane's rule,
 *  field for field: `pi.config_dir`, else `opencode.config_dir`, else the
 *  version's default. */
export function configDirOf(manifest) {
  return manifest?.configDir?.pi || manifest?.configDir?.opencode || defaultConfigDir(manifest?.version);
}

/**
 * Read the project's config dir out of the workspace, or null when the
 * workspace has no manifest at all.
 *
 * NULL, not the default: "this project declares nothing" and "this project
 * declares v2" are different, and only the first should leave the cell's own
 * `.pi` conventions in charge.
 */
export async function workspaceConfigDir(env) {
  for (const name of MANIFEST_FILES) {
    let read;
    try { read = await env.readTextFile(name); } catch { continue; }
    if (!read?.ok) continue;
    const text = String(read.value ?? "");
    if (!text.trim()) continue;
    return configDirOf(readManifest(text));
  }
  return null;
}
