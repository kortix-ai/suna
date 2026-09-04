// pi's OWN tools, running in the cell against the remote workspace.
//
// This replaces tools.js's hand-rolled bash/read/write as the default tool set.
// pi's factories (createBashTool, createReadTool, createWriteTool,
// createEditTool) return harness tools whose only host dependency is an
// ExecutionEnv — which src/execenv.js implements over the daemon. So the model
// gets pi's real tools, including `edit`: `{path, edits: [{oldText, newText}]}`
// with a unified diff back, instead of reproducing a whole file to change one
// line. On a 500-line file that is a few hundred output tokens against several
// thousand, every edit.
//
// Two things are bridged here and nowhere else:
//
//   1. A harness tool's execute takes FIVE arguments — (toolCallId, input,
//      signal, onUpdate, ctx) — where an AgentTool takes four. The ctx carries
//      the ExecutionEnv, so it is bound per session.
//
//   2. The op ledger. pi's tools know nothing about the cell's `ops` table, and
//      that table is what tells a resumed cell "this call may have run". Every
//      tool call is wrapped so intent is recorded BEFORE the call and the
//      outcome — done, error, never a stranded 'running' — after.
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-agent-core";
import { remoteExecutionEnv } from "./execenv.js";
import { platinumExecutionEnv } from "./execenv.platinum.js";
import { grepTool, listTool } from "./fstools.js";

// THE CELL'S OWN OP LEDGER.
//
// The daemon has one, and it is what makes a retried tool call safe there. The
// Platinum path had NOTHING: /exec and /files are plain calls, so a turn
// replayed after a crash re-ran whatever the tool call did — the exact failure
// the whole design exists to prevent, on the path that is the product.
//
// So the ledger moves up a layer, into the cell's SQLite, where it covers both
// backends. The daemon keeps its own underneath: it protects the individual
// filesystem ops WITHIN a tool call and survives the cell entirely, which a
// ledger inside the cell cannot do.
//
// The states are the daemon's, because they are the right ones:
//   done     -> answer from the ledger, do not run
//   running  -> MAY HAVE RUN. Do not run. Say the outcome is unknown.
//   error    -> ran and failed cleanly; a retry is free to run again
// A BACKSTOP, not a feature, and measured to be unreachable today.
//
// The largest result any current tool can produce (2026-09-03): 50,039 bytes
// through the daemon, which caps stdout at 50k; 102,857 bytes through
// Platinum's /exec; 359 bytes for a 400 KB file read, because pi's read tool
// truncates and reports the remainder. So nothing reaches this and the
// "too large to retain" path never fires.
//
// It stays because it bounds what a cell writes into SQLite that is flushed to
// object storage on every change, and because the alternative — truncating —
// would REPLAY A WRONG ANSWER, which is worse than refusing. The relationship
// is pinned by a claim in ledger-parity.mjs: if someone raises the daemon's
// stdout cap past this, the test fails instead of sessions quietly becoming
// unretryable.
export const MAX_STORED_RESULT = 200_000;

// Exported so the size decision can be tested directly. No tool produces a
// result large enough to reach it, so a test that goes through a tool cannot
// tell truncation from dropping — and those two differ by whether a replay
// returns a WRONG answer or no answer.
export function ledger(sql) {
  return {
    /** The recorded outcome of this call, or null if it has never been seen. */
    prior(id) {
      const rows = [...sql.exec("SELECT status, result FROM ops WHERE id = ?", id)];
      return rows.length ? rows[0] : null;
    },
    begin(id, kind, detail) {
      sql.exec(
        "INSERT OR IGNORE INTO ops(id, kind, detail, status, started_at) VALUES (?, ?, ?, 'running', ?)",
        id, kind, detail, Date.now(),
      );
    },
    finish(id, status, out, result) {
      // A result too large to keep is stored as NULL rather than truncated: a
      // truncated replay is a WRONG answer, where no replay is an honest one.
      const json = result === undefined ? null : JSON.stringify(result);
      sql.exec(
        "UPDATE ops SET status = ?, out = ?, result = ?, ended_at = ? WHERE id = ?",
        status, out, json && json.length <= MAX_STORED_RESULT ? json : null, Date.now(), id,
      );
    },
    /** A result that came from a ledger rather than a fresh run. */
    replayed(id, was) {
      sql.exec("UPDATE ops SET replayed = ? WHERE id = ?", was ? 1 : 0, id);
    },
  };
}

