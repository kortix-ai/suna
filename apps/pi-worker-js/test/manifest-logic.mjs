// WHERE A PROJECT KEEPS ITS AGENTS AND SKILLS, from the manifest itself.
//
// The pi-js e2e project bumped `kortix_version` to 3 on 2026-09-06 and left
// its files under `.kortix/opencode`. From v3 the schema's default config dir
// is `.kortix/pi`, so the control plane compiled that project's agent from a
// `.md` that does not exist — the compiled config carried a name and no
// prompt, and every session on it silently ran the cell's built-in three
// sentences. The cell made the mirror-image mistake in the other direction:
// it read skills from `.kortix/opencode/skills` whatever the manifest said.
//
// These claims are about agreeing with packages/manifest-schema on one
// question — which directory — from either syntax, and about the two ways the
// cell can get it wrong: not reading it, and caching the answer it got before
// the checkout arrived.
// EXPECTED_PASSES=34
import { DatabaseSync } from "node:sqlite";
import { watchClaims } from "../../tools/crash-reporter.mjs";
import { makeCell, installWorkerGlobals } from "./cell-harness.mjs";
installWorkerGlobals();
let bad = 0;
const check = watchClaims((n, c, d = "") => { if (c) console.log(`  ok    ${n}`); else { console.log(`  FAIL  ${n}${d ? `\n          ${d}` : ""}`); bad++; } });
const { readManifest, configDirOf, defaultConfigDir, workspaceConfigDir, MANIFEST_FILES } = await import("../src/manifest.js");
const { skillDirs, DEFAULT_SKILLS_DIR } = await import("../src/skills.js");
const { CELL_CWD } = await import("../src/execenv.cell.js");
const { AgentCell } = await import("../dist/worker.js");

const dir = (text) => configDirOf(readManifest(text));

// ── the version's own default ──
// packages/manifest-schema/src/constants.ts manifestDefaultConfigDir: the
// boundary is v3, and it is the whole reason this file exists.
check("up to schema v2 the config dir is `.kortix/opencode`",
  defaultConfigDir(1) === ".kortix/opencode" && defaultConfigDir(2) === ".kortix/opencode", defaultConfigDir(2));
check("from schema v3 it is `.kortix/pi`",
  defaultConfigDir(3) === ".kortix/pi" && defaultConfigDir(4) === ".kortix/pi", defaultConfigDir(3));
check("and a manifest with no version at all reads as the older default — never as v3",
  defaultConfigDir(null) === ".kortix/opencode" && defaultConfigDir(undefined) === ".kortix/opencode", defaultConfigDir(null));

// ── YAML, the form the e2e project actually ships ──
{
  const y = "kortix_version: 3\ndefault_agent: kortix\nagents:\n  kortix:\n    connectors: all\n    secrets: all\n";
  const m = readManifest(y);
  check("the e2e project's own manifest reads as v3 with agent `kortix`",
    m.version === 3 && m.defaultAgent === "kortix", JSON.stringify(m));
  check("so its config dir is `.kortix/pi` — which is why its `.kortix/opencode/agents/kortix.md` stopped being compiled",
    dir(y) === ".kortix/pi", dir(y));
  check("a nested block never leaks a key to the document: `agents.kortix.connectors` is not a top-level field",
    m.configDir.pi === null && m.configDir.opencode === null, JSON.stringify(m.configDir));
}
check("`pi.config_dir` in YAML overrides the version's default",
  dir("kortix_version: 3\npi:\n  config_dir: .kortix/opencode\n") === ".kortix/opencode", dir("kortix_version: 3\npi:\n  config_dir: .kortix/opencode\n"));
check("`opencode.config_dir` is honoured when there is no `pi` block",
  dir("kortix_version: 2\nopencode:\n  config_dir: cfg/oc\n") === "cfg/oc", dir("kortix_version: 2\nopencode:\n  config_dir: cfg/oc\n"));
