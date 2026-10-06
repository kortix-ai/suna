// THE TWO BLOCKING INTERACTIONS A TURN CAN RAISE, DURABLY.
//
// kortixd's pi harness asks the user before a tool its policy marks `ask`
// (`permission.asked`, answered on `/permission/:id/reply`) and lets the agent
// ask questions (`question.asked`, answered on `/question/:id/reply|reject`).
// Its brokers keep the pending requests in memory (harness/pi/interactions.ts).
//
// A cell can be evicted while it waits for a person. So every request is a row
// in the cell's SQLite, keyed by the tool call that raised it:
//   - pi-durable re-runs an interrupted tool task's `beforeTool` hook on
//     resume, and the hook finds its row: pending (wait again) or answered;
//   - the question tool is registered `replay: "safe"`, so an interrupted call
//     re-runs and finds its row the same way.
// A reply that arrives while no isolate waits is stored, and the resumed task
// reads it. Nothing is asked twice and no answer is lost.
import { Type } from "typebox";

const randomId = (n) => globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, n);

export const ASKS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS kx_asks (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  call_id    TEXT NOT NULL,
  request    TEXT NOT NULL,
  reply      TEXT,
  created_at INTEGER NOT NULL,
  replied_at INTEGER
)`;
export const ALWAYS_TABLE_SQL = "CREATE TABLE IF NOT EXISTS kx_always (capability TEXT PRIMARY KEY)";

const PERMISSION_REPLIES = new Set(["once", "always", "reject"]);

export class CellInteractions {
  /**
   * @param {object} o
   * @param {object} o.sql                       the cell's `ctx.storage.sql`
   * @param {() => string} o.sessionId           the runtime root (`ses_pi…`)
   * @param {(frames: object[]) => void} o.publish
   * @param {() => Promise<void>} [o.onReplied]  wakes the engine after a stored reply
   */
  constructor(o) {
    this.o = o;
    this.sql = o.sql;
    this.sql.exec(ASKS_TABLE_SQL);
    this.sql.exec(ALWAYS_TABLE_SQL);
    this.waiters = new Map();
  }

  alwaysAllowed() {
    return new Set([...this.sql.exec("SELECT capability FROM kx_always")].map((r) => String(r.capability)));
  }

  #row(kind, callId) {
    return this.sql.exec("SELECT * FROM kx_asks WHERE kind = ? AND call_id = ?", kind, callId).toArray()[0] ?? null;
  }

  #byId(id) {
    return this.sql.exec("SELECT * FROM kx_asks WHERE id = ?", id).toArray()[0] ?? null;
  }

  /** Open requests of one kind, oldest first, in the wire shape. */
  list(kind) {
    return [...this.sql.exec("SELECT request FROM kx_asks WHERE kind = ? AND reply IS NULL ORDER BY created_at", kind)]
      .map((r) => JSON.parse(String(r.request)));
  }

  /**
   * The reply for this call: the stored one, or wait for one. A new request is
   * stored and published first. `signal` aborts the wait (the turn stopped).
   */
  async #ask(kind, callId, build, signal) {
    let row = this.#row(kind, callId);
    if (!row) {
      const id = `${kind === "permission" ? "perm" : "que"}_${randomId(24)}`;
      const request = { id, sessionID: this.o.sessionId(), ...build() };
      this.sql.exec(
        "INSERT INTO kx_asks(id, kind, call_id, request, created_at) VALUES (?, ?, ?, ?, ?)",
        id, kind, callId, JSON.stringify(request), Date.now(),
      );
      this.o.publish([{ type: `${kind}.asked`, properties: request }]);
      row = this.#byId(id);
    }
    if (row.reply !== null && row.reply !== undefined) return JSON.parse(String(row.reply));
    const id = String(row.id);
    return new Promise((resolve, reject) => {
      const onAbort = () => { this.waiters.delete(id); reject(signal.reason ?? new Error("aborted")); };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.set(id, (value) => { signal?.removeEventListener("abort", onAbort); resolve(value); });
    });
  }

  #settle(id, kind, reply, frame) {
    const row = this.#byId(id);
    if (!row || row.kind !== kind || (row.reply !== null && row.reply !== undefined)) return false;
    this.sql.exec("UPDATE kx_asks SET reply = ?, replied_at = ? WHERE id = ?", JSON.stringify(reply), Date.now(), id);
    this.o.publish([frame]);
    const waiter = this.waiters.get(id);
    this.waiters.delete(id);
    if (waiter) waiter(reply);
    else this.o.onReplied?.().catch(() => {});
    return true;
  }

  // ── permissions ────────────────────────────────────────────────────────

  /** `once` | `always` | `reject`. */
  askPermission({ callId, permission, patterns, metadata, tool }, signal) {
    return this.#ask("permission", callId, () => ({
      permission,
      patterns,
      metadata,
      always: ["*"],
      ...(tool ? { tool } : {}),
    }), signal);
  }

  replyPermission(id, reply) {
    if (!PERMISSION_REPLIES.has(reply)) return false;
    const row = this.#byId(id);
    if (!row || row.kind !== "permission") return false;
    if (reply === "always") {
      const capability = JSON.parse(String(row.request)).permission;
      if (capability) this.sql.exec("INSERT OR IGNORE INTO kx_always(capability) VALUES (?)", capability);
    }
    return this.#settle(id, "permission", reply, { type: "permission.replied", properties: { sessionID: this.o.sessionId(), requestID: id, reply } });
  }

  // ── questions ──────────────────────────────────────────────────────────

  /** The answers, or null when the user dismissed the question. */
  askQuestion({ callId, questions, tool }, signal) {
    return this.#ask("question", callId, () => ({ questions, ...(tool ? { tool } : {}) }), signal);
  }

  replyQuestion(id, answers) {
    return this.#settle(id, "question", answers, { type: "question.replied", properties: { sessionID: this.o.sessionId(), requestID: id, answers } });
  }

  rejectQuestion(id) {
    return this.#settle(id, "question", null, { type: "question.rejected", properties: { sessionID: this.o.sessionId(), requestID: id } });
  }

  /** A stopped turn releases every open request, as kortixd's `rejectAll`. */
  rejectAll() {
    for (const row of [...this.sql.exec("SELECT id, kind FROM kx_asks WHERE reply IS NULL")]) {
      if (row.kind === "permission") this.replyPermission(String(row.id), "reject");
      else this.rejectQuestion(String(row.id));
    }
  }
}

/** kortixd's `question` tool: ask, wait, and hand the model the answers. */
export function questionTool(interactions, ref = () => undefined) {
  return {
    name: "question",
    description:
      "Ask the user one or more questions and wait for the answers. Use it when a decision needs the user, not to narrate progress. Each question has a short header, the full question, and 2-5 options.",
    parameters: QUESTION_SCHEMA,
    async execute(toolCallId, params, signal) {
      const asked = params.questions;
      const answers = await interactions.askQuestion({ callId: toolCallId, questions: asked, tool: ref(toolCallId) }, signal);
      if (answers === null) throw new Error("The user dismissed the question.");
      const text = asked.map((q, i) => `${q.header}: ${(answers[i] ?? []).join(", ") || "(no answer)"}`).join("\n");
      return { content: [{ type: "text", text: `User answered:\n${text}` }], details: { answers } };
    },
  };
}

/** kortixd's question schema (harness/pi/tools.ts). */
export const QUESTION_SCHEMA = Type.Object({
  questions: Type.Array(
    Type.Object({
      question: Type.String({ description: "The complete question to ask" }),
      header: Type.String({ description: "Very short label (max 30 chars)" }),
      options: Type.Array(
        Type.Object({
          label: Type.String({ description: "Choice label (1-5 words)" }),
          description: Type.String({ description: "What choosing this means" }),
        }),
        { minItems: 1 },
      ),
      multiple: Type.Optional(Type.Boolean({ description: "Allow selecting several options" })),
      custom: Type.Optional(Type.Boolean({ description: "Allow a free-text answer" })),
    }),
    { minItems: 1 },
  ),
});
