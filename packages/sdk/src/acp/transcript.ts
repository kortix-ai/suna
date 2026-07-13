import type { AcpEnvelope, AcpJsonRpcId, AcpStreamEvent } from './types';

export type AcpStoredEnvelope = {
  ordinal: number;
  direction: 'client_to_agent' | 'agent_to_client' | string;
  streamEventId?: number | null;
  envelope: AcpEnvelope | Record<string, unknown>;
  createdAt?: string;
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

export function projectAcpChatItems(rows: readonly AcpStoredEnvelope[]): AcpChatItem[] {
  const items: AcpChatItem[] = [];
  for (const row of rows) {
    const envelope = row.envelope as Record<string, any>;
    if (row.direction === 'client_to_agent' && envelope.method === 'session/prompt') {
      const text = contentText(envelope.params?.prompt);
      const attachments = contentAttachments(envelope.params?.prompt);
      if (text || attachments.length) items.push({
        kind: 'message',
        id: `prompt-${row.ordinal}`,
        role: 'user',
        text,
        ...(attachments.length ? { attachments } : {}),
      });
      continue;
    }
    if (row.direction !== 'agent_to_client' || typeof envelope.method !== 'string') continue;
    if (envelope.method === 'session/update') {
      const update = envelope.params?.update ?? {};
      const kind = update.sessionUpdate ?? update.type;
      const text = textFromContent(update.content).join('');
      const attachments = contentAttachments(update.content);
      if ((kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') && (text || attachments.length)) {
        const role = kind === 'agent_thought_chunk' ? 'thought' : 'assistant';
        const previous = items.at(-1);
        if (previous?.kind === 'message' && previous.role === role) {
          previous.text += text;
          if (attachments.length) previous.attachments = [...(previous.attachments ?? []), ...attachments];
        } else items.push({
          kind: 'message',
          id: `${role}-${row.ordinal}`,
          role,
          text,
          ...(attachments.length ? { attachments } : {}),
        });
      } else if (kind === 'tool_call' || kind === 'tool_call_update') {
        const id = String(update.toolCallId ?? update.id ?? `tool-${row.ordinal}`);
        const existing = items.find((item): item is Extract<AcpChatItem, { kind: 'tool' }> => item.kind === 'tool' && item.id === id);
        const projected = projectToolCall(id, update);
        if (existing) Object.assign(existing, mergeToolCall(existing, projected));
        else items.push({ kind: 'tool', ...projected });
      } else if (kind === 'plan') {
        const plan = { entries: Array.isArray(update.entries) ? update.entries : [], data: update as Record<string, unknown> };
        const existing = items.find((item): item is Extract<AcpChatItem, { kind: 'plan' }> => item.kind === 'plan');
        if (existing) Object.assign(existing, plan);
        else items.push({ kind: 'plan', ...plan });
      } else items.push({ kind: 'raw', method: String(kind ?? envelope.method), data: update });
      continue;
    }
    if ('id' in envelope && isPermissionMethod(envelope.method)) {
      items.push({ kind: 'permission', id: envelope.id, method: envelope.method, params: envelope.params ?? {} });
    } else if ('id' in envelope && isQuestionMethod(envelope.method)) {
      const params = isRecord(envelope.params) ? envelope.params : {};
      const question = projectQuestion(envelope.id as AcpJsonRpcId, envelope.method, params);
      items.push({ kind: 'question', id: envelope.id, method: envelope.method, questions: question.questions, params });
    } else items.push({ kind: 'raw', method: envelope.method, data: envelope.params });
  }
  return items;
}

/**
 * Project the latest protocol-native context/cost report. ACP's stable
 * `usage_update` is authoritative for the live context window; the optional
 * prompt-response `usage` object is retained as a token-total fallback without
 * inventing a context limit.
 */
export function projectAcpUsage(rows: readonly AcpStoredEnvelope[]): AcpUsageProjection | null {
  let context: Omit<AcpUsageProjection, 'tokens'> | null = null;
  let tokens: AcpTokenUsage | null = null;

  for (const row of rows) {
    if (row.direction !== 'agent_to_client') continue;
    const envelope = row.envelope as Record<string, unknown>;
    const params = isRecord(envelope.params) ? envelope.params : null;
    const update = params && isRecord(params.update) ? params.update : null;
    const updateKind = update ? firstString(update.sessionUpdate, update.type) : null;
    if (update && updateKind === 'usage_update') {
      const used = nonNegativeNumber(update.used);
      const size = nonNegativeNumber(update.size);
      if (used !== null && size !== null) {
        const rawCost = isRecord(update.cost) ? update.cost : null;
        const amount = rawCost ? nonNegativeNumber(rawCost.amount) : null;
        const currency = rawCost ? firstString(rawCost.currency) : null;
        context = {
          used,
          size,
          percent: size > 0 ? Math.min(100, (used / size) * 100) : null,
          cost: amount !== null && currency ? { amount, currency } : null,
          source: 'usage_update',
        };
      }
    }

    const result = isRecord(envelope.result) ? envelope.result : null;
    const rawUsage = result && isRecord(result.usage) ? result.usage : null;
    if (!rawUsage) continue;
    const total = nonNegativeNumber(rawUsage.totalTokens ?? rawUsage.total_tokens);
    const input = nonNegativeNumber(rawUsage.inputTokens ?? rawUsage.input_tokens);
    const output = nonNegativeNumber(rawUsage.outputTokens ?? rawUsage.output_tokens);
    if (total === null || input === null || output === null) continue;
    tokens = {
      total,
      input,
      output,
      thought: nonNegativeNumber(rawUsage.thoughtTokens ?? rawUsage.thought_tokens),
      cachedRead: nonNegativeNumber(rawUsage.cachedReadTokens ?? rawUsage.cached_read_tokens),
      cachedWrite: nonNegativeNumber(rawUsage.cachedWriteTokens ?? rawUsage.cached_write_tokens),
    };
  }

  if (context) return { ...context, tokens };
  if (!tokens) return null;
  return {
    used: null,
    size: null,
    percent: null,
    cost: null,
    tokens,
    source: 'prompt_response',
  };
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
  const answered = new Set<string>();
  for (const row of rows) {
    if (row.direction !== 'agent_to_client') continue;
    const envelope = row.envelope as Record<string, unknown>;
    if (!('id' in envelope) || 'method' in envelope) continue;
    if (!('result' in envelope) && !('error' in envelope)) continue;
    answered.add(rpcIdKey(envelope.id));
  }
  const pendingPromptIds: AcpJsonRpcId[] = [];
  for (const row of rows) {
    if (row.direction !== 'client_to_agent') continue;
    const envelope = row.envelope as Record<string, unknown>;
    if (envelope.method !== 'session/prompt') continue;
    const id = envelope.id;
    if (typeof id !== 'string' && typeof id !== 'number') continue;
    if (typeof id === 'string' && id.startsWith('local-')) continue;
    if (!answered.has(rpcIdKey(id))) pendingPromptIds.push(id);
  }
  return { busy: pendingPromptIds.length > 0, pendingPromptIds };
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function projectToolCall(id: string, update: Record<string, unknown>): AcpToolCall {
  return {
    id,
    title: firstString(update.title, update.name, update.kind, id) ?? id,
    toolKind: firstString(update.kind) ?? null,
    status: firstString(update.status) ?? null,
    content: Array.isArray(update.content) ? update.content : [],
    locations: Array.isArray(update.locations) ? update.locations : [],
    rawInput: update.rawInput,
    rawOutput: update.rawOutput,
    data: update,
  };
}

function mergeToolCall(previous: AcpToolCall, next: AcpToolCall): AcpToolCall {
  return {
    ...previous,
    ...next,
    title: next.title === next.id ? previous.title : next.title || previous.title,
    toolKind: next.toolKind ?? previous.toolKind,
    status: next.status ?? previous.status,
    content: next.content.length ? next.content : previous.content,
    locations: next.locations.length ? next.locations : previous.locations,
    rawInput: next.rawInput ?? previous.rawInput,
    rawOutput: next.rawOutput ?? previous.rawOutput,
    data: { ...previous.data, ...next.data },
  };
}

export function projectAcpPendingPrompts(rows: readonly AcpStoredEnvelope[]): AcpPendingPrompts {
  const answered = new Set<string>();
  for (const row of rows) {
    const envelope = row.envelope as Record<string, unknown>;
    if (!('id' in envelope)) continue;
    if ('method' in envelope) continue;
    if (!('result' in envelope) && !('error' in envelope)) continue;
    answered.add(rpcIdKey(envelope.id));
  }

  const permissions: AcpPendingPermission[] = [];
  const questions: AcpPendingQuestion[] = [];
  for (const row of rows) {
    if (row.direction !== 'agent_to_client') continue;
    const envelope = row.envelope as Record<string, unknown>;
    if (!('id' in envelope) || typeof envelope.method !== 'string') continue;
    if (answered.has(rpcIdKey(envelope.id))) continue;
    if ('result' in envelope || 'error' in envelope) continue;
    const params = isRecord(envelope.params) ? envelope.params : {};
    if (isPermissionMethod(envelope.method)) {
      permissions.push(projectPermission(envelope.id as AcpJsonRpcId, envelope.method, params));
    } else if (isQuestionMethod(envelope.method)) {
      questions.push(projectQuestion(envelope.id as AcpJsonRpcId, envelope.method, params));
    }
  }
  return { permissions, questions };
}

function projectPermission(
  id: AcpJsonRpcId,
  method: string,
  params: Record<string, unknown>,
): AcpPendingPermission {
  const toolCall = isRecord(params.toolCall) ? params.toolCall : {};
  const permission = firstString(
    params.permission,
    params.title,
    params.name,
    toolCall.title,
    toolCall.kind,
    params.kind,
    method,
  ) ?? method;
  return {
    id,
    method,
    sessionId: firstString(params.sessionId),
    permission,
    patterns: stringArray(params.patterns),
    options: normalizeOptions(params.options),
    params,
  };
}

function projectQuestion(
  id: AcpJsonRpcId,
  method: string,
  params: Record<string, unknown>,
): AcpPendingQuestion {
  const explicit = Array.isArray(params.questions)
    ? params.questions
        .filter(isRecord)
        .map((question) => ({
          key: firstString(question.key, question.name),
          question: firstString(question.question, question.label, question.title) ?? firstString(params.message, params.prompt) ?? method,
          header: firstString(question.header, params.message, params.title),
          options: normalizeOptions(question.options),
          allowText: question.allowText === true || question.type === 'text',
        }))
    : [];

  const schemaQuestions = questionItemsFromSchema(params);
  const fallback = explicit.length || schemaQuestions.length
    ? []
    : [{
        question: firstString(params.message, params.prompt, params.question, params.title) ?? method,
        header: firstString(params.title),
        options: normalizeOptions(params.options),
        allowText: params.mode !== 'url',
      }];

  return {
    id,
    method,
    sessionId: firstString(params.sessionId),
    questions: [...explicit, ...schemaQuestions, ...fallback],
    params,
  };
}

function questionItemsFromSchema(params: Record<string, unknown>): AcpPendingQuestionItem[] {
  const schema = isRecord(params.requestedSchema) ? params.requestedSchema : null;
  const properties = schema && isRecord(schema.properties) ? schema.properties : null;
  if (!properties) return [];
  return Object.entries(properties).map(([key, raw]) => {
    const property = isRecord(raw) ? raw : {};
    return {
      key,
      question: firstString(property.title, property.description, key) ?? key,
      header: firstString(params.message, params.title),
      options: normalizeSchemaOptions(property),
      allowText: property.type !== 'boolean',
    };
  });
}

function normalizeSchemaOptions(property: Record<string, unknown>): AcpPendingOption[] {
  const enumValues = Array.isArray(property.enum) ? property.enum : [];
  if (enumValues.length > 0) {
    const options: AcpPendingOption[] = [];
    for (const value of enumValues) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        options.push({ label: String(value), value: String(value) });
      }
    }
    return options;
  }
  const choices = Array.isArray(property.oneOf)
    ? property.oneOf
    : Array.isArray(property.anyOf)
      ? property.anyOf
      : [];
  return choices.filter(isRecord).map((choice) => {
    const value = firstString(choice.const, choice.value, choice.enum);
    const label = firstString(choice.title, choice.name, choice.label, value) ?? 'Option';
    return {
      label,
      value,
      description: firstString(choice.description),
      hint: firstString(choice.hint),
    };
  });
}

function normalizeOptions(value: unknown): AcpPendingOption[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((option) => {
    const optionId = firstString(option.optionId, option.id);
    const value = firstString(option.value, optionId);
    const label = firstString(option.label, option.name, option.title, optionId, value) ?? 'Option';
    return {
      optionId,
      id: firstString(option.id),
      kind: firstString(option.kind),
      label,
      value,
      hint: firstString(option.hint),
      description: firstString(option.description),
    };
  });
}

function isPermissionMethod(method: string): boolean {
  return method.includes('permission');
}

function isQuestionMethod(method: string): boolean {
  return method.includes('elicitation') || method.includes('question') || method.includes('input') || method.includes('request');
}

function rpcIdKey(id: unknown): string {
  return JSON.stringify(id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
      const nested = firstString(...value);
      if (nested) return nested;
    }
  }
  return undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
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

function contentText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.flatMap((item) => textFromContent(item)).join('\n');
}

