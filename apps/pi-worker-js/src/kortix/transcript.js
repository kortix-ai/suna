// The session transcript in the Kortix wire shape (`kortix.transcript.v1`),
// kept in the cell's own SQLite. `/session/:id/message` and
// `/kortix/runtime/messages` serve exactly what the event stream said: every
// frame the runtime emits is published on the bus AND applied here, so the
// list and the stream can never disagree on a message id or a part's text
// (kortixd's harness/pi/transcript.ts, made durable).
//
// pi-durable's own entries are the model's context; this is the product's
// view of it, with the ids, part ids and tool states the clients render.
//
// WRITES ARE BATCHED. A streamed reply produces a full-text snapshot per
// token, and on celld every SQLite write is a durable write. `apply` marks
// rows dirty in memory and `flush` writes them, once per pi commit batch;
// reads merge what is not flushed yet.

export const TRANSCRIPT_TABLES_SQL = [
  "CREATE TABLE IF NOT EXISTS kx_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, info TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS kx_parts (message_id TEXT NOT NULL, part_id TEXT NOT NULL, ord INTEGER NOT NULL, part TEXT NOT NULL, PRIMARY KEY (message_id, part_id))",
];

export class TranscriptStore {
  /**
   * @param {object} sql
   * @param {{ session?: () => (string | null) }} [scope] one session's view of
   *        the shared tables: the root's, or a subagent child's. Without it (or
   *        while it answers null) every message is in view.
   */
  constructor(sql, scope = {}) {
    this.sql = sql;
    this.session = typeof scope.session === "function" ? scope.session : () => null;
    for (const statement of TRANSCRIPT_TABLES_SQL) sql.exec(statement);
    /** message id -> info, not yet written */
    this.dirtyInfo = new Map();
    /** message id -> Map(part id -> part), not yet written */
    this.dirtyParts = new Map();
    this.removedMessages = new Set();
    this.removedParts = new Set();
  }

  apply(frame) {
    const p = frame?.properties ?? {};
    if (frame.type === "message.updated") {
      const info = p.info;
      if (!info?.id) return;
      this.removedMessages.delete(info.id);
      const prior = this.dirtyInfo.get(info.id) ?? this.#storedInfo(info.id);
      this.dirtyInfo.set(info.id, prior ? { ...prior, ...info } : info);
      return;
    }
    if (frame.type === "message.part.updated") {
      const part = p.part;
      if (!part?.id || !part.messageID) return;
      // A part can outrun its message frame on a hot stream: hold the slot
      // with the fields a part names; the message frame fills in the rest.
      if (!this.dirtyInfo.has(part.messageID) && !this.#storedInfo(part.messageID)) {
        this.dirtyInfo.set(part.messageID, { id: part.messageID, role: "assistant", sessionID: part.sessionID });
      }
      if (!this.dirtyParts.has(part.messageID)) this.dirtyParts.set(part.messageID, new Map());
      this.dirtyParts.get(part.messageID).set(part.id, part);
      this.removedParts.delete(`${part.messageID}\0${part.id}`);
      return;
    }
    if (frame.type === "message.removed") {
      if (!p.messageID) return;
      this.dirtyInfo.delete(p.messageID);
      this.dirtyParts.delete(p.messageID);
      this.removedMessages.add(p.messageID);
      return;
    }
    if (frame.type === "message.part.removed") {
      if (!p.messageID || !p.partID) return;
      this.dirtyParts.get(p.messageID)?.delete(p.partID);
      this.removedParts.add(`${p.messageID}\0${p.partID}`);
    }
  }

  /** Write everything applied since the last flush. */
  flush() {
    for (const id of this.removedMessages) {
      this.sql.exec("DELETE FROM kx_parts WHERE message_id = ?", id);
      this.sql.exec("DELETE FROM kx_messages WHERE id = ?", id);
    }
    this.removedMessages.clear();
    for (const key of this.removedParts) {
      const [messageId, partId] = key.split("\0");
      this.sql.exec("DELETE FROM kx_parts WHERE message_id = ? AND part_id = ?", messageId, partId);
    }
    this.removedParts.clear();
    for (const [id, info] of this.dirtyInfo) {
      this.sql.exec(
        "INSERT INTO kx_messages(id, session_id, info) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id, info = excluded.info",
        id, String(info.sessionID ?? ""), JSON.stringify(info),
      );
    }
    this.dirtyInfo.clear();
    for (const [messageId, parts] of this.dirtyParts) {
      for (const [partId, part] of parts) {
        const existing = this.sql.exec("SELECT ord FROM kx_parts WHERE message_id = ? AND part_id = ?", messageId, partId).toArray()[0];
        const ord = existing?.ord ?? (this.sql.exec("SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM kx_parts WHERE message_id = ?", messageId).toArray()[0]?.n ?? 0);
        this.sql.exec(
          "INSERT INTO kx_parts(message_id, part_id, ord, part) VALUES (?, ?, ?, ?) ON CONFLICT(message_id, part_id) DO UPDATE SET part = excluded.part",
          messageId, partId, ord, JSON.stringify(part),
        );
      }
    }
    this.dirtyParts.clear();
  }

  #storedInfo(id) {
    const row = this.sql.exec("SELECT info FROM kx_messages WHERE id = ?", id).toArray()[0];
    return row ? JSON.parse(row.info) : null;
  }

  /** One message, with unflushed changes merged over what is stored. */
  messageById(id) {
    if (this.removedMessages.has(id)) return null;
    const info = this.dirtyInfo.get(id) ?? this.#storedInfo(id);
    if (!info) return null;
    return { info, parts: this.#partsOf(id) };
  }

  #partsOf(id) {
    const parts = this.sql.exec("SELECT part_id, part FROM kx_parts WHERE message_id = ? ORDER BY ord", id).toArray()
      .filter((r) => !this.removedParts.has(`${id}\0${r.part_id}`))
      .map((r) => JSON.parse(r.part));
    const pending = this.dirtyParts.get(id);
    if (!pending) return parts;
    const at = new Map(parts.map((part, i) => [part.id, i]));
    for (const [partId, part] of pending) {
      if (at.has(partId)) parts[at.get(partId)] = part;
      else parts.push(part);
    }
    return parts;
  }

  /** Every message id, oldest first. Ids sort by time (the wire id codec). */
  #ids() {
    const session = this.session();
    const rows = session
      ? this.sql.exec("SELECT id FROM kx_messages WHERE session_id = ?", session).toArray()
      : this.sql.exec("SELECT id FROM kx_messages").toArray();
    const ids = new Set(rows.map((r) => r.id));
    for (const [id, info] of this.dirtyInfo) if (!session || info?.sessionID === session) ids.add(id);
    for (const id of this.removedMessages) ids.delete(id);
    return [...ids].sort();
  }

  /** Oldest-first page ending at `before` (exclusive), like OpenCode's list. */
  page({ limit, before = null }) {
    const ids = this.#ids();
    const eligible = before ? ids.filter((id) => id < before) : ids;
    const window = eligible.slice(-limit);
    return { messages: window.map((id) => this.messageById(id)).filter(Boolean), hasMore: eligible.length > window.length };
  }

  /** Messages after `after` (exclusive), oldest first. */
  after(after, limit) {
    return this.#ids().filter((id) => id > after).slice(0, limit).map((id) => this.messageById(id)).filter(Boolean);
  }

  all() {
    return this.#ids().map((id) => this.messageById(id)).filter(Boolean);
  }

  get count() {
    return this.#ids().length;
  }

  /** The newest message, or null. */
  last() {
    const ids = this.#ids();
    return ids.length ? this.messageById(ids.at(-1)) : null;
  }
}
