import { contentAttachments, contentText, textFromContent } from './content';
import { emptyReducerState, pendingFromState, reduceEnvelope, type AcpMethodClassifier } from './reduce';
import type { AcpEnvelope, AcpJsonRpcId, AcpStreamEvent } from './types';

export type AcpStoredEnvelope = {
  ordinal: number;
  direction: 'client_to_agent' | 'agent_to_client';
  streamEventId?: number | null;
  envelope: AcpEnvelope | Record<string, unknown>;
  createdAt?: string;
};

/** The shape of one row returned by `AcpClient.transcript()` (`./client`) —
 *  a fully-resolved, already-persisted `AcpStoredEnvelope` (no optional
 *  fields: the server always supplies a concrete direction, stream event id,
 *  parsed envelope, and creation timestamp for a history row). */
export type AcpTranscriptRow = {
  ordinal: number;
  direction: 'client_to_agent' | 'agent_to_client';
  streamEventId: number | null;
  envelope: AcpEnvelope;
  createdAt: string;
};

export type AcpToolCall = {
  id: string;
  title: string;
  toolKind: string | null;
  status: string | null;
  content: unknown[];
  locations: unknown[];
  rawInput: unknown;
  rawOutput: unknown;
  data: Record<string, unknown>;
};

export type AcpPlan = { entries: unknown[]; data: Record<string, unknown> };

export type AcpMessageAttachment =
  | { kind: 'image'; name: string | null; uri: string | null; mimeType: string | null; data: string | null }
  | { kind: 'audio'; name: string | null; uri: string | null; mimeType: string | null; data: string | null }
  | { kind: 'resource'; name: string | null; uri: string | null; mimeType: string | null };

export type AcpChatItem =
  | { kind: 'message'; id: string; role: 'user' | 'assistant' | 'thought'; text: string; attachments?: AcpMessageAttachment[] }
  | ({ kind: 'tool' } & AcpToolCall)
  | ({ kind: 'plan' } & AcpPlan)
  | { kind: 'permission'; id: string | number; method: string; params: Record<string, unknown> }
  | { kind: 'question'; id: string | number; method: string; questions: AcpPendingQuestionItem[]; params: Record<string, unknown> }
  | { kind: 'raw'; method: string; data: unknown };

export type AcpPendingOption = {
  optionId?: string;
  id?: string;
  kind?: string;
  label: string;
  value?: string;
  hint?: string;
  description?: string;
};

export type AcpPendingPermission = {
  id: AcpJsonRpcId;
  method: string;
  sessionId?: string;
  permission: string;
  patterns: string[];
  options: AcpPendingOption[];
  params: Record<string, unknown>;
};

export type AcpPendingQuestionItem = {
  key?: string;
  question: string;
  header?: string;
  options: AcpPendingOption[];
  allowText?: boolean;
};

export type AcpPendingQuestion = {
  id: AcpJsonRpcId;
  method: string;
  sessionId?: string;
  questions: AcpPendingQuestionItem[];
  params: Record<string, unknown>;
};

export type AcpPendingPrompts = {
  permissions: AcpPendingPermission[];
  questions: AcpPendingQuestion[];
};

export type AcpContextMessage = {
  id: string;
  role: 'user' | 'assistant' | 'thought';
  text: string;
};

export type AcpUsageCost = {
  amount: number;
  currency: string;
};

export type AcpTokenUsage = {
  total: number;
  input: number;
  output: number;
  thought: number | null;
  cachedRead: number | null;
  cachedWrite: number | null;
};

export type AcpUsageProjection = {
  /** Current context tokens reported by ACP `usage_update`. */
  used: number | null;
  /** Context-window size reported by ACP `usage_update`. */
  size: number | null;
  /** Current context utilization, from 0 through 100. */
  percent: number | null;
  /** Cumulative session cost when supplied by the active ACP agent. */
  cost: AcpUsageCost | null;
  /** Optional unstable end-turn cumulative token totals. */
  tokens: AcpTokenUsage | null;
  source: 'usage_update' | 'prompt_response';
};

