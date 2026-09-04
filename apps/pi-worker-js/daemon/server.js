// THE TOOL DAEMON — the "workspace" half of an agent cell.
//
// The cell is a V8 isolate: no filesystem, no processes. So every tool that
// needs either one becomes an HTTP call to this daemon, which owns a directory
// per session and runs commands in it. There is no SSH and no agent protocol —
// the whole contract is three POST routes and a bearer token.
//
// THE ONE RULE THAT MATTERS: every mutating call carries `opId`, and results are
// cached by it. A cell can crash mid-command and be resumed on another node; it
// will retry the tool call with the SAME id, because pi's toolCallId is stable.
// Without the cache that retry re-runs the command — `rm -rf build && ...` twice.
// With it, the retry returns the first result and nothing runs again.
//
// THE LEDGER IS ON DISK. It was in memory, and the header admitted what that
// cost: a daemon restart forgot every op, so a retry spanning the restart
// re-ran the command. A cell is restarted in seconds after a crash; a daemon
// that forgets in the same window is the double execution the whole design
// exists to prevent, reintroduced one layer down.
//
// SQLite in the work root. Completed results are replayed from it across
// restarts. An op that was IN FLIGHT when the daemon died is a different
// case: its promise cannot be persisted, and its outcome is unknown. Such a row
// is answered with an explicit unknown-outcome response, never re-run — the
// same rule the cell applies from its side.
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { appendFile, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { basename, dirname, join, normalize, resolve } from "node:path";

const PORT = Number(process.env.PORT ?? 7070);
const TOKEN = process.env.TOKEN ?? "dev-token";
const ROOT = process.env.WORK_ROOT ?? "/tmp/agent-cell-work";

/** The durable op ledger: opId -> result JSON, plus a status for the in-flight case. */
let ledgerDb = null;
function ledger() {
  if (ledgerDb) return ledgerDb;
  mkdirSync(ROOT, { recursive: true });
  ledgerDb = new DatabaseSync(join(ROOT, ".ledger.sqlite"));
  ledgerDb.exec(`CREATE TABLE IF NOT EXISTS ops (
    id TEXT PRIMARY KEY, status TEXT NOT NULL, result TEXT, started_at INTEGER NOT NULL, ended_at INTEGER)`);
  return ledgerDb;
}

// Anything still 'running' when a daemon STARTS was in flight when the last
// one died. Its outcome is unknown and stays that way; mark it so a retry is
// answered honestly instead of executed again. This runs in createDaemon(),
// not in the lazy opener, because it belongs to a daemon's lifetime — a second
// daemon in the same process (as the tests do) is a second life.
function sweepInterrupted() {
  ledger().prepare("UPDATE ops SET status='unknown', ended_at=? WHERE status='running'").run(Date.now());
}
const seen = {
  get: (id) => { const r = ledger().prepare("SELECT status, result FROM ops WHERE id=?").get(id); return r ? { status: r.status, result: r.result ? JSON.parse(r.result) : null } : null; },
  begin: (id) => ledger().prepare("INSERT OR IGNORE INTO ops(id, status, started_at) VALUES (?, 'running', ?)").run(id, Date.now()),
  finish: (id, result) => ledger().prepare("UPDATE ops SET status='done', result=?, ended_at=? WHERE id=?").run(JSON.stringify(result), Date.now(), id),
  abandon: (id) => ledger().prepare("DELETE FROM ops WHERE id=? AND status='running'").run(id),
};
/**
 * opId -> the promise of a call that is STILL RUNNING.
 *
 * Caching completed results is not enough, and the crash test proved it: a cell
 * killed mid-command is restarted in seconds and retries with the same
 * toolCallId while the FIRST command is still executing. `seen` has nothing
 * yet, so the retry starts a second copy — measured, runs 1 -> 2.
 *
 * That is the exact hazard the op ledger exists to name: "may have run". The
 * ledger lets the cell know; this makes the daemon do something about it, by
 * making a concurrent retry await the original instead of racing it.
 */
const inflight = new Map();
/** opId -> count, so a test can prove a retry did not re-execute. */
const ran = new Map();

// A session id arrives from the cell and becomes a directory name, so it is
// filtered rather than trusted: `../../etc` must not escape the work root.
const workdirFor = (sessionId) => {
  const safe = String(sessionId ?? "default").replace(/[^a-zA-Z0-9_-]/g, "");
  return join(ROOT, safe || "default");
};

// Same reasoning for paths inside a session, and one more step than the obvious
// one. `resolve()` is TEXTUAL: it collapses `..` but knows nothing about
// symlinks, so a link inside the session pointing at /etc passes it and then
// reads /etc. An earlier version of this file admitted that in a comment and
// left it; the test that finally asked found `read escape/hosts` returning the
// host's /etc/hosts.
//
// realpath resolves the link, so the containment check sees where the path
// actually LANDS. For a write the target may not exist yet, so the deepest
// existing ancestor is what gets resolved — a link anywhere along the way is
// still caught.
async function safePath(sessionId, p) {
  const base = await realpath(workdirFor(sessionId)).catch(() => workdirFor(sessionId));
  const wanted = resolve(base, normalize(String(p ?? "")));

  let probe = wanted;
  let real = null;
  // Walk up to the first component that exists, and resolve THAT.
  //
  // TWO BOUNDS, EACH REDUNDANT WITH THE OTHER: the counter stops a pathological
  // path, and `parent === probe` stops at the filesystem root, where dirname
  // becomes a fixed point. Disabling either leaves the other, which is why the
  // auditors report both as unpinned — a claim can only be written for removing
  // BOTH, and that claim would be "the daemon does not hang", asserted by every
  // other claim in the suite already timing out.
  //
  // AUDIT-EQUIVALENT: 64 vs 65 iterations of a loop that breaks on the first existing component; no path reaches either.
  for (let i = 0; i < 64; i++) {
    try { real = await realpath(probe); break; } catch { /* keep walking up */ }
    const parent = dirname(probe);
    // AUDIT-EQUIVALENT: the counter above already terminates the walk, so removing this one changes nothing observable.
    if (parent === probe) break;
    probe = parent;
  }
  const landed = real ? real + wanted.slice(probe.length) : wanted;
  if (landed !== base && !landed.startsWith(base + "/")) {
    throw new Error(`path escapes the session workspace: ${p}`);
  }
  return landed;
}

// CANCELLING A TURN MUST STOP THE COMMAND.
//
// pi's bash tool is handed an abort signal and honours it — but only for its own
// return value. Without the client's disconnect reaching this process, an
// aborted `sleep 5` still slept 5 seconds, still ran to completion, and the
// caller waited the whole time before being told it was cancelled. A user
// stopping a runaway build got no relief and the cell stayed blocked.
//
// `onGone` is the client's connection closing. Killing the PROCESS GROUP, not
// the child: `bash -lc "sleep 5"` may exec a subshell, and killing bash alone
// leaves the grandchild holding the workspace.
/** opId -> a function that kills that op's process group. Only while it runs. */
const cancels = new Map();

function runShell(cwd, command, timeoutSec, onGone) {
  return new Promise((done) => {
    const child = spawn("bash", ["-lc", command], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let out = "", err = "", killed = false, cancelled = false;
    const stop = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} } };
    const timer = setTimeout(() => { killed = true; stop(); }, timeoutSec * 1000);
    if (onGone) onGone(() => { cancelled = true; stop(); });
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({
        // Truncated from the END: the tail of a build log is the part that says
        // what failed, and an untruncated log is a context-window bill.
        stdout: out.slice(-50_000),
        stderr: err.slice(-20_000),
        exitCode: cancelled ? 130 : killed ? 124 : (code ?? -1),
        killed,
        cancelled,
      });
    });
  });
}

