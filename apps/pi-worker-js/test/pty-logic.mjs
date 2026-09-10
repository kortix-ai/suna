// THE TERMINAL TAB. The session panel's Terminal is the daemon's
// `/kortix/pty`: REST to list/create/rename/remove, and one WebSocket per
// terminal carrying raw text — xterm sends keystrokes, the far end writes
// bytes. On a cell all four routes were `unknown route` (2026-09-10), so the
// tab could only say "connecting". A cell has no pty; it has a shell, and the
// line editing a tty does for free is here.
// EXPECTED_PASSES=38
import { DatabaseSync } from "node:sqlite";
import { watchClaims } from "../../tools/crash-reporter.mjs";
import { makeCell, installWorkerGlobals } from "./cell-harness.mjs";
installWorkerGlobals();
let bad = 0;
const check = watchClaims((n, c, d = "") => { if (c) console.log(`  ok    ${n}`); else { console.log(`  FAIL  ${n}${d ? `\n          ${d}` : ""}`); bad++; } });
const { feed, newEditor, prompt, banner, cdTarget, ptyCreate, ptyList, ptyGet, ptyRemove, ptyUpdate } = await import("../src/cell-pty.js");
const { AgentCell } = await import("../dist/worker.js");

const db = new DatabaseSync(":memory:");
const sql = { exec(q, ...a) { const t = q.trim(); if (/^(CREATE|INSERT|UPDATE|DELETE)/i.test(t)) { const st = db.prepare(t); a.length ? st.run(...a) : st.run(); return { toArray: () => [], [Symbol.iterator]: function* () {} }; } const rows = db.prepare(t).all(...a); return { toArray: () => rows, [Symbol.iterator]: function* () { yield* rows; } }; } };

// ── the line editor ──
const type = (state, text) => feed(state, text);
let ed = newEditor("/workspace");
let r = type(ed, "ls -la");
check("a typed character is echoed — a socket has no tty to do it", r.echo === "ls -la" && r.state.buffer === "ls -la" && r.line === null, JSON.stringify(r.echo));
r = type(r.state, "\r");
check("Enter ends the line, echoes CRLF and hands the line over", r.line === "ls -la" && r.echo === "\r\n" && r.state.buffer === "", JSON.stringify(r));
r = type(newEditor("/workspace"), "abc\r\n");
check("a CRLF pair is ONE Enter, not two", r.line === "abc" && r.echo === "abc\r\n", JSON.stringify(r.echo));
r = type({ ...newEditor("/workspace"), buffer: "abc" }, "\x7f");
check("backspace erases one character on screen and in the buffer", r.state.buffer === "ab" && r.echo === "\b \b", JSON.stringify(r.echo));
r = type(newEditor("/workspace"), "\x7f");
check("backspace on an empty line does nothing at all", r.state.buffer === "" && r.echo === "", JSON.stringify(r.echo));
r = type({ ...newEditor("/x"), buffer: "half a command" }, "\x03");
check("Ctrl-C abandons the line, says so, and offers a fresh prompt", r.state.buffer === "" && r.echo.startsWith("^C\r\n") && r.echo.includes("$ ") && !r.interrupt, JSON.stringify(r.echo));
r = type({ ...newEditor("/x"), busy: true }, "\x03");
check("Ctrl-C while a command runs is an INTERRUPT, and prints no prompt (the command's own will follow)",
  r.interrupt === true && !r.echo.includes("$ "), JSON.stringify(r));
r = type(newEditor("/x"), "\x04");
check("Ctrl-D on an empty line closes the terminal", r.close === true, JSON.stringify(r));
r = type({ ...newEditor("/x"), buffer: "ls" }, "\x04");
check("Ctrl-D with something typed does not", r.close === false, JSON.stringify(r));
r = type(newEditor("/x"), "a\x1b[Ab\x1b[3~c");
check("an arrow key is swallowed whole — a stray `[A` in the command is worse than an arrow that does nothing",
  r.state.buffer === "abc" && r.echo === "abc", JSON.stringify(r));
r = type({ ...newEditor("/x"), buffer: "keep" }, "\x0c");
check("Ctrl-L clears the screen and redraws the prompt with what was typed", r.echo.startsWith("\x1b[2J\x1b[H") && r.echo.endsWith("keep"), JSON.stringify(r.echo));
r = type(newEditor("/x"), "a\x00b\x07c");
check("other control bytes never reach the command line", r.state.buffer === "abc", JSON.stringify(r.state.buffer));
check("the prompt says where you are, and the banner says what this shell is",
  prompt("/workspace/src").includes("/workspace/src") && /just-bash/.test(banner("/workspace")) && banner("/workspace").endsWith("$ "), prompt("/x"));
check("cd is recognised, with or without an argument, and nothing else is",
  cdTarget("cd src") === "src" && cdTarget("  cd  ") === "~" && cdTarget("cd") === "~" && cdTarget("ls") === null && cdTarget("cdx") === null, "");

// ── the records ──
const p1 = ptyCreate(sql, {}, 1000, () => 0.5);
check("a created terminal has the shape the client lists (id, title, command, cwd, status, pid)",
  p1.id.startsWith("pty_") && p1.title === "Terminal" && p1.command === "bash" && p1.cwd === "/workspace" && p1.status === "running" && p1.pid === 1, JSON.stringify(p1));
const p2 = ptyCreate(sql, { title: "build", cwd: "/tmp" }, 1001, () => 0.25);
check("a second one keeps its own title and directory", p2.title === "build" && p2.cwd === "/tmp" && p2.pid === 2 && p2.id !== p1.id, JSON.stringify(p2));
check("the list is both, oldest first", ptyList(sql).map((p) => p.id).join(",") === `${p1.id},${p2.id}`, "");
check("a rename sticks; a resize is accepted and changes nothing (a cell has no tty)",
  ptyUpdate(sql, p2.id, { title: "packaging", size: { rows: 40, cols: 120 } }).title === "packaging", "");