function contentAttachments(value: unknown): AcpMessageAttachment[] {
  const blocks = Array.isArray(value) ? value : [value];
  return blocks.flatMap<AcpMessageAttachment>((raw) => {
    if (!isRecord(raw)) return [];
    const type = firstString(raw.type);
    if (type === 'image' || type === 'audio') {
      return [{
        kind: type,
        name: firstString(raw.name) ?? null,
        uri: firstString(raw.uri) ?? null,
        mimeType: firstString(raw.mimeType, raw.mime_type) ?? null,
        data: firstString(raw.data) ?? null,
      }];
    }
    if (type === 'resource_link') {
      return [{
        kind: 'resource',
        name: firstString(raw.name) ?? null,
        uri: firstString(raw.uri) ?? null,
        mimeType: firstString(raw.mimeType, raw.mime_type) ?? null,
      }];
    }
    if (type === 'resource' && isRecord(raw.resource)) {
      return [{
        kind: 'resource',
        name: firstString(raw.resource.name) ?? null,
        uri: firstString(raw.resource.uri) ?? null,
        mimeType: firstString(raw.resource.mimeType, raw.resource.mime_type) ?? null,
      }];
    }
    return [];
  });
}

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

export function acpTranscriptJsonl(events: readonly AcpStreamEvent[]): string {
  return events.map((event) => JSON.stringify({ sequence: event.id, envelope: event.envelope })).join('\n') + (events.length ? '\n' : '');
}

function textFromContent(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const block = value as Record<string, unknown>;
  if (block.type === 'text' && typeof block.text === 'string') return [block.text];
  return [];
}

export function acpTranscriptMarkdown(events: readonly AcpStreamEvent[]): string {
  const lines = ['# Agent transcript', ''];
  for (const { envelope } of events) {
    if (!('method' in envelope) || envelope.method !== 'session/update') continue;
    const params = envelope.params as Record<string, unknown> | undefined;
    const update = params?.update as Record<string, unknown> | undefined;
    if (!update) continue;
    const kind = String(update.sessionUpdate ?? update.type ?? 'update');
    const content = textFromContent(update.content);
    if (content.length) lines.push(`## ${kind}`, '', ...content, '');
    else if (kind === 'tool_call' || kind === 'tool_call_update') {
      lines.push(`## ${kind}`, '', '```json', JSON.stringify(update, null, 2), '```', '');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function acpTranscriptHtml(events: readonly AcpStreamEvent[]): string {
  const escaped = acpTranscriptMarkdown(events)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<!doctype html><meta charset="utf-8"><title>Agent transcript</title><pre>${escaped}</pre>`;
}

export type { AcpEnvelope };