export type AcpContextProjection = {
  messages: AcpContextMessage[];
  usage: AcpUsageProjection | null;
};

export type AcpTurnState = {
  busy: boolean;
  pendingPromptIds: AcpJsonRpcId[];
};

/**
 * Fold-from-scratch wrapper over `reduceEnvelope` (`./reduce`) — the
 * incremental reducer `AcpSession` folds row-by-row as envelopes arrive is
 * the SAME implementation this calls here, one row at a time, starting from
 * an empty state. Kept as its own exported entry point for callers (tests,
 * one-shot projections of a full transcript) that don't need incremental
 * state.
 */
export function projectAcpChatItems(
  rows: readonly AcpStoredEnvelope[],
  options: { classifyMethod?: AcpMethodClassifier } = {},
): AcpChatItem[] {
  return rows.reduce((state, row) => reduceEnvelope(state, row, options), emptyReducerState()).chatItems;
}

/**
 * Project the latest protocol-native context/cost report. ACP's stable
 * `usage_update` is authoritative for the live context window; the optional
 * prompt-response `usage` object is retained as a token-total fallback without
 * inventing a context limit.
 */
export function projectAcpUsage(rows: readonly AcpStoredEnvelope[]): AcpUsageProjection | null {
  return rows.reduce((state, row) => reduceEnvelope(state, row), emptyReducerState()).usage;
}

/** One harness-neutral context projection shared by web, mobile, and headless clients. */
export function projectAcpContext(rows: readonly AcpStoredEnvelope[]): AcpContextProjection {
  const messages = projectAcpChatItems(rows).flatMap<AcpContextMessage>((item) =>
    item.kind === 'message'
      ? [{ id: item.id, role: item.role, text: item.text }]
      : [],
  );
  return { messages, usage: projectAcpUsage(rows) };
}

/** Recover whether a persisted ACP prompt is still in flight after reconnect/reload. */
export function projectAcpTurnState(rows: readonly AcpStoredEnvelope[]): AcpTurnState {
  return rows.reduce((state, row) => reduceEnvelope(state, row), emptyReducerState()).turnState;
}

export function projectAcpPendingPrompts(
  rows: readonly AcpStoredEnvelope[],
  options: { classifyMethod?: AcpMethodClassifier } = {},
): AcpPendingPrompts {
  return pendingFromState(rows.reduce((state, row) => reduceEnvelope(state, row, options), emptyReducerState()));
}

export type AcpTranscriptMessage = {
  role: 'user' | 'assistant';
  created: string | null;
  completed: string | null;
  text: string;
  tools: Array<{ tool: string; status: string | null }>;
  files: Array<{ filename: string | null; mime: string | null }>;
  reasoning_omitted: boolean;
  error: null;
};