check("renaming a terminal that is gone answers null, not a throw", ptyUpdate(sql, "pty_nope", { title: "x" }) === null, "");
check("remove takes it out of the list and says whether it was there",
  ptyRemove(sql, p2.id) === true && ptyRemove(sql, p2.id) === false && ptyList(sql).length === 1, "");
check("a terminal that is gone is not found", ptyGet(sql, p2.id) === null && ptyGet(sql, p1.id)?.id === p1.id, "");

// ── the routes and a real shell ──
{
  const h = makeCell(AgentCell, { KORTIX_SESSION_ID: "s", TOOLS_BACKEND: "cell" });
  const cell = h.cell ?? h;
  check("GET /kortix/pty starts empty", JSON.stringify(await (await h.fetch("/kortix/pty?c=s")).json()) === "[]", "");
  const created = await (await h.fetch("/kortix/pty?c=s", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "shell" }) })).json();
  check("POST /kortix/pty creates one and answers it", created.id?.startsWith("pty_") && created.title === "shell", JSON.stringify(created));
  check("and GET lists it", (await (await h.fetch("/kortix/pty?c=s")).json()).length === 1, "");
  const patched = await (await h.fetch(`/kortix/pty/${created.id}?c=s`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "renamed" }) })).json();
  check("PATCH renames it", patched.title === "renamed", JSON.stringify(patched));

  // THE PATH THE BROWSER USES. Its socket URL ends `/connect`
  // (packages/sdk core/runtime/pty.ts); matching only the bare id sent the
  // terminal into the session-watcher socket, which answered JSON.
  {
    const upgrade = { headers: { upgrade: "websocket" } };
    const connect = await h.fetch(`/kortix/pty/${created.id}/connect?c=s`, upgrade);
    check("a socket on the client's `/connect` path is a TERMINAL socket, not the session watcher",
      connect.status === 101 && !!connect.webSocket, `status ${connect.status}`);
    const bare = await h.fetch(`/kortix/pty/${created.id}?c=s`, upgrade);
    check("and so is one on the bare id", bare.status === 101, `status ${bare.status}`);
    const missing = await h.fetch("/kortix/pty/pty_nope/connect?c=s", upgrade);
    check("a socket for a terminal that does not exist is closed with the reason the client acts on",
      missing.status === 101, `status ${missing.status}`);
  }

  // The socket, driven the way the browser drives it.
  const sent = [];
  const ws = { send: (d) => sent.push(String(d)), close: () => sent.push("[closed]") };
  const term = { ptyId: created.id, editor: newEditor("/workspace"), abort: null };
  const drive = async (text) => { sent.length = 0; await cell.terminalInput(ws, term, text); return sent.join(""); };
  let out = await drive("echo hello\r");
  check("a command runs in the session's own shell and its output comes back with CRLF line endings",
    out.includes("echo hello\r\n") && out.includes("hello\r\n") && out.endsWith("$ "), JSON.stringify(out));
  out = await drive("mkdir -p sub && echo made > sub/f.txt\r");
  out = await drive("cat sub/f.txt\r");
  check("the workspace is the agent's — a file made in the terminal is there to read",
    out.includes("made\r\n"), JSON.stringify(out));
  out = await drive("cd sub\r");
  check("cd changes the directory and the prompt says so — every exec is its own process tree, so it is learned",
    term.editor.cwd === "/workspace/sub" && out.includes("/workspace/sub") && ptyGet(cell.sql, created.id).cwd === "/workspace/sub", `${term.editor.cwd} ${JSON.stringify(out)}`);
  out = await drive("pwd\r");
  check("and the next command runs THERE", out.includes("/workspace/sub\r\n"), JSON.stringify(out));
  out = await drive("nosuchcommand\r");
  check("a command that does not exist reports itself and the prompt returns",
    /not found/i.test(out) && out.endsWith("$ "), JSON.stringify(out));
  out = await drive("\r");
  check("an empty line moves to the next row and reprints the prompt", out === `\r\n${prompt(term.editor.cwd)}`, JSON.stringify(out));
  out = await drive("exit\r");
  check("exit closes the terminal", out.includes("[closed]"), JSON.stringify(out));

  // AFTER AN EVICTION the map is gone and the tag is all there is.
  {
    const socket = { send: () => {}, close: () => {} };
    cell.terminals?.clear();
    cell.state.getTags = (w) => (w === socket ? [`pty:${created.id}`, "s"] : []);
    const adopted = cell.adoptTerminal(socket);
    check("a socket whose isolate was rebuilt is adopted by its tag, at the directory the terminal was left in",
      adopted?.ptyId === created.id && adopted.editor.cwd === "/workspace/sub", JSON.stringify(adopted?.editor));
    cell.state.getTags = () => ["pty:pty_gone"];
    check("a tag naming a terminal that no longer exists adopts nothing", cell.adoptTerminal({}) === null, "");
    cell.state.getTags = () => [];
  }

  const removed = await h.fetch(`/kortix/pty/${created.id}?c=s`, { method: "DELETE" });
  check("DELETE removes it, and a second DELETE is a 404 the client reads as 'replace'",
    removed.status === 200 && (await h.fetch(`/kortix/pty/${created.id}?c=s`, { method: "DELETE" })).status === 404, "");
}

console.log(bad ? `\n${bad} FAILED` : "\nall claims hold");
process.exit(bad ? 1 : 0);
