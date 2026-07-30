/**
 * The ONE sanitized transcript projection used by every server-side transcript
 * reader.
 *
 * Two transports produce the same compact shape:
 *
 * - `compactOpencodeMessages` folds an OpenCode REST `/session/:id/message`
 *   payload (`parts[]`). This was duplicated verbatim in
 *   `projects/lib/session-transcript.ts` and `shared/public-session-share-view.ts`;
 *   both now call this one implementation.
 * - `compactAcpEnvelopes` folds the durable ACP envelope log
 *   (`kortix.acp_session_envelopes`, read via `loadAcpTranscript`). Under
 *   managed ACP no OpenCode REST pin exists and the in-sandbox REST server is
 *   never started, so the envelope log is the ONLY transcript source — and it
 *   is strictly more reliable, because it survives the sandbox.
 *
 * Sanitization is identical for both: message role, text, tool NAME + status,
 * file NAME + mime, and a `reasoning_omitted` flag. Tool arguments, tool
 * output, reasoning text, and file contents never leave this module.
 *
 * The ACP fold matches `packages/sdk/src/core/acp/projection.ts` (the client
 * projection the UI renders) for update kinds, tool naming and status mapping,
 * so the two never disagree about what a session said. It deviates in exactly
 * one place, deliberately: replay de-duplication. `session/load` makes a
 * harness re-emit a finished conversation as brand-new `session/update`
 * notifications, so the log holds N copies of every message (dev session
 * 10533f77-00e3-420c-936b-82933e4d1025 holds 11). Each re-emission repeats the
 * harness-native `messageId`, so this fold keys messages by `messageId` and
 * keeps the LONGEST re-emission of each. Replays deliver the whole message in
 * one chunk and can only be truncated by a killed process, so longest ==
 * most complete.
 */

import type { StoredAcpEnvelope } from '../projects/lib/acp-transcript';

export interface CompactToolCall {
  tool: string;
  status: string | null;
}

export interface CompactFileRef {
  filename: string | null;
  mime: string | null;
}

export interface CompactMessage {
  role: string;
  created: string | null;
  completed: string | null;
  text: string;
  tools: CompactToolCall[];
  files: CompactFileRef[];
  reasoning_omitted: boolean;
  error: { name?: string; message?: string } | null;
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/* -------------------------------------------------------------------------- */
/* OpenCode REST                                                              */
/* -------------------------------------------------------------------------- */

type RawOpencodePart = {
  type?: string;
  text?: string;
  synthetic?: boolean;
  tool?: string;
  state?: { status?: string };
  filename?: string;
  mime?: string;
};

type RawOpencodeMessage = {
  info?: {
    role?: string;
    time?: { created?: number; completed?: number };
    error?: { name?: string; message?: string } | null;
  };
  role?: string;
  time?: { created?: number; completed?: number };
  error?: { name?: string; message?: string } | null;
  parts?: RawOpencodePart[];
};

function normalizeOpencodeMessageList(payload: unknown): RawOpencodeMessage[] {
  const list = Array.isArray(payload)
    ? payload
    : isObject(payload) && Array.isArray(payload.messages)
      ? payload.messages
      : [];
  return list.filter((message): message is RawOpencodeMessage => isObject(message));
}

function compactOpencodeMessage(message: RawOpencodeMessage, maxChars: number): CompactMessage {
  const info = message.info ?? message;
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const text = parts
    .filter((part) => part.type === 'text' && !part.synthetic && typeof part.text === 'string')
    .map((part) => part.text as string)
    .filter(Boolean)
    .join('\n');
  const tools = parts
    .filter((part) => part.type === 'tool')
    .map((part) => ({ tool: part.tool ?? 'tool', status: part.state?.status ?? null }));
  const files = parts
    .filter((part) => part.type === 'file')
    .map((part) => ({ filename: part.filename ?? null, mime: part.mime ?? null }));
  return {
    role: info.role ?? 'unknown',
    created: info.time?.created ? new Date(info.time.created).toISOString() : null,
    completed: info.time?.completed ? new Date(info.time.completed).toISOString() : null,
    text: truncate(normalizeWhitespace(text), maxChars),
    tools,
    files,
    reasoning_omitted: parts.some((part) => part.type === 'reasoning'),
    error: info.error ?? null,
  };
}

export function compactOpencodeMessages(
  payload: unknown,
  options: { limit: number; maxChars: number },
): CompactMessage[] {
  return normalizeOpencodeMessageList(payload)
    .slice(-options.limit)
    .map((message) => compactOpencodeMessage(message, options.maxChars));
}

/* -------------------------------------------------------------------------- */
/* ACP envelopes                                                              */
/* -------------------------------------------------------------------------- */

/** Mirrors ACP_KIND_TOOL in packages/sdk/src/core/acp/projection.ts. */
const ACP_KIND_TOOL: Record<string, string> = {
  execute: 'bash',
  read: 'read',
  edit: 'edit',
  delete: 'edit',
  move: 'edit',
  search: 'grep',
  fetch: 'webfetch',
};

type AcpDraft = {
  role: 'user' | 'assistant';
  messageId: string | null;
  created: string;
  completed: string | null;
  /** One entry per re-emission of this message; the longest one wins. */
  segments: string[];
  segment: number;
  reasoningOmitted: boolean;
  files: CompactFileRef[];
  error: { name?: string; message?: string } | null;
  toolCallIds: string[];
};

function looksLikeToolName(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_.-]*$/.test(value);
}