// THE TOOL SET, IDENTICAL ON EVERY BACKEND.
//
// pi's four plus list and grep. It was four on the daemon and six on Platinum,
// which meant the model's abilities depended on which backend a deployment
// happened to use.
const TOOLSET = () => [createBashTool(), createReadTool(), createWriteTool(), createEditTool(), listTool(), grepTool()];

/** What to record as the op's detail: enough to recognise the call, never the whole payload. */
function detailOf(name, input) {
  if (name === "bash") return String(input?.command ?? "").slice(0, 400);
  if (name === "edit") return `${input?.path} (${(input?.edits ?? []).length} edit${(input?.edits ?? []).length === 1 ? "" : "s"})`;
  return String(input?.path ?? JSON.stringify(input)).slice(0, 400);
}

/**
 * Bind a harness tool to the cell's ledger and to an ExecutionEnv BUILT FOR
 * THIS CALL.
 *
 * The env is constructed per call, not per turn, because the daemon's op ids
 * are derived from the tool call id. A shared env numbers its ops from a
 * counter that restarts with the env, so the first command of every turn got
 * the same id and the daemon answered the later ones from the earlier one's
 * ledger entry. The fix is not a better counter; it is giving the env the one
 * identifier that is already unique per call and stable across its retries.
 */
function adapt(tool, envFor, log, inflight) {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    prepareArguments: tool.prepareArguments,
    executionMode: tool.executionMode,
    execute: async (toolCallId, input, signal, onUpdate) => {
      // THE GATE, BEFORE ANY WORK. Both backends, not just the one with a
      // daemon behind it.
      const prior = log.prior(toolCallId);
      if (prior?.status === "done") {
        if (prior.result) {
          const kept = JSON.parse(prior.result);
          // Recorded on the row too, not only on the result: /ops is where an
          // operator asks "did this run twice?", and an answer that came from
          // the ledger has to be visible there.
          log.replayed(toolCallId, true);
          return { ...kept, details: { ...(kept?.details ?? {}), replayed: true } };
        }
        // Completed, but the result was too large to keep. Re-running is the
        // one thing that must not happen, so say what is known.
        throw new Error(`this tool call already completed; its result was too large to retain and it will not be re-run (${toolCallId})`);
      }
      if (prior?.status === "error" && prior.result) {
        // A CALL THAT FAILED IS STILL A CALL THAT COMPLETED.
        //
        // Re-running it is the one thing that must not happen: the cell cannot
        // tell "the command exited non-zero" from "the command ran and then the
        // reply was lost", and the second re-runs side effects. The model gets
        // a NEW tool call id whenever it genuinely retries, so the only caller
        // that arrives with the same id is crash recovery — which wants the
        // recorded answer, not a second execution.
        //
        // This is also where the two backends would otherwise diverge: the
        // daemon replays its own stored failure, Platinum has no daemon to ask,
        // and without this the same retry re-ran on one path and not the other.
        const kept = JSON.parse(prior.result);
        throw Object.assign(new Error(kept.__error ?? "this tool call already failed"), { replayed: true });
      }
      // 'running' means the cell died mid-call: it MAY have run, which is not
      // the same as "did not". What to do about that depends on whether there
      // is a layer underneath that KNOWS.
      const inFlight = prior?.status === "running";

      // SINGLE FLIGHT. pi can issue the same call twice concurrently on a
      // retry; without this both pass the gate above, because neither has
      // finished writing yet.
      const joined = inflight.get(toolCallId);
      if (joined) return await joined;

      const run = (async () => {
        log.begin(toolCallId, tool.name, detailOf(tool.name, input));
        const env0 = envFor(toolCallId, () => {});
        if (inFlight && env0.idempotent === false) {
          // Nothing underneath keeps a ledger, so re-dispatching could run the
          // side effects a second time. Refuse, and say why.
          const message = `the outcome of this tool call is unknown — it was in flight when the session last stopped, and this backend cannot tell whether it ran, so it will not be re-run (${toolCallId})`;
          log.finish(toolCallId, "error", message, { __error: message });
          throw new Error(message);
        }
        // Did the daemon underneath hand back what it kept? Recorded so a
        // transcript can tell a replay from a re-execution afterwards.
        let servedFromLedger = false;
        const ctx = { env: envFor(toolCallId, (meta) => { if (meta.replayed) servedFromLedger = true; }) };
        try {
          const result = await tool.execute(toolCallId, input, signal, onUpdate, ctx);
          const text = (result?.content ?? []).filter((b) => b?.type === "text").map((b) => b.text).join("\n");
          log.finish(toolCallId, "done", text.slice(0, 4000), result);
          log.replayed(toolCallId, servedFromLedger);
          return servedFromLedger ? { ...result, details: { ...(result?.details ?? {}), replayed: true } } : result;
        } catch (e) {
          // 'error', never left at 'running': that state means "may have run",
          // and a clean failure is not that — a retry of it is free to run.
          const message = String(e?.message ?? e);
          // Stored so the failure can be REPLAYED rather than re-run.
          log.finish(toolCallId, "error", message, { __error: message });
          log.replayed(toolCallId, servedFromLedger);
          throw e;
        }
      })();
      inflight.set(toolCallId, run);
      try { return await run; } finally { inflight.delete(toolCallId); }
    },
  };
}