/** Canonical, provider-neutral projection for persisted ACP envelopes. */
export function projectAcpTranscript(
  rows: readonly AcpStoredEnvelope[],
  options: { limit?: number; maxChars?: number } = {},
): AcpTranscriptMessage[] {
  const messages: AcpTranscriptMessage[] = [];
  const maxChars = options.maxChars ?? 4_000;
  for (const row of rows) {
    const envelope = row.envelope;
    if (!('method' in envelope)) continue;
    if (row.direction === 'client_to_agent' && envelope.method === 'session/prompt') {
      const params = envelope.params as Record<string, unknown> | undefined;
      const text = contentText(params?.prompt).trim();
      const files = transcriptFiles(params?.prompt);
      if (text || files.length) {
        const message = acpMessage('user', text, row.createdAt, maxChars);
        message.files = files;
        messages.push(message);
      }
      continue;
    }
    if (row.direction !== 'agent_to_client' || envelope.method !== 'session/update') continue;
    const params = envelope.params as Record<string, unknown> | undefined;
    const update = params?.update as Record<string, unknown> | undefined;
    if (!update) continue;
    const kind = String(update.sessionUpdate ?? update.type ?? '');
    if (kind === 'agent_message_chunk') {
      const text = textFromContent(update.content).join('\n');
      const files = transcriptFiles(update.content);
      if (!text && !files.length) continue;
      const previous = messages.at(-1);
      if (previous?.role === 'assistant') {
        previous.text = truncate(previous.text + text, maxChars);
        previous.files.push(...files);
      } else {
        const message = acpMessage('assistant', text, row.createdAt, maxChars);
        message.files = files;
        messages.push(message);
      }
    } else if (kind === 'agent_thought_chunk') {
      const previous = messages.at(-1);
      if (previous?.role === 'assistant') previous.reasoning_omitted = true;
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      const previous = messages.at(-1);
      if (previous?.role === 'assistant') {
        previous.tools.push({
          tool: String(update.title ?? update.toolCallId ?? 'tool'),
          status: typeof update.status === 'string' ? update.status : null,
        });
      }
    }
  }
  return messages.slice(-(options.limit ?? 200));
}

function transcriptFiles(value: unknown): AcpTranscriptMessage['files'] {
  return contentAttachments(value).map((attachment) => ({
    filename: attachment.name,
    mime: attachment.mimeType,
  }));
}