/** Mirrors `isRuntimeAttachRequest` in packages/sdk/src/core/acp/projection.ts. */
function isAcpAttachRequest(method: string): boolean {
  return method === 'initialize' || method === 'session/new' || method === 'session/load';
}

function acpToolName(update: Record<string, unknown>): string {
  const title = asString(update.title);
  if (title && looksLikeToolName(title)) return title;
  const kind = asString(update.kind) ?? 'other';
  return ACP_KIND_TOOL[kind] ?? kind;
}

function acpToolStatus(raw: string | null, previous: string | null): string {
  if (previous === 'completed' || previous === 'error') return previous;
  if (raw === 'completed') return 'completed';
  if (raw === 'failed') return 'error';
  return 'running';
}

function acpPromptFile(block: Record<string, unknown>): CompactFileRef {
  const uri = asString(block.uri);
  const name = asString(block.name) ?? (uri ? (uri.split('/').pop() ?? null) : null);
  return { filename: name, mime: asString(block.mimeType) };
}

function longestSegment(segments: readonly string[]): string {
  return segments.reduce(
    (best, candidate) => (candidate.length > best.length ? candidate : best),
    '',
  );
}

/**
 * The harness-native session id the envelopes belong to. `project_sessions`
 * stores it as `metadata.acp_session_id` once `session/new` answers, but rows
 * predating that write have none — fall back to the last id the client scoped
 * a request to. One ACP server can host sessions for several project sessions,
 * so an unscoped fold would splice another conversation's notifications in.
 */
function inferAcpSessionScope(envelopes: readonly StoredAcpEnvelope[]): string | null {
  for (let index = envelopes.length - 1; index >= 0; index -= 1) {
    const body = envelopes[index].envelope;
    const method = asString(body.method);
    if (method !== 'session/prompt' && method !== 'session/load') continue;
    const scoped = asString(asObject(body.params).sessionId);
    if (scoped) return scoped;
  }
  return null;
}

