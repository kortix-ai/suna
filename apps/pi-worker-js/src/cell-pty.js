// THE TERMINAL TAB, FOR A CELL.
//
// The session panel's Terminal is the daemon's `/kortix/pty`: REST to list,
// create, rename and remove a terminal (packages/sdk core/runtime/pty.ts), and
// one WebSocket per terminal carrying RAW TEXT both ways — xterm sends every
// keystroke, the far end writes bytes back. A cell has no processes and no
// pty, so the tab could only ever say "connecting": measured 2026-09-10, the
// four `/kortix/pty` routes were `unknown route` on a cell.
//
// It does have a shell. just-bash runs a command over the session's own tree
// (execenv.cell.js), which is everything a terminal needs EXCEPT the two
// things a tty does for free: echoing what you type, and line editing. So the
// line editor is here, as a pure state machine — `feed` takes what the browser
// sent and answers what to echo and whether a line is ready — and the worker
// runs the ready line through the same shell the agent uses.
//
// Interactive programs (vim, less, a REPL) are out of reach and always will
// be: there is no process to hold a terminal open. Everything else — ls, cat,
// grep, jq, a pipeline, cd — behaves.

const MAX_LINE = 4096;

/** The pty records the client lists. `pid` is a number the client displays; a cell has none, so it counts. */
export function ptyTable(sql) {
  sql.exec("CREATE TABLE IF NOT EXISTS ptys (id TEXT PRIMARY KEY, title TEXT NOT NULL, cwd TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL, pid INTEGER NOT NULL)");
}

export function ptyList(sql) {
  ptyTable(sql);
  return [...sql.exec("SELECT id, title, cwd, status, pid FROM ptys ORDER BY created_at")].map((r) => ({
    id: String(r.id), title: String(r.title), command: "bash", args: [],
    cwd: String(r.cwd), status: r.status === "exited" ? "exited" : "running", pid: Number(r.pid) || 0,
  }));
}

export function ptyGet(sql, id) {
  ptyTable(sql);
  return ptyList(sql).find((p) => p.id === id) ?? null;
}

export function ptyCreate(sql, input = {}, now = Date.now(), random = Math.random) {
  ptyTable(sql);
  const id = `pty_${now.toString(36)}${Math.floor(random() * 0xffffff).toString(36)}`;
  const cwd = typeof input.cwd === "string" && input.cwd.trim() ? input.cwd.trim() : "/workspace";
  const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : "Terminal";
  const pid = (sql.exec("SELECT COUNT(*) AS n FROM ptys").toArray()[0]?.n ?? 0) + 1;
  sql.exec("INSERT INTO ptys(id, title, cwd, created_at, status, pid) VALUES (?, ?, ?, ?, 'running', ?)", id, title, cwd, now, pid);
  return ptyGet(sql, id);
}

export function ptyUpdate(sql, id, patch = {}) {
  const existing = ptyGet(sql, id);
  if (!existing) return null;
  // `size` is a tty's business and a cell has no tty; accepting it and doing
  // nothing is honest — the client resizes on every layout change.
  if (typeof patch.title === "string" && patch.title.trim()) {
    sql.exec("UPDATE ptys SET title = ? WHERE id = ?", patch.title.trim(), id);
  }
  return ptyGet(sql, id);
}

export function ptyRemove(sql, id) {
  const existing = ptyGet(sql, id);
  ptyTable(sql);
  sql.exec("DELETE FROM ptys WHERE id = ?", id);
  return !!existing;
}

export function ptySetCwd(sql, id, cwd) {
  ptyTable(sql);
  sql.exec("UPDATE ptys SET cwd = ? WHERE id = ?", String(cwd), id);
}

// ── The line editor ──────────────────────────────────────────────────────
/** What the shell offers, in the cell's own terms. */
export const prompt = (cwd) => `\x1b[36m${cwd}\x1b[0m $ `;

export const banner = (cwd) =>
  "\x1b[2mpi cell shell — just-bash over this session's workspace. " +
  "No processes, no network daemons; curl, wget and 76 POSIX commands.\x1b[0m\r\n" + prompt(cwd);

/** A fresh editor for a terminal at `cwd`. */
export function newEditor(cwd = "/workspace") {
  return { cwd, buffer: "", busy: false };
}

/**
 * One chunk from the browser.
 *
 * Answers what to ECHO (a tty does this; a shell over a socket must), and
 * either a `line` to run, an `interrupt` while a command is running, or
 * `close` when the user pressed Ctrl-D on an empty line. Pure, so every key
 * is asserted without a socket.
 */
export function feed(state, chunk) {
  let echo = "";
  let line = null;
  let interrupt = false;
  let close = false;
  const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk ?? new Uint8Array());
  let next = { ...state };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\x03") {                      // Ctrl-C
      echo += "^C\r\n";
      if (next.busy) interrupt = true;
      next.buffer = "";
      if (!next.busy) echo += prompt(next.cwd);
      continue;
    }
    if (ch === "\x04") {                      // Ctrl-D
      if (!next.buffer) { close = true; continue; }
      continue;
    }
    if (ch === "\x0c") {                      // Ctrl-L clears the screen
      echo += "\x1b[2J\x1b[H" + prompt(next.cwd) + next.buffer;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      // A CRLF pair is one Enter, not two.
      if (ch === "\n" && text[i - 1] === "\r") continue;
      echo += "\r\n";
      line = next.buffer;
      next.buffer = "";
      continue;
    }
    if (ch === "\x7f" || ch === "\b") {       // Backspace
      if (next.buffer) { next.buffer = next.buffer.slice(0, -1); echo += "\b \b"; }
      continue;
    }
    if (ch === "\x1b") {                      // An escape sequence — arrows, etc.
      // Swallow the whole CSI/SS3 sequence rather than echoing control bytes
      // into the line. History and cursor movement are not offered yet, and a
      // stray `[A` in the command is worse than an arrow that does nothing.
      let j = i + 1;
      if (text[j] === "[" || text[j] === "O") { j++; while (j < text.length && !/[A-Za-z~]/.test(text[j])) j++; }
      i = j;
      continue;
    }
    if (ch < " ") continue;                   // any other control byte
    if (next.buffer.length >= MAX_LINE) continue;
    next.buffer += ch;
    echo += ch;
  }
  return { state: next, echo, line, interrupt, close };
}

/**
 * `cd` is the one command a shell must remember, and a cell's shell forgets:
 * every exec is its own process tree. Answers the command to run to LEARN the
 * new directory, or null when the line is not a cd.
 */
export function cdTarget(line) {
  const m = /^\s*cd(?:\s+(.*))?\s*$/.exec(line ?? "");
  if (!m) return null;
  const arg = (m[1] ?? "").trim();
  return arg || "~";
}