// ONE PLACE FOR THE WORKSPACE CWD. It was written out twice — here and in
// piToolsPlatinum — and a mutation of the first survived the cell->dev e2e
// while the turn's tools kept using the second. Two copies of a default is a
// divergence with a test that cannot see it; one function is a single site the
// guard (mutate-docker entry 16) can pin.
//
// /home/user is the Kortix image layout. pt-base runs as root with HOME=/ and
// no /home/user at all, so a caller on a stock Platinum sandbox MUST pass
// PT_WORKSPACE_CWD (/root) — measured: the first cell->dev run failed in the
// sandbox's own words, "can't cd to /home/user/".
export const workspaceCwd = (env) => env.PT_WORKSPACE_CWD || "/home/user";

export function executionEnvFor(env, sessionId, opId, onOp) {
  if (env.PT_API_URL && env.PT_SANDBOX_KEY && env.PT_WORKSPACE_ID) {
    return platinumExecutionEnv({
      apiUrl: env.PT_API_URL,
      key: env.PT_SANDBOX_KEY,
      sandboxId: env.PT_WORKSPACE_ID,
      cwd: workspaceCwd(env),
    });
  }
  return remoteExecutionEnv({
    base: env.TOOL_DAEMON_URL,
    token: env.TOOL_DAEMON_TOKEN,
    sessionId,
    cwd: "/work",
    opId,
    onOp,
  });
}

export function piTools(env, sessionId, sql) {
  const envFor = (toolCallId, onOp) => remoteExecutionEnv({
    base: env.TOOL_DAEMON_URL,
    token: env.TOOL_DAEMON_TOKEN,
    sessionId,
    cwd: "/work",
    opId: toolCallId,
    onOp,
  });
  const log = ledger(sql);
  const inflight = new Map();
  return TOOLSET().map((t) => adapt(t, envFor, log, inflight));
}

/**
 * The same four tools over Platinum's own API. This retires tools.platinum.js's
 * bash/read/write in favour of pi's — and adds `edit`, which it never had — while
 * keeping its `list` and `grep`, which Platinum serves natively and pi's core
 * tool set does not include.
 */
export function piToolsPlatinum(env, sessionId, sql, extras = []) {
  // Platinum's API has no op ledger of its own, so there is nothing to key and
  // nothing to collide: one env serves every call. Idempotency for this path
  // lives in the cell's ledger above — which is why that ledger had to move up
  // a layer instead of staying the daemon's private business.
  const execEnv = platinumExecutionEnv({
    apiUrl: env.PT_API_URL,
    key: env.PT_SANDBOX_KEY,
    sandboxId: env.PT_WORKSPACE_ID,
    cwd: workspaceCwd(env),
  });
  const log = ledger(sql);
  const inflight = new Map();
  return [
    ...TOOLSET().map((t) => adapt(t, () => execEnv, log, inflight)),
    ...extras,
  ];
}