export function compactAcpEnvelopes(
  envelopes: readonly StoredAcpEnvelope[],
  options: { acpSessionId: string | null; limit: number; maxChars: number },
): CompactMessage[] {
  const scope = options.acpSessionId ?? inferAcpSessionScope(envelopes);
  const drafts: AcpDraft[] = [];
  const tools = new Map<string, CompactToolCall>();
  const toolOwners = new Map<string, AcpDraft>();
  const promptDrafts = new Map<string, AcpDraft>();
  let openDraft: AcpDraft | null = null;
  let activeMessageId: string | null = null;
  let activeAssistant: AcpDraft | null = null;
  /**
   * True from a runtime attach until the next `session/prompt`. Mirrors
   * `AcpProjection.replay.replaying` in
   * `packages/sdk/src/core/acp/projection.ts`: inside that window the harness
   * re-emits its canonical history, so the replay's emission order — not the
   * order this fold first heard of a message — is the true conversation order.
   */
  let replaying = false;
  /** The draft the running replay positioned last. */
  let anchorDraft: AcpDraft | null = null;

  const insertAt = (role: 'user' | 'assistant'): number => {
    if (!replaying) return drafts.length;
    if (!anchorDraft) {
      // A replay re-emits the conversation from its first user turn. An
      // assistant chunk arriving before that is the tail of the stream the
      // attach interrupted and still belongs at the end.
      return role === 'user' ? 0 : drafts.length;
    }
    const index = drafts.indexOf(anchorDraft);
    return index < 0 ? drafts.length : index + 1;
  };

  const createDraft = (role: 'user' | 'assistant', messageId: string | null, createdAt: string) => {
    const draft: AcpDraft = {
      role,
      messageId,
      created: createdAt,
      completed: null,
      segments: [''],
      segment: 0,
      reasoningOmitted: false,
      files: [],
      error: null,
      toolCallIds: [],
    };
    drafts.splice(insertAt(role), 0, draft);
    return draft;
  };

  const focus = (draft: AcpDraft, createdAt: string) => {
    if (openDraft && openDraft !== draft && !openDraft.completed) openDraft.completed = createdAt;
    openDraft = draft;
    activeMessageId = draft.messageId;
    if (draft.role === 'assistant') activeAssistant = draft;
    // A replay only becomes the authority on order once its first USER turn
    // lands. Before that, what arrives is the tail of the stream the attach
    // interrupted; letting one of those anchor the replay puts the
    // conversation's LAST answer at the head. Mirrors `anchored` in
    // `packages/sdk/src/core/acp/projection.ts`.
    if (replaying && (draft.role === 'user' || anchorDraft)) anchorDraft = draft;
  };

  const chunkDraft = (
    role: 'user' | 'assistant',
    messageId: string | null,
    text: string,
    createdAt: string,
  ): AcpDraft => {
    let draft = messageId ? (drafts.find((entry) => entry.messageId === messageId) ?? null) : null;
    if (!draft && messageId && role === 'user' && text) {
      // A `session/load` replay re-emits the prompt this reader already
      // projected from the `session/prompt` request, which carries no
      // messageId. Adopt the native id instead of emitting the turn twice.
      draft =
        [...drafts]
          .reverse()
          .find(
            (entry) =>
              entry.role === 'user' &&
              entry.messageId === null &&
              longestSegment(entry.segments) === text,
          ) ?? null;
      if (draft) draft.messageId = messageId;
    }
    if (!draft && messageId && role === 'assistant' && activeAssistant?.messageId === null) {
      // `applyTool` opens an assistant draft when a tool call arrives before any
      // chunk names the message. The first chunk that does name it owns it, so
      // the tool stays on the message that made the call.
      draft = activeAssistant;
      draft.messageId = messageId;
    }
    if (!draft && !messageId) {
      draft = role === 'assistant' ? activeAssistant : null;
    }
    if (!draft) {
      draft = createDraft(role, messageId, createdAt);
    } else if (draft.messageId !== null && draft.messageId !== activeMessageId) {
      draft.segments.push('');
      draft.segment = draft.segments.length - 1;
    }
    focus(draft, createdAt);
    return draft;
  };

  const applyTool = (update: Record<string, unknown>, createdAt: string) => {
    const callId = asString(update.toolCallId);
    if (!callId) return;
    const owner =
      toolOwners.get(callId) ?? activeAssistant ?? createDraft('assistant', null, createdAt);
    if (!toolOwners.has(callId)) {
      toolOwners.set(callId, owner);
      owner.toolCallIds.push(callId);
    }
    if (owner.role === 'assistant') activeAssistant = owner;
    const previous = tools.get(callId) ?? null;
    tools.set(callId, {
      tool: previous?.tool ?? acpToolName(update),
      status: acpToolStatus(asString(update.status), previous?.status ?? null),
    });
  };

  for (const stored of envelopes) {
    const body = stored.envelope;
    const createdAt = stored.createdAt;
    const method = asString(body.method);

    if (method === 'session/update') {
      const params = asObject(body.params);
      if (scope && asString(params.sessionId) !== scope) continue;
      const update = asObject(params.update);
      const kind = asString(update.sessionUpdate) ?? asString(update.type);
      const messageId = asString(update.messageId);
      const text = asString(asObject(update.content).text) ?? '';

      if (kind === 'user_message_chunk') {
        const draft = chunkDraft('user', messageId, text, createdAt);
        draft.segments[draft.segment] += text;
        continue;
      }
      if (kind === 'agent_message_chunk') {
        const draft = chunkDraft('assistant', messageId, text, createdAt);
        draft.segments[draft.segment] += text;
        continue;
      }
      if (kind === 'agent_thought_chunk') {
        const draft = chunkDraft('assistant', messageId, '', createdAt);
        draft.reasoningOmitted = true;
        continue;
      }
      if (kind === 'tool_call' || kind === 'tool_call_update') {
        applyTool(update, createdAt);
      }
      continue;
    }

    if (method && body.id !== undefined) {
      const params = asObject(body.params);
      const scoped = asString(params.sessionId);
      if (scope && scoped && scoped !== scope) continue;
      if (isAcpAttachRequest(method)) {
        // Everything after an attach is a re-emission, not a continuation. The
        // reset is what stops two back-to-back replays from concatenating one
        // message into itself ("The build is green.The build is green."):
        // clearing `activeMessageId` makes the next named chunk open a new
        // segment, and the longest segment — not the sum — wins.
        //
        // `activeAssistant` deliberately survives, matching
        // `applyRequest`/`isRuntimeAttachRequest` in
        // `packages/sdk/src/core/acp/projection.ts`, which resets only the
        // active message id. Clearing it here too would split a harness that
        // names no message (Pi) into an extra assistant turn per attach that
        // the client projection does not make.
        activeMessageId = null;
        replaying = true;
        anchorDraft = null;
        continue;
      }
      if (method !== 'session/prompt') continue;
      replaying = false;
      anchorDraft = null;
      const blocks = Array.isArray(params.prompt) ? params.prompt.filter(isObject) : [];
      const text = blocks
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text as string)
        .join('');
      const draft = createDraft('user', null, createdAt);
      draft.segments[0] = text;
      draft.files = blocks.filter((block) => block.type !== 'text').map(acpPromptFile);
      promptDrafts.set(String(body.id), draft);
      focus(draft, createdAt);
      activeAssistant = null;
      continue;
    }

    if (!method && body.id !== undefined) {
      const draft = promptDrafts.get(String(body.id));
      if (!draft) continue;
      promptDrafts.delete(String(body.id));
      const target = activeAssistant ?? draft;
      if (body.error !== undefined) {
        const error = asObject(body.error);
        const code = error.code;
        target.error = {
          ...(code === undefined ? {} : { name: String(code) }),
          ...(asString(error.message) ? { message: asString(error.message) as string } : {}),
        };
      }
      if (!target.completed) target.completed = createdAt;
      activeAssistant = null;
      activeMessageId = null;
      openDraft = null;
    }
  }

  return drafts.slice(-options.limit).map((draft) => ({
    role: draft.role,
    created: draft.created,
    completed: draft.completed,
    text: truncate(normalizeWhitespace(longestSegment(draft.segments)), options.maxChars),
    tools: draft.toolCallIds.flatMap((callId) => {
      const tool = tools.get(callId);
      return tool ? [tool] : [];
    }),
    files: draft.files,
    reasoning_omitted: draft.reasoningOmitted,
    error: draft.error,
  }));
}
