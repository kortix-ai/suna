// THE CELL'S OWN FILESYSTEM AND SHELL. In-process, no Docker, no daemon, no
// microVM: the tree lives in the cell's SQLite and the shell is just-bash.
// EXPECTED_PASSES=35
import { DatabaseSync } from "node:sqlite";
import { watchClaims } from "../../tools/crash-reporter.mjs";
import { makeCell, installWorkerGlobals } from "./cell-harness.mjs";
installWorkerGlobals();
let bad = 0;
const check = watchClaims((n, c, d = "") => { if (c) console.log(`  ok    ${n}`); else { console.log(`  FAIL  ${n}${d ? `\n          ${d}` : ""}`); bad++; } });

const { cellFs, cellExecutionEnv, cellShellNote, CELL_COMMANDS, CELL_MISSING, CELL_NET_COMMANDS } = await import("../src/execenv.cell.js");
// A SQL handle shaped like the cell's, over a real SQLite, so persistence is real.
const db = new DatabaseSync(":memory:");
const sql = { exec(q, ...a) { const t = q.trim(); if (/^(CREATE|INSERT|UPDATE|DELETE)/i.test(t)) { const st = db.prepare(t); a.length ? st.run(...a) : st.run(); return { toArray: () => [], [Symbol.iterator]: function* () {} }; } const rows = db.prepare(t).all(...a); return { toArray: () => rows, [Symbol.iterator]: function* () { yield* rows; } }; } };

const cell = cellFs(sql); await cell.ready;
const CELL_CWD_EXPECTED = "/workspace";
const env = cellExecutionEnv(cell);

let r = await env.writeFile("notes/a.txt", "hello\nworld\n");
check("writeFile creates parents and writes", r.ok, JSON.stringify(r));
r = await env.readTextFile("notes/a.txt");
check("readTextFile reads it back", r.ok && r.value === "hello\nworld\n", JSON.stringify(r).slice(0, 80));
r = await env.readTextLines("notes/a.txt", { maxLines: 1 });
check("readTextLines honours maxLines", r.ok && r.value.length === 1 && r.value[0] === "hello", JSON.stringify(r.value));
r = await env.listDir("notes");
check("listDir lists with kind and path", r.ok && r.value[0].name === "a.txt" && r.value[0].kind === "file" && r.value[0].path === "/workspace/notes/a.txt", JSON.stringify(r.value));
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
const rows = db.prepare("SELECT COUNT(*) AS n FROM files WHERE path LIKE '/workspace/notes%'").get();
check("a removal is persisted too — deleted rows do not come back", r.ok && rows.n === 0, JSON.stringify(rows));

