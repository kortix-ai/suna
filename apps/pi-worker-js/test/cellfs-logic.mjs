// THE CELL'S OWN FILESYSTEM AND SHELL. In-process, no Docker, no daemon, no
// microVM: the tree lives in the cell's SQLite and the shell is just-bash.
// EXPECTED_PASSES=20
import { DatabaseSync } from "node:sqlite";
import { watchClaims } from "../../tools/crash-reporter.mjs";
import { makeCell, installWorkerGlobals } from "./cell-harness.mjs";
installWorkerGlobals();
let bad = 0;
const check = watchClaims((n, c, d = "") => { if (c) console.log(`  ok    ${n}`); else { console.log(`  FAIL  ${n}${d ? `\n          ${d}` : ""}`); bad++; } });

const { cellFs, cellExecutionEnv, cellShellNote, CELL_COMMANDS, CELL_MISSING } = await import("../src/execenv.cell.js");
// A SQL handle shaped like the cell's, over a real SQLite, so persistence is real.
const db = new DatabaseSync(":memory:");
const sql = { exec(q, ...a) { const t = q.trim(); if (/^(CREATE|INSERT|UPDATE|DELETE)/i.test(t)) { const st = db.prepare(t); a.length ? st.run(...a) : st.run(); return { toArray: () => [], [Symbol.iterator]: function* () {} }; } const rows = db.prepare(t).all(...a); return { toArray: () => rows, [Symbol.iterator]: function* () { yield* rows; } }; } };

const cell = cellFs(sql); await cell.ready;
const CELL_CWD_EXPECTED = "/work";
const env = cellExecutionEnv(cell);

let r = await env.writeFile("notes/a.txt", "hello\nworld\n");
check("writeFile creates parents and writes", r.ok, JSON.stringify(r));
r = await env.readTextFile("notes/a.txt");
check("readTextFile reads it back", r.ok && r.value === "hello\nworld\n", JSON.stringify(r).slice(0, 80));
r = await env.readTextLines("notes/a.txt", { maxLines: 1 });
check("readTextLines honours maxLines", r.ok && r.value.length === 1 && r.value[0] === "hello", JSON.stringify(r.value));
r = await env.listDir("notes");
check("listDir lists with kind and path", r.ok && r.value[0].name === "a.txt" && r.value[0].kind === "file" && r.value[0].path === "/work/notes/a.txt", JSON.stringify(r.value));
r = await env.readTextFile("nope.txt");
check("a missing file is a not_found FileError, not a throw", !r.ok && r.error?.code === "not_found", JSON.stringify(r).slice(0, 100));

r = await env.exec("echo hi there | tr a-z A-Z");
check("bash runs a pipeline: echo | tr", r.ok && r.value.stdout.trim() === "HI THERE" && r.value.exitCode === 0, JSON.stringify(r).slice(0, 120));
r = await env.exec("cd notes && grep -c world a.txt && sed -n 1p a.txt && ls");
check("bash sees files the tools wrote: cd, grep, sed, ls", r.ok && r.value.stdout.includes("1") && r.value.stdout.includes("hello") && r.value.stdout.includes("a.txt"), JSON.stringify(r.value).slice(0, 160));
r = await env.exec("mkdir -p src && printf 'x=1\\n' > src/cfg.ini && cat src/cfg.ini && exit 3");
check("bash exit codes are reported, not swallowed", r.ok && r.value.exitCode === 3 && r.value.stdout.includes("x=1"), JSON.stringify(r.value).slice(0, 120));
r = await env.readTextFile("src/cfg.ini");
check("and the tools see files bash wrote", r.ok && r.value === "x=1\n", JSON.stringify(r).slice(0, 80));
let out = ""; r = await env.exec("echo streamed", { onStdout: (s) => { out += s; } });
check("stdout reaches the callback pi renders from", out.includes("streamed"), JSON.stringify(out));
r = await env.exec("sleep 5", { timeout: 1 });
check("a command past its timeout is pi's timeout error, not a hang", !r.ok && r.error?.code === "timeout", JSON.stringify(r).slice(0, 100));

