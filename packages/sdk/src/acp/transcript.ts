import type { AcpEnvelope, AcpJsonRpcId, AcpStreamEvent } from './types';

export type AcpStoredEnvelope = {
  ordinal: number;
  direction: 'client_to_agent' | 'agent_to_client' | string;
  streamEventId?: number | null;
  envelope: AcpEnvelope | Record<string, unknown>;
  createdAt?: string;
};

export type AcpChatItem =
  | { kind: 'message'; role: 'user' | 'assistant' | 'thought'; text: string }
  | { kind: 'tool'; title: string; data: unknown }
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

export function projectAcpChatItems(rows: readonly AcpStoredEnvelope[]): AcpChatItem[] {
  const items: AcpChatItem[] = [];
  for (const row of rows) {
    const envelope = row.envelope as Record<string, any>;
    if (row.direction === 'client_to_agent' && envelope.method === 'session/prompt') {
      const text = contentText(envelope.params?.prompt);
      if (text) items.push({ kind: 'message', role: 'user', text });
      continue;
    }
    if (row.direction !== 'agent_to_client' || typeof envelope.method !== 'string') continue;
    if (envelope.method === 'session/update') {
      const update = envelope.params?.update ?? {};
      const kind = update.sessionUpdate ?? update.type;
      const text = update.content?.type === 'text' ? update.content.text : '';
      if ((kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') && text) {
        const role = kind === 'agent_thought_chunk' ? 'thought' : 'assistant';
        const previous = items.at(-1);
        if (previous?.kind === 'message' && previous.role === role) previous.text += text;
        else items.push({ kind: 'message', role, text });
      } else if (kind === 'tool_call' || kind === 'tool_call_update' || kind === 'plan') {
        items.push({ kind: 'tool', title: String(update.title ?? kind), data: update });
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
      if (text) messages.push(acpMessage('user', text, row.createdAt, maxChars));
      continue;
    }
    if (row.direction !== 'agent_to_client' || envelope.method !== 'session/update') continue;
    const params = envelope.params as Record<string, unknown> | undefined;
    const update = params?.update as Record<string, unknown> | undefined;
    if (!update) continue;
    const kind = String(update.sessionUpdate ?? update.type ?? '');
    if (kind === 'agent_message_chunk') {
      const text = textFromContent(update.content).join('\n');
      if (!text) continue;
      const previous = messages.at(-1);
      if (previous?.role === 'assistant') previous.text = truncate(previous.text + text, maxChars);
      else messages.push(acpMessage('assistant', text, row.createdAt, maxChars));
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