// ONLY THE AGENT'S TREE IS PERSISTED. just-bash ships /bin, /usr, /etc and
// friends — 181 paths on an empty cell. Snapshotting those on every write is
// 181 rows of base64 per commit for files nobody wrote, and every commit here
// is a durable write to object storage.
{
  const all = db.prepare("SELECT path FROM files").all().map((r) => r.path);
  check("the durable table holds ONLY /workspace and /tmp — never the shell's own skeleton",
    all.length > 0 && all.every((p) => p === "/workspace" || p.startsWith("/workspace/") || p.startsWith("/tmp/")),
    JSON.stringify(all.filter((p) => !(p === "/workspace" || p.startsWith("/workspace/") || p.startsWith("/tmp/"))).slice(0, 5)));
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
  // Network commands are registered by the fetch, not by the build: curl shows
  // in /usr/bin, wget (a custom command) does not. Named apart, checked apart.
  const real = [...new Set(((await cell.bash.exec("ls /usr/bin", { cwd: "/" })).stdout || "")
    .split(/\s+/).filter(Boolean))].filter((c) => !CELL_NET_COMMANDS.includes(c)).sort();
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
  // THE NETWORK THE NOTE PROMISES. curl over the guarded fetch, wget over the
  // same; an internal address is refused with a reason, and nothing hangs.
  for (const c of CELL_NET_COMMANDS) {
    const r = await cell.bash.exec(`command -v ${c}`, { cwd: "/" });
    check(`${c} is a command the shell has`, r.exitCode === 0 && (r.stdout || "").trim() !== "", JSON.stringify(r));
  }
  {
    const r = await cell.bash.exec("curl -sS -o /tmp/ex.html -w '%{http_code}' https://example.com/ && head -c 15 /tmp/ex.html", { cwd: "/" });
    check("curl fetches a public page, writes -o and prints -w %{http_code}", r.exitCode === 0 && /^200<!doctype html>/i.test(r.stdout.trim()), JSON.stringify(r).slice(0, 200));
    const w = await cell.bash.exec("wget -qO- https://example.com/ | head -c 15", { cwd: "/" });
    check("wget -qO- streams the body to stdout", w.exitCode === 0 && /^<!doctype html>/i.test(w.stdout.trim()), JSON.stringify(w).slice(0, 200));
    const p = await cell.bash.exec("curl -s -X POST -H 'content-type: application/json' -d '{\"a\":1}' https://httpbin.org/post | jq -c .json", { cwd: "/" });
    check("curl POSTs a body with headers (httpbin echoes it)", p.exitCode === 0 && p.stdout.trim() === '{"a":1}', JSON.stringify(p).slice(0, 200));
    for (const [url, why] of [["http://127.0.0.1:8090/", "loopback"], ["http://169.254.169.254/latest/meta-data/", "link-local"], ["http://10.0.0.1/", "10/8"], ["http://localhost/", "localhost"], ["http://2130706433/", "numeric host"]]) {
      const d = await cell.bash.exec(`curl -sS ${url}`, { cwd: "/" });
      check(`curl refuses ${why} (${url}) with a reason and no body`, d.exitCode !== 0 && d.stdout === "" && /Network access denied/.test(d.stderr), JSON.stringify(d).slice(0, 200));
    }
    // just-bash refuses a non-http scheme before the fetch is consulted — the
    // message is its own, the outcome is the same: no body, non-zero exit.
    const fsch = await cell.bash.exec("curl -sS file:///etc/passwd", { cwd: "/" });
    check("curl refuses a file: URL — nothing read, non-zero exit", fsch.exitCode !== 0 && fsch.stdout === "", JSON.stringify(fsch).slice(0, 160));
    const rd = await cell.bash.exec("curl -sL -o /dev/null -w '%{http_code}' http://github.com/", { cwd: "/" });
    check("curl -L follows a redirect hop by hop (http://github.com → https)", rd.exitCode === 0 && rd.stdout.trim() === "200", JSON.stringify(rd).slice(0, 200));
  }
  // THE TREE ANNOUNCES ITS CHANGES: a tool write names its path, a shell
  // command names what it touched, a no-op names nothing.
  {
    const seen = [];
    cell.onChange = (paths) => seen.push(...paths);
    await env.writeFile("announce/a.txt", "1");
    check("a tool write announces the written path", seen.includes(`${CELL_CWD_EXPECTED}/announce/a.txt`), JSON.stringify(seen));
    seen.length = 0;
    await env.exec("echo hi > announce/b.txt && mkdir -p announce/d && rm announce/a.txt", { cwd: CELL_CWD_EXPECTED });
    check("a shell command announces what it created, made and removed", seen.includes(`${CELL_CWD_EXPECTED}/announce/b.txt`) && seen.includes(`${CELL_CWD_EXPECTED}/announce/d`) && seen.includes(`${CELL_CWD_EXPECTED}/announce/a.txt`), JSON.stringify(seen));
    seen.length = 0;
    await env.exec("ls announce", { cwd: CELL_CWD_EXPECTED });
    check("a read-only command announces nothing", seen.length === 0, JSON.stringify(seen));
    cell.onChange = null;
  }
  check("every command the note calls missing really is missing",
    present.length === 0, `these actually exist: ${JSON.stringify(present)}`);
}

console.log(bad ? `\n  ${bad} failure(s)` : "\n  the cell's own filesystem holds");
process.exit(bad ? 1 : 0);
