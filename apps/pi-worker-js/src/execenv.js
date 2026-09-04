// pi's ExecutionEnv, implemented over the remote workspace.
//
// THIS IS THE THING WORTH TAKING FROM PI, and it was hiding in plain sight.
// pi's built-in tools do not touch node:fs directly — they take an
// `ExecutionToolContext { env: ExecutionEnv }`, and `ExecutionEnv` is just
// `FileSystem & Shell`. So the tools are already abstracted over "somewhere that
// has files and a shell", which is exactly what a cell does not have and what
// the workspace does.
//
// Implement this one interface and pi's REAL tools work — most importantly
// `createEditTool`, which takes `{path, edits: [{oldText, newText}]}` and returns
// a unified diff. Our hand-written `write` tool makes a model reproduce an entire
// file to change one line, and on a 500-line file that is the difference between
// a few hundred output tokens and several thousand, every edit. After compaction
// this is the largest cost lever in the design.
//
// It also stops three tools being maintained here that pi maintains better:
// read with line windows, write with parent creation, bash with streaming.
//
// Every method returns pi's Result — {ok: true, value} or {ok: false, error} —
// and never throws, because the tools branch on it.
import { FileError, ok } from "@earendil-works/pi-agent-core";
import { ExecutionError, err } from "@earendil-works/pi-agent-core";

// pi's FileError is a CLASS with a snake_case `code`, not a plain object with a
// `kind`. Returning the wrong shape does not fail loudly — the tools read
// `error.code`, find undefined, and report something unhelpful — so it is worth
// constructing the real thing.
const CODES = { ENOENT: "not_found", EACCES: "permission_denied", EPERM: "permission_denied",
                ENOTDIR: "not_directory", EISDIR: "is_directory", EINVAL: "invalid" };
const fail = (message, path, code = "unknown") => err(new FileError(code, String(message), path));
const codeFor = (r) => CODES[r?.code] ?? (/no such file|ENOENT/i.test(String(r?.error)) ? "not_found" : "unknown");

/** Normalise a path the way the workspace expects: relative, no leading slash. */
function rel(p, cwd) {
  const s = String(p ?? "");
  // AUDIT-EQUIVALENT: a relative path reaches the same answer through the line
  // below — it does not start with cwd, so it falls to the leading-slash strip,
  // which finds no leading slash. Kept because "already relative, nothing to
  // do" is the case a reader looks for first.
  if (!s.startsWith("/")) return s;
  // An absolute path inside the workspace is addressed relative to it; anything
  // else is caught by the daemon's own containment check, not guessed at here.
  return s.startsWith(cwd) ? s.slice(cwd.length).replace(/^\/+/, "") : s.replace(/^\/+/, "");
}

