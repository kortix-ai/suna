// THE KORTIX-NATIVE RUNTIME SURFACE, `/kortix/*`.
//
// A regular Kortix sandbox is not addressed only through OpenCode's own
// routes. The daemon serves a second, Kortix-shaped namespace that the control
// plane and the dashboard prefer — `/kortix/opencode/{state,events,messages,
// session,todo,config,project-current,vcs-diff,act}`, plus `/kortix/{ports,
// logs,diag,part,git/commit-push}` and the bare `/env` and `/global/dispose`.
// A cell answered four of them and `unknown route` to the rest, so anything
// that reaches for the native surface fell over on pi-js: the dashboard's
// commit-push button, an attachment part, a port list, the runtime's own logs.
//
// The shapes are the daemon's, field for field (apps/kortix-sandbox-agent-server
// /src/routes/opencode-runtime.ts, git.ts, part.ts): a client that speaks to a
// box speaks to a cell without knowing which it reached. Where a cell CANNOT
// do the thing — proxy a port nothing listens on, convert a deck with a
// binary it does not have — it says so in that route's own error shape rather
// than 404ing, because "not here" and "not possible" are different answers.
//
// Pure over what the caller hands it: the cell passes its transcript, its
// state and its git, so every shape is asserted without a cell.

/** Default and maximum page of `/kortix/opencode/messages/:sessionId`. */
export const DEFAULT_MESSAGE_PAGE = 20;
export const MAX_MESSAGE_PAGE = 200;

/** The daemon's own paging rule, kept: a bad number is the default, never an error. */
export function pageSize(raw, fallback = DEFAULT_MESSAGE_PAGE, max = MAX_MESSAGE_PAGE) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

/**
 * One page of a session's transcript, in the daemon's envelope.
 *
 * `messages` are already OpenCode-shaped (`{info, parts}`); everything around
 * them is what the daemon reports about the read itself, so a caller can page
 * and can tell how much was elided.
 */
export function messagesPage(input) {
  const { sessionId, messages, epoch, seq } = input;
  const limit = pageSize(input.limit);
  const before = input.before?.trim?.() || null;
  const after = input.after?.trim?.() || null;
  let list = messages ?? [];
  if (after) {
    const at = list.findIndex((m) => m.info?.id === after);
    if (at >= 0) list = list.slice(at + 1);
  }
  if (before) {
    const at = list.findIndex((m) => m.info?.id === before);
    if (at >= 0) list = list.slice(0, at);
  }
  const hasMore = list.length > limit;
  // The LAST page by default: a transcript is read from its end.
  const page = before ? list.slice(-limit) : after ? list.slice(0, limit) : list.slice(-limit);
  return {
    session_id: sessionId,
    epoch: epoch ?? "",
    seq: seq ?? 0,
    head_seq: seq ?? 0,
    source: "cell",
    count: page.length,
    has_more: hasMore,
    first_message_id: page[0]?.info?.id ?? null,
    last_message_id: page[page.length - 1]?.info?.id ?? null,
    dropped: 0,
    attachments_referenced: 0,
    attachment_bytes_saved: 0,
    tool_outputs_truncated: 0,
    messages: page,
  };
}

/**
 * `POST /kortix/opencode/act` — one route for the four things a client asks a
 * running session to do. The daemon forwards each to OpenCode; a cell answers
 * the ones it can and refuses the others in the same shape, with the reason.
 *
 * `stop` is the one that matters here and the one a cell can do exactly.
 * Permissions and questions do not exist in a cell (its tools run without
 * prompting, which is the product's cell path and always has been), and a
 * revert is a transcript rewrite this runtime does not implement — each says
 * so rather than pretending to have worked.
 */
export const ACT_KINDS = ["permission", "question", "stop", "revert"];

export async function actAnswer(body, ctx) {
  const kind = typeof body?.kind === "string" ? body.kind : null;
  const sessionId = (typeof body?.session_id === "string" && body.session_id) || ctx.sessionId || null;
  const seq = ctx.seq ?? 0;
  const bad = (error, status = 400) => ({ status, body: { ok: false, kind, error } });
  switch (kind) {
    case "stop": {
      if (!sessionId) return bad("no session pinned", 409);
      const stopped = await ctx.stop?.();
      return { status: 200, body: { ok: true, kind, session_id: sessionId, seq, stopped: stopped ?? null } };
    }
    case "permission":
    case "question":
      return bad(`${kind} is not asked in a cell: its tools run without prompting`, 409);
    case "revert":
      return bad("revert is not implemented by this runtime", 409);
    default:
      return {
        status: 400,
        body: { ok: false, error: `unsupported act kind: ${kind ?? "<missing>"}`, supported: ACT_KINDS },
      };
  }
}

/**
 * `GET /kortix/ports` — what is listening inside the sandbox. Nothing ever is
 * in a cell: there is no process to hold a socket, which is also why the
 * Browser tab has no answer here. An empty list WITH the reason beats a 404,
 * which reads as "this runtime is broken" rather than "this runtime has no
 * ports".
 */
export const portsAnswer = () => ({ ports: [], reason: "a cell has no processes, so nothing can listen on a port" });

/** `GET /kortix/logs` — the daemon's tail. A cell's log is what it broadcast. */
export function logsAnswer(rows, limit = 200) {
  return { lines: (rows ?? []).slice(-limit), source: "cell", count: Math.min((rows ?? []).length, limit) };
}

/**
 * `GET /kortix/part/:sessionID/:messageID/:partID` — one part's bytes, which
 * is how an attachment (an image the model produced, a file it read) is
 * fetched out of a transcript instead of being inlined into every read.
 */
export function partAnswer(messages, messageID, partID) {
  const message = (messages ?? []).find((m) => m.info?.id === messageID);
  if (!message) return { status: 404, body: { error: "message not found", messageID } };
  const part = (message.parts ?? []).find((p) => p.id === partID);
  if (!part) return { status: 404, body: { error: "part not found", partID } };
  return { status: 200, body: part };
}

/**
 * `GET /kortix/opencode/turn/:messageId` — WHAT BECAME OF ONE PROMPT.
 *
 * The control plane asks this when it has an open turn record and never saw it
 * close: it names the wire id it sent and wants to know whether that turn is
 * still running, ended, or was accepted and never run at all. The daemon reads
 * OpenCode's delivery state; a cell reads its own turn ledger, which is the
 * same question asked of the same row.
 *
 * `orphaned_prompt` is the one that matters and the one a status alone cannot
 * express: a row still `pending` with nothing running is a prompt this cell
 * took and dropped, and a client that cannot tell that from "still thinking"
 * waits forever.
 */
export function turnAnswer(row, ctx) {
  const seq = ctx?.seq ?? 0;
  const sessionId = ctx?.sessionId ?? null;
  const messageId = ctx?.messageId ?? row?.message_id ?? null;
  if (!row) {
    return { message_id: messageId, opencode_session_id: sessionId, in_flight: null, end: null, orphaned_prompt: false, seq };
  }
  const running = ctx?.running != null && ctx.running === row.i;
  const status = String(row.status ?? "");
  const end = status === "done" ? "completed" : status === "error" ? "failed" : status === "cancelled" ? "abandoned" : null;
  return {
    message_id: messageId,
    opencode_session_id: sessionId,
    in_flight: running || status === "running",
    end,
    orphaned_prompt: status === "pending" && !running,
    seq,
  };
}
