// pi-durable's agent events, emitted as Kortix session events
// (`kortix.transcript.v1`): the frames the SDK's reducer reads, the transcript
// stores and apps/api relays. The port of kortixd's harness/pi/turn-events.ts
// from pi-agent-core's AgentEvent to pi-durable's (harness/events.d.ts):
//
//   run_start / run_end           -> session.status busy / idle + session.idle
//   message_start (assistant)     -> message.updated (the assistant opens)
//   message_update.changes        -> message.part.updated (+ .delta for text)
//   tool_execution_start/update/end -> a tool part, running -> completed|error
//   message_end.entry             -> message.updated with time.completed, error
//   auto_retry_start / _end       -> session.status retry / busy
//
// Stateful across one run: parts accumulate, so a text delta emits BOTH the
// full text so far (`message.part.updated`, transcript only — REST reads need
// the whole string) and the append (`message.part.delta`, bus only — the web
// client paints off deltas). Both on the bus would render the text twice.
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";

const partId = (messageId, index) => `${messageId}-p${index}`;

/** pi's tool result content as the plain text the UI expects. */
export function toolOutputText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text).join("");
  return content == null ? "" : JSON.stringify(content);
}

const objectOr = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The usage and placement fields of an assistant message's `info`. */
export function assistantInfoFields(usage, { agent, workspace }) {
  return {
    agent,
    mode: agent,
    path: { cwd: workspace, root: workspace },
    cost: finite(usage?.cost?.total),
    tokens: {
      input: finite(usage?.input),
      output: finite(usage?.output),
      reasoning: finite(usage?.reasoning),
      cache: { read: finite(usage?.cacheRead), write: finite(usage?.cacheWrite) },
    },
  };
}

/** Why a turn failed, from a message error's name and HTTP status (kortixd's turnErrorCode). */
export function turnErrorCode({ name, statusCode } = {}) {
  switch (name) {
    case "ProviderAuthError": return "auth";
    case "MessageAbortedError": return "aborted";
    case "ContextOverflowError": return "context_length";
    case "MessageOutputLengthError": return "output_length";
  }
  if (statusCode === 401 || statusCode === 403) return "auth";
  if (statusCode === 402) return "credits";
  if (statusCode === 429) return "rate_limit";
  return "unknown";
}

/** The `error` of a terminal pi assistant message, or undefined. */
export function assistantMessageError(message) {
  const detail = typeof message?.errorMessage === "string" && message.errorMessage.trim() ? message.errorMessage.trim() : null;
  if (message?.stopReason === "aborted") return { name: "MessageAbortedError", data: { message: detail ?? "The message was aborted" }, code: "aborted" };
  if (message?.stopReason === "length") return { name: "MessageOutputLengthError", data: {}, code: "output_length" };
  if (message?.stopReason !== "error") return undefined;
  if (isContextOverflow(message)) {
    return { name: "ContextOverflowError", data: { message: detail ?? "The conversation is too long for the model" }, code: "context_length" };
  }
  const match = detail ? /^([45]\d\d)\b/.exec(detail) : null;
  const statusCode = match ? Number(match[1]) : undefined;
  return {
    name: "UnknownError",
    data: { message: detail ?? "The model request failed", ...(statusCode ? { statusCode } : {}) },
    code: turnErrorCode({ statusCode }),
  };
}

/** The message an entry contributes to model context, of the given role. */
export function entryMessage(entry, role) {
  return (entry?.model ?? []).find((m) => m?.role === role) ?? null;
}

export class DurableTurnEvents {
  /**
   * @param {object} opts
   * @param {string} opts.sessionID         the runtime root id
   * @param {() => string} opts.mintMessageId
   * @param {() => string|null} opts.parentMessageId  the user message this run answers
   * @param {() => {providerID: string, modelID: string}} opts.model
   * @param {() => string} opts.agent
   * @param {string} opts.workspace
   * @param {() => number} [opts.now]
   */
  constructor(opts) {
    this.opts = opts;
    this.now = opts.now ?? (() => Date.now());
    this.reset();
  }

  reset() {
    this.currentMessageId = "";
    this.currentParentId = null;
    this.currentCreatedAt = 0;
    this.partCount = 0;
    this.blockIndex = new Map();
    this.accum = new Map();
    this.partStartedAt = new Map();
    this.toolIndex = new Map();
    this.callArgs = new Map();
    this.lastError = null;
    this.retrying = false;
  }

  get messageId() {
    return this.currentMessageId;
  }

  /** The last terminal error of this run, if it ended in one. */
  get error() {
    return this.lastError;
  }