check("and `pi` wins over `opencode` when a manifest names both — the control plane's own order",
  dir("kortix_version: 2\nopencode:\n  config_dir: cfg/oc\npi:\n  config_dir: cfg/pi\n") === "cfg/pi",
  dir("kortix_version: 2\nopencode:\n  config_dir: cfg/oc\npi:\n  config_dir: cfg/pi\n"));
check("a block that CLOSES releases its keys: a config_dir under some later top-level key is not pi's",
  dir("kortix_version: 3\npi:\n  mode: x\nother:\n  config_dir: nope\n") === ".kortix/pi",
  dir("kortix_version: 3\npi:\n  mode: x\nother:\n  config_dir: nope\n"));

// ── TOML, the original syntax, which nests by TABLE and not by indentation ──
{
  const t = 'kortix_version = 2\ndefault_agent = "kortix"\n\n[pi]\nconfig_dir = ".kortix/custom"\n';
  const m = readManifest(t);
  check("a TOML table's keys belong to the table even though nothing is indented",
    m.configDir.pi === ".kortix/custom", JSON.stringify(m.configDir));
  check("and its quoted scalars are unquoted", m.defaultAgent === "kortix" && m.version === 2, JSON.stringify(m));
  check("a top-level TOML key read BEFORE any table is still the document's",
    dir('kortix_version = 3\n[agents.kortix]\nsecrets = "all"\n') === ".kortix/pi",
    dir('kortix_version = 3\n[agents.kortix]\nsecrets = "all"\n'));
  check("a config_dir inside some other table is not pi's",
    dir('kortix_version = 3\n[tools]\nconfig_dir = "nope"\n') === ".kortix/pi", dir('kortix_version = 3\n[tools]\nconfig_dir = "nope"\n'));
}

// ── the small ways a hand-rolled reader goes wrong ──
check("a trailing slash is not part of the directory — `.kortix/pi/` would ask for `.kortix/pi//skills`",
  dir("kortix_version: 2\npi:\n  config_dir: .kortix/pi/\n") === ".kortix/pi", dir("kortix_version: 2\npi:\n  config_dir: .kortix/pi/\n"));
check("a comment is stripped from a value", readManifest("kortix_version: 3 # the pi runtime\n").version === 3, "");
check("but a `#` INSIDE a quoted value is part of it, not a comment",
  dir('kortix_version: 2\npi:\n  config_dir: "a#b"\n') === "a#b", dir('kortix_version: 2\npi:\n  config_dir: "a#b"\n'));
check("a whole-line comment is not a key", readManifest("# config_dir: nope\nkortix_version: 3\n").configDir.pi === null, "");
check("empty, blank and non-string input answer the default rather than throwing",
  dir("") === ".kortix/opencode" && dir("   \n\n") === ".kortix/opencode" && configDirOf(readManifest(null)) === ".kortix/opencode", "");
check("garbage that is not a manifest is read as a manifest with no fields",
  JSON.stringify(readManifest("<<<not a manifest>>>\n{[}")) === JSON.stringify({ version: null, configDir: { pi: null, opencode: null }, defaultAgent: null }),
  JSON.stringify(readManifest("<<<not a manifest>>>\n{[}")));
check("the manifest filenames are the control plane's, in its resolution order",
  JSON.stringify(MANIFEST_FILES) === JSON.stringify(["kortix.yaml", "kortix.yml", "kortix.toml"]), JSON.stringify(MANIFEST_FILES));