// PERSISTENCE: a new instance over the SAME SQLite is what an eviction is.
const again = cellFs(sql); await again.ready;
const env2 = cellExecutionEnv(again);
r = await env2.readTextFile("src/cfg.ini");
check("THE TREE SURVIVES A REBUILD — it lives in the cell's SQLite, not the isolate", r.ok && r.value === "x=1\n", JSON.stringify(r).slice(0, 80));
check("and so do the directories", again.restored.dirs >= 2 && again.restored.files >= 2, JSON.stringify(again.restored));
r = await env2.remove("notes");
const rows = db.prepare("SELECT COUNT(*) AS n FROM files WHERE path LIKE '/work/notes%'").get();
check("a removal is persisted too — deleted rows do not come back", r.ok && rows.n === 0, JSON.stringify(rows));

// ONLY THE AGENT'S TREE IS PERSISTED. just-bash ships /bin, /usr, /etc and
// friends — 181 paths on an empty cell. Snapshotting those on every write is
// 181 rows of base64 per commit for files nobody wrote, and every commit here
// is a durable write to object storage.
{
  const all = db.prepare("SELECT path FROM files").all().map((r) => r.path);
  check("the durable table holds ONLY /work and /tmp — never the shell's own skeleton",
    all.length > 0 && all.every((p) => p === "/work" || p.startsWith("/work/") || p.startsWith("/tmp/")),
    JSON.stringify(all.filter((p) => !(p === "/work" || p.startsWith("/work/") || p.startsWith("/tmp/"))).slice(0, 5)));
}

// THE MODEL IS TOLD WHAT ITS SHELL IS. Nothing in the prompt used to say the
// bash tool is an interpreter over a virtual filesystem, so the model reached
// for the tools every coding agent has: measured 2026-09-07, git, curl, node,
// npm, pip, python3, docker, apt-get and uname all exit 127, and python3's
// message even names the interpreter's own host ("not available in browser
// environments").
{
  const note = cellShellNote();
  check("the shell note lists the commands that exist",
    note.includes("jq") && note.includes("rg") && note.includes("awk") && note.includes("sed"),
    note.slice(0, 100));
  check("and names the ones that do not, so the model does not reach for them",
    ["git", "curl", "npm", "pip", "python3", "docker"].every((c) => note.includes(c)),
    note.slice(0, 200));
  check("and says the working directory survives to the next turn",
    note.includes(CELL_CWD_EXPECTED) && /persists between turns/.test(note), note.slice(-200));

  // THE LIST CANNOT DRIFT FROM THE BUILD. `/usr/bin` is synthesised by the
  // shell, not present in the filesystem, so the note is a written-down array —
  // which is only safe if something fails when just-bash's real set changes.
  const real = [...new Set(((await cell.bash.exec("ls /usr/bin", { cwd: "/" })).stdout || "")
    .split(/\s+/).filter(Boolean))].sort();
  const missing = real.filter((c) => !CELL_COMMANDS.includes(c));
  const extra = CELL_COMMANDS.filter((c) => !real.includes(c));
  check("CELL_COMMANDS is exactly what `ls /usr/bin` prints — update it when just-bash changes",
    missing.length === 0 && extra.length === 0,
    `absent from the note: ${JSON.stringify(missing)}  claimed but gone: ${JSON.stringify(extra)}`);

  // The warn-off list must be TRUE: naming a command that actually works would
  // teach the model to avoid a tool it has.
  const present = [];
  for (const c of CELL_MISSING) {
    const r = await cell.bash.exec(`command -v ${c}`, { cwd: "/" });
    if (r.exitCode === 0 && (r.stdout || "").trim()) present.push(c);
  }
  check("every command the note calls missing really is missing",
    present.length === 0, `these actually exist: ${JSON.stringify(present)}`);
}

console.log(bad ? `\n  ${bad} failure(s)` : "\n  the cell's own filesystem holds");
process.exit(bad ? 1 : 0);