  translate(event) {
    const sessionID = this.opts.sessionID;
    switch (event.type) {
      case "run_start":
        this.lastError = null;
        this.retrying = false;
        return [{ type: "session.status", properties: { sessionID, status: { type: "busy" } } }];

      case "message_start": {
        // Only ASSISTANT messages translate: the cell publishes the user
        // message itself at admission, and tool results ride as tool PARTS.
        if (event.message?.role !== "assistant") return [];
        this.blockIndex.clear();
        this.accum.clear();
        this.partStartedAt.clear();
        this.toolIndex.clear();
        this.callArgs.clear();
        this.partCount = 0;
        this.currentMessageId = this.opts.mintMessageId();
        this.currentParentId = this.opts.parentMessageId();
        this.currentCreatedAt = this.now();
        // THE PARTIAL ALREADY HOLDS THE FIRST TOKENS. pi-durable reports a
        // message's start from the first commit that carries it, and that
        // commit is made after the first chunk arrived. Later updates are
        // deltas on top of it, so dropping this content dropped the opening
        // characters of every block from the live stream: measured on pi-js
        // 2026-10-06, replies read ", let me re-read." and "'s node and npm."
        const opening = [];
        for (const [i, block] of (event.message?.content ?? []).entries()) {
          const text = block?.type === "text" ? block.text : block?.type === "thinking" ? block.thinking : "";
          if (typeof text === "string" && text) opening.push(...this.#change({ type: "block", contentIndex: i, block, opening: true }));
        }
        return [{ type: "message.updated", properties: { sessionID, info: this.#info(event.message?.usage) } }, ...opening];
      }

      case "message_update": {
        if (!this.currentMessageId) return [];
        const out = [];
        for (const change of event.changes ?? []) out.push(...this.#change(change));
        return out;
      }

      case "tool_execution_start": {
        const reserved = this.toolIndex.get(event.toolCallId);
        const id = reserved?.partId ?? partId(this.currentMessageId, this.partCount++);
        const startedAt = reserved?.startedAt ?? this.now();
        this.toolIndex.set(event.toolCallId, { partId: id, name: event.toolName, input: objectOr(event.args), startedAt, output: "" });
        return [this.#toolPart(id, event.toolName, { status: "running", input: objectOr(event.args), time: { start: startedAt } })];
      }

      case "tool_execution_update": {
        const t = this.toolIndex.get(event.toolCallId);
        if (!t || t.endedAt !== undefined) return [];
        const o = event.output;
        if (o && "set" in o) t.output = String(o.set ?? "");
        else if (o) {
          if (o.trimStart) t.output = t.output.slice(o.trimStart);
          if (o.append) t.output += o.append;
        }
        return [this.#toolPart(t.partId, t.name, {
          status: "running",
          input: t.input,
          metadata: { ...objectOr(event.details), output: t.output },
          time: { start: t.startedAt },
        })];
      }

      case "tool_execution_end": {
        // A call that never started still ends: one the permission policy
        // blocked, one naming no offered tool, one with invalid arguments.
        // pi-durable reports only its end, and without a part the client
        // showed nothing at all for it.
        if (!this.toolIndex.has(event.toolCallId) && this.currentMessageId && event.entry) {
          this.toolIndex.set(event.toolCallId, { partId: partId(this.currentMessageId, this.partCount++), name: event.toolName, input: objectOr(this.callArgs.get(event.toolCallId)), startedAt: this.now(), output: "" });
        }
        const t = this.toolIndex.get(event.toolCallId);
        if (!t) return [];
        const endedAt = this.now();
        t.endedAt = endedAt;
        const result = entryMessage(event.entry, "toolResult");
        if (!result) {
          return [this.#toolPart(t.partId, t.name, { status: "error", input: t.input, error: "the tool did not finish", time: { start: t.startedAt, end: endedAt } })];
        }
        const output = toolOutputText(result.content);
        return [this.#toolPart(
          t.partId,
          t.name,
          result.isError
            ? { status: "error", input: t.input, error: output, time: { start: t.startedAt, end: endedAt } }
            : { status: "completed", input: t.input, output, title: t.name, metadata: objectOr(result.details), time: { start: t.startedAt, end: endedAt } },
        )];
      }

      case "message_end": {
        const assistant = entryMessage(event.entry, "assistant");
        if (!assistant || !this.currentMessageId) return [];
        const out = [];
        // The final text of every block, so the stored part matches the
        // provider's message even if a change was coalesced.
        for (const [i, block] of (assistant.content ?? []).entries()) {
          if (block?.type === "text" || block?.type === "thinking") out.push(...this.#change({ type: "block", contentIndex: i, block }));
        }
        for (const block of assistant.content ?? []) {
          if (block?.type === "toolCall" && block.id) this.callArgs.set(block.id, block.arguments);
        }
        const failure = assistantMessageError(assistant);
        this.lastError = failure && failure.code !== "aborted" ? failure : null;
        const info = { ...this.#info(assistant.usage), time: { created: this.currentCreatedAt, completed: this.now() } };
        out.push({ type: "message.updated", properties: { sessionID, info: { ...info, ...(failure ? { error: failure } : {}) } } });
        return out;
      }

      case "auto_retry_start":
        // The failed attempt is retried: not an error yet.
        this.retrying = true;
        this.lastError = null;
        return [{ type: "session.status", properties: { sessionID, status: { type: "retry", attempt: event.attempt, message: event.errorMessage, next: event.at } } }];

      case "auto_retry_end":
        this.retrying = false;
        return [{ type: "session.status", properties: { sessionID, status: { type: "busy" } } }];

      case "task_failed":
        if (!this.lastError) this.lastError = { name: "UnknownError", data: { message: event.message }, code: "unknown" };
        return [];

      case "run_end": {
        const out = [];
        if (this.lastError) out.push({ type: "session.error", properties: { sessionID, error: this.lastError } });
        out.push(
          { type: "session.status", properties: { sessionID, status: { type: "idle" } } },
          { type: "session.idle", properties: { sessionID } },
        );
        return out;
      }

      default:
        return [];
    }
  }

  #info(usage) {
    const model = this.opts.model();
    return {
      id: this.currentMessageId,
      role: "assistant",
      sessionID: this.opts.sessionID,
      ...(this.currentParentId ? { parentID: this.currentParentId } : {}),
      time: { created: this.currentCreatedAt },
      modelID: model.modelID,
      providerID: model.providerID,
      ...assistantInfoFields(usage, { agent: this.opts.agent(), workspace: this.opts.workspace }),
    };
  }

  #change(change) {
    const kindOf = (t) => (t === "text_start" || t === "text_delta" ? "text" : t === "thinking_start" || t === "thinking_delta" ? "reasoning" : null);
    let kind = kindOf(change.type);
    if (change.type === "block" || change.type === "message") {
      if (change.type === "message") {
        const out = [];
        for (const [i, block] of (change.message?.content ?? []).entries()) {
          if (block?.type === "text" || block?.type === "thinking") out.push(...this.#change({ type: "block", contentIndex: i, block }));
        }
        return out;
      }
      kind = change.block?.type === "text" ? "text" : change.block?.type === "thinking" ? "reasoning" : null;
    }
    if (!kind) return [];
    const key = `${kind}:${change.contentIndex}`;
    if (!this.blockIndex.has(key)) this.blockIndex.set(key, this.partCount++);
    const id = partId(this.currentMessageId, this.blockIndex.get(key));
    const prev = this.accum.get(id) ?? "";
    let next = prev;
    let delta = null;
    if (change.type === "text_delta" || change.type === "thinking_delta") {
      delta = change.delta ?? "";
      next = prev + delta;
    } else if (change.type === "text_start" || change.type === "thinking_start" || change.type === "block") {
      const full = kind === "text" ? change.block?.text : change.block?.thinking;
      if (typeof full === "string") next = full;
    }
    if (next === prev && delta === null && this.accum.has(id)) return [];
    this.accum.set(id, next);
    let time;
    if (kind === "reasoning") {
      const start = this.partStartedAt.get(id) ?? this.now();
      this.partStartedAt.set(id, start);
      time = { start, ...(change.type === "block" && !change.opening ? { end: this.now() } : {}) };
    }
    return this.#textFrames({ id, partType: kind, full: next, delta: delta || null, time });
  }

  #textFrames({ id, partType, full, delta, time }) {
    const sessionID = this.opts.sessionID;
    const base = { id, messageID: this.currentMessageId, sessionID, text: full };
    const snapshot = {
      type: "message.part.updated",
      properties: {
        sessionID,
        time: this.now(),
        part: partType === "reasoning"
          ? { ...base, type: "reasoning", time: time ?? { start: this.now() } }
          : { ...base, type: "text", ...(time ? { time } : {}) },
      },
    };
    if (!delta) return [snapshot];
    return [
      { ...snapshot, transcriptOnly: true },
      { type: "message.part.delta", properties: { sessionID, messageID: this.currentMessageId, partID: id, field: "text", delta } },
    ];
  }

  #toolPart(id, tool, state) {
    const sessionID = this.opts.sessionID;
    return {
      type: "message.part.updated",
      properties: { sessionID, time: this.now(), part: { id, messageID: this.currentMessageId, sessionID, type: "tool", tool, callID: id, state } },
    };
  }
}