export function remoteExecutionEnv({ base, token, sessionId, cwd = "/work", opId, onOp }) {
  // EVERY CALL CARRIES AN OP ID, AND THE PREFIX MUST BE THE TOOL CALL.
  //
  // The daemon caches by op id, so a retry of a FILESYSTEM operation is as safe
  // as a retry of a command — and pi's tools retry. That safety inverts into
  // corruption if two different calls can produce the same id.
  //
  // They could. `opId` used to be optional and the prefix fell back to the
  // SESSION id, while `seq` restarts at 0 for every env — and the worker builds
  // a fresh env per turn. So the first command of turn 2 was "<session>-exec-0",
  // exactly like the first command of turn 1, and the daemon answered it from
  // the ledger: `echo BETA` returned `ALPHA`. Not a double execution. A
  // fabricated result, with no way for the model to doubt it.
  //
  // The prefix is now required and is the tool call id, which is unique per
  // call and identical across that call's retries — which is the whole property
  // the ledger needs.
  if (!opId) throw new Error("remoteExecutionEnv needs an opId prefix (the tool call id); a session-wide prefix collides across turns");
  let seq = 0;
  const nextOp = (kind) => `${opId}-${kind}-${seq++}`;

  /** Raised when the daemon says an op's outcome is unknown. Never a silent empty result. */
  const unknown = (message) => Object.assign(new Error(message), { unknownOutcome: true });

  async function call(path, payload, signal) {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId, ...payload }),
      // Dropping the connection is how the daemon learns to kill the command.
      // pi names it `abortSignal` in ExecOptions, not `signal` — reading it as
      // `signal` silently ignored every cancellation.
      signal,
    });
    if (!res.ok) throw new Error(`${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    // Tell the caller how this answer was obtained, so the transcript can say
    // "served from the ledger" rather than leaving a replay and a re-execution
    // indistinguishable after the fact.
    if (onOp) { try { onOp({ opId: payload.opId, replayed: !!j.replayed, joined: !!j.joined, unknownOutcome: !!j.unknownOutcome }); } catch {} }
    // An op that was in flight when a daemon died comes back 200 with no
    // result. Returned as-is it reads as a command that printed nothing and
    // succeeded. It is the one case the model MUST be told about.
    if (j.unknownOutcome) throw unknown(j.error ?? "the outcome of this operation is unknown; it was not re-run");
    return j;
  }

  const fs = async (op, payload) => {
    try {
      const r = await call("/fs", { opId: nextOp(op), op, ...payload });
      return r.ok ? r : { ok: false, error: r.error ?? `fs ${op} failed`, code: r.code };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  };

  return {
    cwd,

    // THIS BACKEND KEEPS ITS OWN OP LEDGER.
    //
    // It is what lets the cell re-dispatch a call it recorded as 'running': the
    // daemon knows whether that op actually ran and answers from its own
    // record. A backend without this must never be re-dispatched, because
    // "may have run" is the most that can be known there.
    idempotent: true,

    async absolutePath(path) {
      const p = rel(path, cwd);
      return ok(p.startsWith("/") ? p : `${cwd}/${p}`.replace(/\/+/g, "/"));
    },

    async joinPath(parts) {
      return ok(parts.filter(Boolean).join("/").replace(/\/+/g, "/"));
    },

    async readTextFile(path) {
      try {
        const r = await call("/read", { opId: nextOp("read"), path: rel(path, cwd) });
        if (r.error) return fail(r.error, path, codeFor(r));
        return ok(r.content ?? "");
      } catch (e) { return fail(String(e?.message ?? e), path); }
    },

    async readTextLines(path, options = {}) {
      try {
        const r = await call("/read", { opId: nextOp("readlines"), path: rel(path, cwd), offset: 0, limit: options.maxLines });
        if (r.error) return fail(r.error, path, codeFor(r));
        return ok(String(r.content ?? "").split("\n"));
      } catch (e) { return fail(String(e?.message ?? e), path); }
    },

    async readBinaryFile(path) {
      // Not optional: pi's edit tool reads bytes before rewriting, so that an
      // edit cannot change a file's encoding as a side effect. base64 over the
      // same route keeps the protocol JSON.
      try {
        const r = await call("/read", { opId: nextOp("readbin"), path: rel(path, cwd), binary: true });
        if (r.error) return fail(r.error, path, codeFor(r));
        return ok(Uint8Array.from(atob(r.base64 ?? ""), (c) => c.charCodeAt(0)));
      } catch (e) { return fail(String(e?.message ?? e), path); }
    },

    async writeFile(path, content) {
      try {
        const r = await call("/write", { opId: nextOp("write"), path: rel(path, cwd), content: String(content) });
        return r.ok ? ok(undefined) : fail(r.error ?? "write failed", path);
      } catch (e) { return fail(String(e?.message ?? e), path); }
    },

    async appendFile(path, content) {
      const r = await fs("append", { path: rel(path, cwd), content: String(content) });
      return r.ok ? ok(undefined) : fail(r.error, path);
    },

    async renameFile(from, to) {
      const r = await fs("rename", { from: rel(from, cwd), to: rel(to, cwd) });
      return r.ok ? ok(undefined) : fail(r.error, from);
    },

    async fileInfo(path) {
      const r = await fs("stat", { path: rel(path, cwd) });
      if (!r.ok) return fail(r.error, path, codeFor(r));
      // pi wants the ABSOLUTE addressed path back, and its `kind` is a string.
      return ok({ ...r.info, path: `${cwd}/${rel(path, cwd)}`.replace(/\/+/g, "/") });
    },

    async listDir(path) {
      const r = await fs("list", { path: rel(path, cwd) });
      if (!r.ok) return fail(r.error, path, codeFor(r));
      return ok(r.entries);
    },

    async canonicalPath(path) {
      const r = await fs("canonical", { path: rel(path, cwd) });
      return r.ok ? ok(r.path) : fail(r.error, path);
    },

    async exists(path) {
      const r = await fs("exists", { path: rel(path, cwd) });
      return r.ok ? ok(!!r.exists) : fail(r.error, path);
    },

    async createDir(path, options = {}) {
      const r = await fs("mkdir", { path: rel(path, cwd), recursive: options.recursive !== false });
      return r.ok ? ok(undefined) : fail(r.error, path);
    },

    async remove(path, options = {}) {
      const r = await fs("remove", { path: rel(path, cwd), recursive: !!options.recursive });
      return r.ok ? ok(undefined) : fail(r.error, path);
    },

    async createTempDir(prefix = "tmp") {
      const p = `.tmp/${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const r = await fs("mkdir", { path: p, recursive: true });
      return r.ok ? ok(`${cwd}/${p}`) : fail(r.error, p);
    },

    async createTempFile(options = {}) {
      const p = `.tmp/${options.prefix ?? "tmp"}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}${options.suffix ?? ""}`;
      const r = await call("/write", { opId: nextOp("tmpfile"), path: p, content: "" });
      return r.ok ? ok(`${cwd}/${p}`) : fail(r.error ?? "could not create temp file", p);
    },

    async cleanup() { /* the workspace outlives the cell; nothing local to release */ },

    async exec(command, options = {}) {
      const execOp = nextOp("exec");
      // CANCELLING IS SAID, NOT INFERRED.
      //
      // Aborting the fetch alone only releases this side; the command runs on.
      // And a dropped socket is not a cancellation — the cell being SIGKILLed
      // looks identical, and there the command SHOULD finish so the retry is
      // answered from the ledger. So the abort sends an explicit /cancel, and
      // a disconnect means nothing.
      const signal = options.abortSignal;
      const onAbort = () => {
        fetch(`${base}/cancel`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ sessionId, opId: execOp }),
        }).catch(() => { /* the command may have finished first; that is not a fault */ });
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      try {
        const r = await call("/exec", {
          opId: execOp,
          command,
          timeout: options.timeout ?? 120,
        }, signal);
        // pi's bash tool reads what a command printed from these callbacks, not
        // from the returned stdout. Without them it reports "(no output)" for a
        // command that printed and exited 0.
        if (r.stdout && options.onStdout) options.onStdout(r.stdout);
        if (r.stderr && options.onStderr) options.onStderr(r.stderr);
        // pi expects the command's own failure INSIDE the result, not as an
        // error — a non-zero exit is information, not a broken environment.
        return ok({ stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exitCode ?? -1 });
      } catch (e) {
        return err(new ExecutionError("unknown", String(e?.message ?? e)));
      } finally {
        if (signal) signal.removeEventListener("abort", onAbort);
      }
    },
  };
}