function acpMessage(role: 'user' | 'assistant', text: string, createdAt: string | undefined, maxChars: number): AcpTranscriptMessage {
  return {
    role,
    created: createdAt ?? null,
    completed: null,
    text: truncate(text.replace(/\s+/g, ' ').trim(), maxChars),
    tools: [],
    files: [],
    reasoning_omitted: false,
    error: null,
  };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Discriminates the two accepted input shapes at runtime: a live
 *  `AcpStreamEvent` has `id` + `envelope` and neither `ordinal` nor
 *  `direction`; a persisted `AcpStoredEnvelope` row always has both of the
 *  latter. An empty array is ambiguous — treated as (empty) stored rows,
 *  since that path degrades to `''`/basic empty output without throwing,
 *  while the stream-event path would too, so either reading is safe; stored
 *  rows is chosen as the primary, non-deprecated shape. */
function isStreamEventInput(
  input: readonly AcpStoredEnvelope[] | readonly AcpStreamEvent[],
): input is readonly AcpStreamEvent[] {
  const first = input[0];
  return isPlainObject(first) && 'envelope' in first && 'id' in first && !('ordinal' in first) && !('direction' in first);
}

/** Adapts a live `AcpStreamEvent[]` onto the same `AcpStoredEnvelope[]` shape
 *  stored rows already use, per the documented mapping: `ordinal` and
 *  `streamEventId` both take the stream's monotonic event id, `direction` is
 *  always `'agent_to_client'` (a live SSE stream only ever carries
 *  agent-originated envelopes), and `createdAt` is omitted (unknown for a
 *  live event). Stored-row input passes through unchanged. */
function toStoredRows(
  input: readonly AcpStoredEnvelope[] | readonly AcpStreamEvent[],
): readonly AcpStoredEnvelope[] {
  if (isStreamEventInput(input)) {
    return input.map((event) => ({
      ordinal: event.id,
      direction: 'agent_to_client' as const,
      streamEventId: event.id,
      envelope: event.envelope,
    }));
  }
  return input;
}

/**
 * One JSON line per row: `{ordinal, direction, streamEventId, createdAt,
 * envelope}` — a lossless, round-trippable export of a persisted ACP
 * transcript (parse each line back and you reconstruct the original rows).
 */
export function acpTranscriptJsonl(rows: readonly AcpStoredEnvelope[]): string;
/**
 * @deprecated Pass the `AcpStoredEnvelope[]` rows from `client.transcript()`
 * (or `AcpSession`'s persisted log) for a lossless export instead. This
 * overload accepts live `AcpStreamEvent[]` for backward compatibility only —
 * it preserves the original `{sequence, envelope}`-per-line shape, which
 * drops direction/timestamps and is NOT round-trippable to a stored row.
 */
export function acpTranscriptJsonl(events: readonly AcpStreamEvent[]): string;
export function acpTranscriptJsonl(input: readonly AcpStoredEnvelope[] | readonly AcpStreamEvent[]): string {
  if (isStreamEventInput(input)) {
    return input.map((event) => JSON.stringify({ sequence: event.id, envelope: event.envelope })).join('\n')
      + (input.length ? '\n' : '');
  }
  const rows = input as readonly AcpStoredEnvelope[];
  return rows
    .map((row) => JSON.stringify({
      ordinal: row.ordinal,
      direction: row.direction,
      streamEventId: row.streamEventId,
      createdAt: row.createdAt,
      envelope: row.envelope,
    }))
    .join('\n') + (rows.length ? '\n' : '');
}

/** Renders one markdown section per `AcpChatItem` in `projectAcpChatItems(rows)`
 *  — one heading per coalesced message/tool/plan/permission/question, never per
 *  raw wire chunk. Shared by both the stored-row and (adapted) stream-event
 *  overloads of `acpTranscriptMarkdown`, and by `acpTranscriptHtml`. */
function renderMarkdown(rows: readonly AcpStoredEnvelope[]): string {
  const lines = ['# Agent transcript', ''];
  for (const item of projectAcpChatItems(rows)) {
    if (item.kind === 'message') {
      lines.push(`## ${item.role}`, '', item.text, '');
    } else if (item.kind === 'tool') {
      lines.push(`## tool: ${item.title} (${item.status ?? 'unknown'})`, '', '```json', JSON.stringify(item.data, null, 2), '```', '');
    } else if (item.kind === 'plan') {
      const entries = item.entries.length ? item.entries.map((entry) => `- ${formatPlanEntry(entry)}`) : ['_(empty plan)_'];
      lines.push('## plan', '', ...entries, '');
    } else if (item.kind === 'permission') {
      lines.push(`## permission: ${item.method}`, '', '```json', JSON.stringify(item.params, null, 2), '```', '');
    } else if (item.kind === 'question') {
      lines.push(`## question: ${item.method}`, '', '```json', JSON.stringify(item.questions, null, 2), '```', '');
    } else {
      lines.push(`## ${item.method}`, '', '```json', JSON.stringify(item.data, null, 2), '```', '');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function formatPlanEntry(entry: unknown): string {
  if (typeof entry === 'string') return entry;
  if (isPlainObject(entry)) {
    const content = typeof entry.content === 'string' ? entry.content : undefined;
    const status = typeof entry.status === 'string' ? entry.status : undefined;
    if (content) return status ? `${content} (${status})` : content;
  }
  return JSON.stringify(entry);
}

/**
 * Coalesced markdown export, built from `projectAcpChatItems(rows)`: one
 * `## user` / `## assistant` / `## thought` section per message (chunks
 * already joined by the reducer), one `## tool: {title} ({status})` section
 * per tool call with its data fenced as JSON, and one `## plan` section per
 * plan — never one heading per wire chunk.
 */
export function acpTranscriptMarkdown(rows: readonly AcpStoredEnvelope[]): string;
/**
 * @deprecated Pass the `AcpStoredEnvelope[]` rows from `client.transcript()`
 * for the canonical, chunk-coalesced export instead. This overload accepts
 * live `AcpStreamEvent[]` for backward compatibility — it adapts each event
 * onto a synthetic stored row (`agent_to_client`, no `createdAt`) and renders
 * through the same coalescing path.
 */
export function acpTranscriptMarkdown(events: readonly AcpStreamEvent[]): string;
export function acpTranscriptMarkdown(input: readonly AcpStoredEnvelope[] | readonly AcpStreamEvent[]): string {
  return renderMarkdown(toStoredRows(input));
}

/** Escaped markdown (see `acpTranscriptMarkdown`) wrapped in a `<pre>` tag. */
export function acpTranscriptHtml(rows: readonly AcpStoredEnvelope[]): string;
/**
 * @deprecated Pass the `AcpStoredEnvelope[]` rows from `client.transcript()`
 * instead. This overload accepts live `AcpStreamEvent[]` for backward
 * compatibility, adapted the same way `acpTranscriptMarkdown` adapts them.
 */
export function acpTranscriptHtml(events: readonly AcpStreamEvent[]): string;
export function acpTranscriptHtml(input: readonly AcpStoredEnvelope[] | readonly AcpStreamEvent[]): string {
  const escaped = renderMarkdown(toStoredRows(input))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<!doctype html><meta charset="utf-8"><title>Agent transcript</title><pre>${escaped}</pre>`;
}

/** Which raw {@link AcpPendingOption} answers each slot of the three-tier
 * permission UI (Deny / Allow once / Allow for session). ACP's standard
 * option kinds are `allow_once` / `allow_always` / `reject_once` /
 * `reject_always`; a harness that sends different (or no) `kind` values still
 * gets a usable mapping via `optionId`/`id` pattern matching, falling back to
 * "first unclaimed option is the primary allow action" so the UI never has
 * nothing to offer. */
export type ResolvedPermissionActions = {
  allowOnce: AcpPendingOption | null;
  allowSession: AcpPendingOption | null;
  /** Null means no explicit reject option was offered — deny by responding
   *  with no `optionId` (`{ outcome: 'cancelled' }`). */
  deny: AcpPendingOption | null;
  /** Options that don't fit tha three-tier layout — render as extra buttons. */
  extra: AcpPendingOption[];
};

function optionKey(option: AcpPendingOption): string {
  return String(option.optionId ?? option.id ?? option.value ?? '');
}

function findByKind(options: AcpPendingOption[], kinds: string[]): AcpPendingOption | null {
  return options.find((option) => option.kind && kinds.includes(option.kind)) ?? null;
}

function findByPattern(
  options: AcpPendingOption[],
  pattern: RegExp,
  exclude: Set<AcpPendingOption>,
): AcpPendingOption | null {
  return options.find((option) => !exclude.has(option) && pattern.test(optionKey(option))) ?? null;
}

export function resolvePermissionActionOptions(options: AcpPendingOption[]): ResolvedPermissionActions {
  const allowOnce =
    findByKind(options, ['allow_once']) ?? findByPattern(options, /allow.?once/i, new Set());
  const allowSession =
    findByKind(options, ['allow_always']) ??
    findByPattern(options, /allow.?(always|session)/i, new Set(allowOnce ? [allowOnce] : []));
  const deny =
    findByKind(options, ['reject_once', 'reject_always']) ??
    findByPattern(
      options,
      /reject|deny/i,
      new Set([allowOnce, allowSession].filter((o): o is AcpPendingOption => !!o)),
    );
  const claimed = new Set([allowOnce, allowSession, deny].filter((o): o is AcpPendingOption => !!o));
  // Every permission request needs a primary allow action — if no option
  // looked like "allow once", the first still-unclaimed option becomes it.
  const primaryAllowOnce = allowOnce ?? options.find((option) => !claimed.has(option)) ?? null;
  if (primaryAllowOnce) claimed.add(primaryAllowOnce);
  const extra = options.filter((option) => !claimed.has(option));
  return { allowOnce: primaryAllowOnce, allowSession, deny, extra };
}

/** The option `resolvePermissionActionOptions` would auto-approve with —
 *  shared by the "allow everything this session" action and the client-side
 *  auto-approve backstop so both pick the exact same option. */
export function defaultAllowPermissionOption(options: AcpPendingOption[]): AcpPendingOption | null {
  return resolvePermissionActionOptions(options).allowOnce;
}

export type { AcpEnvelope };