const json = (res, code, body) => {
  const b = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(b) });
  res.end(b);
};

const readBody = (req) => new Promise((done, fail) => {
  let raw = "";
  // AUDIT-EQUIVALENT: 8_000_000 is an arbitrary safety cap, not a contract; the claimed property is that a 9 MB body is refused, which a one-byte shift does not change.
  req.on("data", (c) => { raw += c; if (raw.length > 8_000_000) { fail(new Error("body too large")); req.destroy(); } });
  req.on("end", () => { try { done(raw ? JSON.parse(raw) : {}); } catch (e) { fail(e); } });
});

// The filesystem operations pi's ExecutionEnv needs beyond read/write. Returns
// a plain object; the caller shapes it into pi's Result.
async function fsOp(sessionId, body) {
  const op = String(body.op ?? "");
  try {
    switch (op) {
      case "stat": {
        const st = await stat(await safePath(sessionId, body.path));
        // pi's FileInfo is {name, path, kind, size, mtimeMs} with kind a string
        // — not isFile/isDirectory booleans. Its edit tool checks
        // `kind !== "file" && kind !== "symlink"` and refuses otherwise, which
        // is how the wrong shape shows up: "Path is not a file" on a file.
        const kind = st.isDirectory() ? "directory" : st.isSymbolicLink?.() ? "symlink" : st.isFile() ? "file" : "other";
        return { ok: true, info: { name: basename(String(body.path)), path: body.path, kind, size: st.size, mtimeMs: st.mtimeMs } };
      }
      case "list": {
        const dir = await safePath(sessionId, body.path ?? ".");
        const entries = await readdir(dir, { withFileTypes: true });
        return {
          ok: true,
          entries: entries.map((d) => ({
            name: d.name,
            path: `${body.path ?? "."}/${d.name}`.replace(/^\.\//, ""),
            kind: d.isDirectory() ? "directory" : d.isSymbolicLink() ? "symlink" : d.isFile() ? "file" : "other",
            size: 0,
            mtimeMs: 0,
          })),
        };
      }
      case "exists": {
        try { await stat(await safePath(sessionId, body.path)); return { ok: true, exists: true }; }
        catch { return { ok: true, exists: false }; }
      }
      case "append": {
        const full = await safePath(sessionId, body.path);
        await mkdir(dirname(full), { recursive: true });
        await appendFile(full, String(body.content ?? ""), "utf8");
        return { ok: true };
      }
      case "rename": {
        await rename(await safePath(sessionId, body.from), await safePath(sessionId, body.to));
        return { ok: true };
      }
      case "mkdir": {
        await mkdir(await safePath(sessionId, body.path), { recursive: body.recursive !== false });
        return { ok: true };
      }
      case "remove": {
        await rm(await safePath(sessionId, body.path), { recursive: !!body.recursive, force: true });
        return { ok: true };
      }
      case "canonical": {
        // pi calls this for paths that do NOT exist yet — its file-mutation
        // queue keys on the canonical path before creating the file, so a
        // strict realpath makes every first write fail. safePath already walks
        // up to the deepest existing ancestor and resolves symlinks there, so
        // its answer is the canonical one for a path that is about to exist.
        return { ok: true, path: await safePath(sessionId, body.path) };
      }
      default:
        return { ok: false, error: `unknown fs op '${op}'` };
    }
  } catch (e) {
    // The message matters: pi surfaces it to the model, and "ENOENT" tells it
    // something actionable where "failed" does not.
    return { ok: false, error: String(e?.message ?? e), code: e?.code };
  }
}

export function createDaemon() {
  sweepInterrupted();
  return createServer(async (req, res) => {
    // Declared out here so the catch can clear the in-flight registration. An
    // entry left behind makes every future retry of that id wait on a promise
    // nobody will settle — a hang instead of an error, which is worse.
    let currentOp = null;
    let settle = null;
    try {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, { error: "unauthorized" });
      const url = new URL(req.url, "http://d");

      // Test/ops introspection: how many times each op actually executed. This is
      // what makes "the retry did not re-run" an assertion rather than a belief.
      if (url.pathname === "/_ops") {
        return json(res, 200, { ops: [...ran.entries()].map(([id, n]) => ({ id, runs: n })) });
      }
      if (url.pathname === "/health") return json(res, 200, { ok: true });
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });

      const body = await readBody(req);
      const { opId, sessionId } = body;
      if (!opId) return json(res, 400, { error: "opId is required — it is what makes a retry safe" });

      // CANCEL: stop a command that is running right now.
      //
      // Deliberately its own route rather than "the connection dropped", which
      // cannot distinguish a user cancelling from the cell being killed. It
      // sits ABOVE the idempotency gate because it is not an op of its own —
      // it acts on one already in flight, and passing it through the gate would
      // have it register as an op and be replayed to the next caller.
      if (url.pathname === "/cancel") {
        const kill = cancels.get(opId);
        if (kill) { kill(); return json(res, 200, { ok: true, cancelled: opId }); }
        // Already finished, or never started. Not an error: a cancel racing a
        // completion is the normal case, not a fault.
        return json(res, 200, { ok: true, cancelled: null });
      }

      // THE IDEMPOTENCY GATE. Before any work, for every route.
      const prior = seen.get(opId);
      if (prior?.status === "done") return json(res, 200, { ...prior.result, replayed: true });
      if (prior?.status === "unknown") {
        // In flight when a previous daemon died. Do NOT run it again.
        return json(res, 200, {
          unknownOutcome: true,
          error: "this op was in flight when the daemon last stopped; its outcome is unknown and it will not be re-run",
        });
      }
      // SINGLE FLIGHT. A retry that arrives while the original is still running
      // waits for it rather than starting a second execution.
      if (inflight.has(opId)) {
        return json(res, 200, { ...(await inflight.get(opId)), replayed: true, joined: true });
      }

      // REGISTER BEFORE THE FIRST AWAIT. This used to sit after
      // `await mkdir(...)`, and an await is exactly where three concurrent
      // retries slip past each other: all three checked `inflight`, all three
      // found it empty, all three yielded at the mkdir, and only then did they
      // register. Measured: three retries, TWO executions.
      //
      // Nothing may await between the check above and this line.
      // VALIDATE THE ROUTE BEFORE REGISTERING ANYTHING. The 404 below is a
      // `return`, not a throw, so the catch that clears the in-flight entry
      // never ran for it: the promise was never settled, the ledger row stayed
      // 'running', and every later retry of that opId hung on a promise nobody
      // owned — found as a HeadersTimeoutError on the retry after a mistyped
      // route. Then the next daemon marked the row 'unknown' and the id was
      // poisoned for good. Registration is a commitment; commit only to work
      // that will actually be attempted.
      if (!["/exec", "/read", "/write", "/fs"].includes(url.pathname)) {
        return json(res, 404, { error: "no such route" });
      }
      currentOp = opId;
      inflight.set(opId, new Promise((r) => { settle = r; }));
      seen.begin(opId);

      const cwd = workdirFor(sessionId);
      await mkdir(cwd, { recursive: true });
      let result;

      if (url.pathname === "/exec") {
        ran.set(opId, (ran.get(opId) ?? 0) + 1);
        // The kill switch is registered under the op id, NOT hung off this
        // connection closing.
        //
        // A dropped socket cannot tell "the user cancelled" from "the cell was
        // SIGKILLed". Killing on disconnect got cancellation right and broke
        // crash recovery: a cell that dies mid-command is exactly the case
        // where the command should finish, so the retry carrying the same
        // toolCallId is answered from the ledger instead of running again.
        // Cancelling is deliberate, so it says so, on /cancel.
        result = await runShell(cwd, String(body.command ?? ""), Number(body.timeout ?? 120), (kill) => {
          cancels.set(opId, kill);
        });
        cancels.delete(opId);
      } else if (url.pathname === "/read") {
        ran.set(opId, (ran.get(opId) ?? 0) + 1);
        // pi's edit tool reads a file as BYTES before rewriting it, so that an
        // edit cannot silently change the file's encoding. Text-only would have
        // made the whole ExecutionEnv unusable for editing.
        if (body.binary) {
          try {
            const buf = await readFile(await safePath(sessionId, body.path));
            result = { base64: buf.toString("base64"), bytes: buf.length };
          } catch (e) { result = { error: String(e.message ?? e), code: e.code }; }
          seen.finish(opId, result); inflight.delete(opId); settle(result);
          return json(res, 200, result);
        }
        try {
          const text = await readFile(await safePath(sessionId, body.path), "utf8");
          const lines = text.split("\n");
          const offset = Number(body.offset ?? 0);
          const limit = Number(body.limit ?? lines.length);
          result = { content: lines.slice(offset, offset + limit).join("\n"), lines: lines.length };
        } catch (e) { result = { error: String(e.message ?? e) }; }
      } else if (url.pathname === "/write") {
        ran.set(opId, (ran.get(opId) ?? 0) + 1);
        try {
          const full = await safePath(sessionId, body.path);
          await mkdir(dirname(full), { recursive: true });
          await writeFile(full, String(body.content ?? ""), "utf8");
          result = { ok: true, path: body.path };
        } catch (e) { result = { ok: false, error: String(e.message ?? e) }; }
      } else if (url.pathname === "/fs") {
        // ONE ROUTE FOR THE FILESYSTEM, because pi's ExecutionEnv wants about a
        // dozen operations and a dozen routes is a dozen places to forget the
        // path fence. Every op resolves through safePath, so containment is
        // decided once.
        ran.set(opId, (ran.get(opId) ?? 0) + 1);
        result = await fsOp(sessionId, body);
      } else {
        return json(res, 404, { error: "no such route" });
      }

      seen.finish(opId, result);
      inflight.delete(opId);
      settle(result);
      return json(res, 200, result);
    } catch (e) {
      const failure = { error: String(e?.message ?? e) };
      if (currentOp) {
        inflight.delete(currentOp);
        seen.abandon(currentOp);
        // Settle the waiters with the failure rather than leaving them hanging.
        // They get an error, which is a result they can act on.
        if (settle) settle(failure);
      }
      return json(res, 500, failure);
    }
  });
}

// Only listen when run directly, so tests can import and drive it.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  createDaemon().listen(PORT, "0.0.0.0", () => {
    console.log(`[daemon] listening on :${PORT}, work root ${ROOT}`);
  });
}