// ── reading it out of a workspace ──
{
  const seen = [];
  const files = { "kortix.toml": "kortix_version = 3\n" };
  const env = { readTextFile: async (n) => { seen.push(n); return n in files ? { ok: true, value: files[n] } : { ok: false }; } };
  check("the workspace read falls through the filenames in order and stops at the first present one",
    (await workspaceConfigDir(env)) === ".kortix/pi" && JSON.stringify(seen) === JSON.stringify(MANIFEST_FILES), JSON.stringify(seen));
  files["kortix.yaml"] = "kortix_version: 2\n";
  check("and YAML is preferred over TOML when a repo carries both",
    (await workspaceConfigDir(env)) === ".kortix/opencode", "");
  check("a workspace with NO manifest answers null — not a default, because `declares nothing` is not `declares v2`",
    (await workspaceConfigDir({ readTextFile: async () => ({ ok: false }) })) === null, "");
  check("a read that THROWS is the same as absent, never a turn-ending error",
    (await workspaceConfigDir({ readTextFile: async () => { throw new Error("boom"); } })) === null, "");
  check("an empty manifest file is skipped rather than read as a versionless one",
    (await workspaceConfigDir({ readTextFile: async (n) => (n === "kortix.yaml" ? { ok: true, value: "  \n" } : { ok: false }) })) === null, "");
}

// ── what the skills loader is then told to read ──
check("with no manifest the cell keeps its own two conventions",
  JSON.stringify(skillDirs({}, null)) === JSON.stringify(DEFAULT_SKILLS_DIR.split(",")), JSON.stringify(skillDirs({}, null)));
check("with a manifest the project's own dir replaces the guessed one, and `.pi/skills` stays",
  JSON.stringify(skillDirs({}, ".kortix/pi")) === JSON.stringify([".kortix/pi/skills", ".pi/skills"]), JSON.stringify(skillDirs({}, ".kortix/pi")));
check("an explicit SKILLS_DIR still wins over the manifest — an operator who names the directory means it",
  JSON.stringify(skillDirs({ SKILLS_DIR: "/opt/s" }, ".kortix/pi")) === JSON.stringify(["/opt/s"]), JSON.stringify(skillDirs({ SKILLS_DIR: "/opt/s" }, ".kortix/pi")));
check("and an EMPTY SKILLS_DIR still means NO skills — that is how they are turned off, and the manifest must not undo it",
  JSON.stringify(skillDirs({ SKILLS_DIR: "" }, ".kortix/pi")) === "[]" && JSON.stringify(skillDirs({ SKILLS_DIR: "  " }, ".kortix/pi")) === "[]",
  JSON.stringify(skillDirs({ SKILLS_DIR: "" }, ".kortix/pi")));

// ── in a cell, across the checkout that arrives late ──
{
  const h = makeCell(AgentCell, { KORTIX_SESSION_ID: "m1", TOOLS_BACKEND: "cell" });
  const c = h.cell ?? h;
  await (await h.fetch("/file?path=&c=m1")).json();     // makes the tree, empty
  check("a cell whose workspace has no manifest yet answers null", (await c.configDir("m1")) === null, "");
  await c.cellFs.fs.writeFile(`${CELL_CWD}/kortix.yaml`, "kortix_version: 3\ndefault_agent: kortix\n");
  check("and once the checkout lands it reads the project's own dir — the null was NOT cached",
    (await c.configDir("m1")) === ".kortix/pi", String(await c.configDir("m1")));
  await c.cellFs.fs.writeFile(`${CELL_CWD}/kortix.yaml`, "kortix_version: 2\n");
  check("an answered dir IS cached: the manifest can only change with a commit, and this runs on the prompt path",
    (await c.configDir("m1")) === ".kortix/pi", String(await c.configDir("m1")));
}

// A DAEMON-BACKED SESSION IS NOT A CELL — the same trap projectInstructions
// fell into: reading the manifest must not manufacture a cell filesystem.
{
  const h = makeCell(AgentCell, { SCRIPT: "[]", TOOL_DAEMON_URL: "http://127.0.0.1:9", TOOL_DAEMON_TOKEN: "t" });
  const c = h.cell ?? h;
  await h.fetch("/?c=m2");
  await c.configDir("m2");
  check("looking for the manifest never manufactures a cell filesystem",
    !c.cellFs && (await (await h.fetch("/model?c=m2")).json()).tools.backend === "daemon", String(!!c.cellFs));
}

console.log(bad ? `\n${bad} FAILED` : "\nall claims hold");
process.exit(bad ? 1 : 0);
