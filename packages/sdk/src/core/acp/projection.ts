import type {
  AssistantMessage,
  Message,
  Part,
  PermissionRequest,
  QuestionInfo,
  QuestionRequest,
  SessionStatus,
  StepFinishPart,
  Todo,
  ToolPart,
} from '@opencode-ai/sdk/v2/client';

import { normalizeToolName, toolInfo } from '../turns/tool-registry';
import type { AcpEnvelope, AcpJsonRpcId } from './types';

export interface AcpMessageWithParts {
  info: Message;
  parts: Part[];
}

export interface AcpProjection {
  sessionId: string;
  messages: AcpMessageWithParts[];
  status: SessionStatus;
  todos: Todo[];
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  configOptions: Array<Record<string, unknown>>;
  availableCommands: Array<Record<string, unknown>>;
  currentModeId: string | null;
  sessionInfo: Record<string, unknown> | null;
  usage: Record<string, unknown> | null;
  nextId: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stringifyOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toolOutput(value: unknown): string {
  if (!isObject(value) || !Object.prototype.hasOwnProperty.call(value, 'output')) {
    return stringifyOutput(value);
  }
  return stringifyOutput(value.output);
}

const ACP_KIND_TOOL: Record<string, string> = {
  execute: 'bash',
  read: 'read',
  edit: 'edit',
  delete: 'edit',
  move: 'edit',
  search: 'grep',
  fetch: 'webfetch',
};

function looksLikeToolName(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_.-]*$/.test(value);
}

function nativeToolName(
  update: Record<string, unknown>,
  previous: ToolPart | null,
): string {
  if (previous) return previous.tool;
  const title = asString(update.title);
  if (title && looksLikeToolName(title)) return title;
  const kind = asString(update.kind) ?? 'other';
  return ACP_KIND_TOOL[kind] ?? kind;
}

function projectedToolTitle(tool: string, title: string | null): string {
  if (!title || normalizeToolName(title) === normalizeToolName(tool)) {
    return toolInfo(tool).label;
  }
  return title;
}

function nextGeneratedId(state: AcpProjection, prefix: string): string {
  return `acp-${prefix}-${String(state.nextId).padStart(8, '0')}`;
}

function createUserMessage(
  state: AcpProjection,
  text: string,
  messageId?: string | null,
): AcpMessageWithParts {
  const id = messageId ?? nextGeneratedId(state, 'user');
  const info = {
    id,
    sessionID: state.sessionId,
    role: 'user',
    time: { created: Date.now() },
    agent: 'default',
    model: { providerID: 'acp', modelID: 'runtime' },
  } satisfies Message;
  return {
    info,
    parts: [
      {
        id: `${id}-text`,
        sessionID: state.sessionId,
        messageID: id,
        type: 'text',
        text,
      },
    ],
  };
}

function createAssistantMessage(
  state: AcpProjection,
  messageId?: string | null,
): AcpMessageWithParts {
  const id = messageId ?? nextGeneratedId(state, 'assistant');
  const parent = [...state.messages]
    .reverse()
    .find((message) => message.info.role === 'user')?.info.id;
  const info = {
    id,
    sessionID: state.sessionId,
    role: 'assistant',
    time: { created: Date.now() },
    parentID: parent ?? id,
    modelID: 'runtime',
    providerID: 'acp',
    mode: state.currentModeId ?? 'build',
    agent: 'default',
    path: { cwd: '/workspace', root: '/workspace' },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  } satisfies AssistantMessage;
  return { info, parts: [] };
}

function withAssistant(
  state: AcpProjection,
  messageId: string | null,
  mutate: (message: AcpMessageWithParts) => AcpMessageWithParts,
): AcpProjection {
  if (messageId) {
    const existingIndex = state.messages.findIndex(
      (message) =>
        message.info.role === 'assistant' && message.info.id === messageId,
    );
    if (existingIndex >= 0) {
      const messages = [...state.messages];
      messages[existingIndex] = mutate(messages[existingIndex]);
      return { ...state, messages, status: { type: 'busy' } };
    }
  }

  const last = state.messages.at(-1);
  if (
    !messageId &&
    last?.info.role === 'assistant' &&
    !last.info.time.completed
  ) {
    const messages = [...state.messages];
    messages[messages.length - 1] = mutate(last);
    return { ...state, messages, status: { type: 'busy' } };
  }

  const completed = Date.now();
  const messages = state.messages.map((message) =>
    message.info.role === 'assistant' && !message.info.time.completed
      ? {
          ...message,
          info: {
            ...message.info,
            time: { ...message.info.time, completed },
          },
        }
      : message,
  );
  const created = createAssistantMessage({ ...state, messages }, messageId);
  return {
    ...state,
    nextId: state.nextId + 1,
    messages: [...messages, mutate(created)],
    status: { type: 'busy' },
  };
}

function appendText(
  state: AcpProjection,
  type: 'text' | 'reasoning',
  text: string,
  messageId: string | null,
): AcpProjection {
  if (!text) return state;
  return withAssistant(state, messageId, (message) => {
    const parts = [...message.parts];
    const existingIndex = parts.findIndex((part) => part.type === type);
    if (existingIndex >= 0) {
      const previous = parts[existingIndex] as Extract<
        Part,
        { type: 'text' | 'reasoning' }
      >;
      parts[existingIndex] = { ...previous, text: previous.text + text };
    } else {
      parts.push({
        id: `${message.info.id}-${type}`,
        sessionID: state.sessionId,
        messageID: message.info.id,
        type,
        text,
        ...(type === 'reasoning' ? { time: { start: Date.now() } } : {}),
      } as Part);
    }
    return { ...message, parts };
  });
}

function applyUserText(
  state: AcpProjection,
  text: string,
  messageId: string | null,
): AcpProjection {
  if (!text) return state;
  if (messageId) {
    const existingIndex = state.messages.findIndex(
      (message) => message.info.role === 'user' && message.info.id === messageId,
    );
    if (existingIndex >= 0) {
      const existing = state.messages[existingIndex];
      const parts = [...existing.parts];
      const index = parts.findIndex((part) => part.type === 'text');
      if (index >= 0) {
        const previous = parts[index] as Extract<Part, { type: 'text' }>;
        parts[index] = { ...previous, text: previous.text + text };
      }
      const messages = [...state.messages];
      messages[existingIndex] = { ...existing, parts };
      return { ...state, messages };
    }
  }
  const last = state.messages.at(-1);
  if (!messageId && last?.info.role === 'user') {
    const parts = [...last.parts];
    const index = parts.findIndex((part) => part.type === 'text');
    if (index >= 0) {
      const previous = parts[index] as Extract<Part, { type: 'text' }>;
      parts[index] = { ...previous, text: previous.text + text };
    }
    const messages = [...state.messages];
    messages[messages.length - 1] = { ...last, parts };
    return { ...state, messages };
  }
  return {
    ...state,
    nextId: state.nextId + 1,
    messages: [...state.messages, createUserMessage(state, text, messageId)],
  };
}

function projectTool(
  state: AcpProjection,
  update: Record<string, unknown>,
): AcpProjection {
  const callId = asString(update.toolCallId);
  if (!callId) return state;
  const owner = state.messages.find((message) =>
    message.parts.some(
      (part) => part.type === 'tool' && part.callID === callId,
    ),
  );
  const ownerId =
    owner?.info.role === 'assistant' ? owner.info.id : null;
  return withAssistant(state, ownerId, (message) => {
    const parts = [...message.parts];
    const index = parts.findIndex(
      (part) => part.type === 'tool' && part.callID === callId,
    );
    const previous =
      index >= 0 ? (parts[index] as ToolPart) : null;
    const input = isObject(update.rawInput)
      ? update.rawInput
      : previous?.state.input ?? {};
    const status = asString(update.status) ?? previous?.state.status ?? 'pending';
    const tool = nativeToolName(update, previous);
    const title = projectedToolTitle(tool, asString(update.title));
    const previousTitle =
      previous?.state.status === 'running' ? previous.state.title : undefined;
    const rawOutput = update.rawOutput;
    const outputMetadata =
      isObject(rawOutput) && isObject(rawOutput.metadata)
        ? rawOutput.metadata
        : {};
    const now = Date.now();
    let part: ToolPart;
    if (status === 'completed') {
      part = {
        id: previous?.id ?? `${message.info.id}-tool-${callId}`,
        sessionID: state.sessionId,
        messageID: message.info.id,
        type: 'tool',
        callID: callId,
        tool,
        state: {
          status: 'completed',
          input,
          output: toolOutput(rawOutput),
          title: title ?? previousTitle ?? tool,
          metadata: outputMetadata,
          time: {
            start:
              previous?.state.status === 'running'
                ? previous.state.time.start
                : now,
            end: now,
          },
        },
      };
    } else if (status === 'failed') {
      part = {
        id: previous?.id ?? `${message.info.id}-tool-${callId}`,
        sessionID: state.sessionId,
        messageID: message.info.id,
        type: 'tool',
        callID: callId,
        tool,
        state: {
          status: 'error',
          input,
          error: toolOutput(rawOutput) || title || 'Tool call failed',
          time: {
            start:
              previous?.state.status === 'running'
                ? previous.state.time.start
                : now,
            end: now,
          },
        },
      };
    } else {
      part = {
        id: previous?.id ?? `${message.info.id}-tool-${callId}`,
        sessionID: state.sessionId,
        messageID: message.info.id,
        type: 'tool',
        callID: callId,
        tool,
        state: {
          status: 'running',
          input,
          title,
          time: {
            start:
              previous?.state.status === 'running'
                ? previous.state.time.start
                : now,
          },
        },
      };
    }
    if (index >= 0) parts[index] = part;
    else parts.push(part);
    return { ...message, parts };
  });
}

function normalizeTodo(value: unknown): Todo | null {
  if (!isObject(value)) return null;
  const content = asString(value.content) ?? asString(value.title);
  if (!content) return null;
  return {
    content,
    status: asString(value.status) ?? 'pending',
    priority: asString(value.priority) ?? 'medium',
  };
}

function normalizeTodos(entries: unknown): Todo[] {
  return Array.isArray(entries)
    ? entries.flatMap((entry) => {
        const todo = normalizeTodo(entry);
        return todo ? [todo] : [];
      })
    : [];
}

function normalizeQuestion(params: Record<string, unknown>): QuestionInfo[] {
  const explicit = Array.isArray(params.questions) ? params.questions : [];
  const fromExplicit = explicit.flatMap((candidate) => {
    if (!isObject(candidate)) return [];
    const question =
      asString(candidate.question) ??
      asString(candidate.label) ??
      asString(params.message);
    if (!question) return [];
    const options = Array.isArray(candidate.options)
      ? candidate.options.flatMap((option) => {
          if (typeof option === 'string') {
            return [{ label: option, description: option }];
          }
          if (!isObject(option)) return [];
          const label = asString(option.label) ?? asString(option.name);
          if (!label) return [];
          return [
            {
              label,
              description: asString(option.description) ?? label,
            },
          ];
        })
      : [];
    return [
      {
        question,
        header: asString(candidate.header) ?? question.slice(0, 30),
        options,
        multiple: candidate.multiple === true,
        custom: candidate.allowText === true,
      },
    ];
  });
  if (fromExplicit.length > 0) return fromExplicit;

  const schema = isObject(params.requestedSchema)
    ? params.requestedSchema
    : isObject(params.schema)
      ? params.schema
      : null;
  const properties = schema && isObject(schema.properties)
    ? schema.properties
    : {};
  const fromSchema = Object.entries(properties).flatMap(([key, raw]) => {
    if (!isObject(raw)) return [];
    const values = Array.isArray(raw.enum) ? raw.enum : [];
    return [
      {
        question:
          asString(raw.title) ??
          asString(raw.description) ??
          asString(params.message) ??
          key,
        header: key.slice(0, 30),
        options: values.map((value) => ({
          label: String(value),
          description: String(value),
        })),
        custom: values.length === 0,
      },
    ];
  });
  if (fromSchema.length > 0) return fromSchema;

  const message = asString(params.message) ?? 'Kortix needs your input';
  return [
    {
      question: message,
      header: message.slice(0, 30),
      options: [],
      custom: true,
    },
  ];
}

function applyRequest(
  state: AcpProjection,
  id: AcpJsonRpcId,
  method: string,
  rawParams: unknown,
): AcpProjection {
  const params = isObject(rawParams) ? rawParams : {};
  if (asString(params.sessionId) !== state.sessionId) return state;
  if (method === 'session/request_permission') {
    const toolCall = isObject(params.toolCall) ? params.toolCall : {};
    const request: PermissionRequest = {
      id: String(id),
      sessionID: state.sessionId,
      permission:
        asString(toolCall.title) ??
        asString(params.permission) ??
        'tool',
      patterns: [],
      metadata: { acp: params },
      always: [],
      ...(asString(toolCall.toolCallId)
        ? {
            tool: {
              messageID: state.messages.at(-1)?.info.id ?? state.sessionId,
              callID: String(toolCall.toolCallId),
            },
          }
        : {}),
    };
    return {
      ...state,
      permissions: [
        ...state.permissions.filter((item) => item.id !== request.id),
        request,
      ],
    };
  }
  if (
    method === 'elicitation/create' ||
    method === 'elicitation/request' ||
    method === 'session/request_input'
  ) {
    const request: QuestionRequest = {
      id: String(id),
      sessionID: state.sessionId,
      questions: normalizeQuestion(params),
    };
    return {
      ...state,
      questions: [
        ...state.questions.filter((item) => item.id !== request.id),
        request,
      ],
    };
  }
  return state;
}

function finishPrompt(
  state: AcpProjection,
  result: Record<string, unknown>,
): AcpProjection {
  const last = state.messages.at(-1);
  if (!last || last.info.role !== 'assistant') {
    return { ...state, status: { type: 'idle' } };
  }
  const usage = isObject(result.usage) ? result.usage : {};
  const input = Number(usage.inputTokens) || 0;
  const output = Number(usage.outputTokens) || 0;
  const reasoning = Number(usage.thoughtTokens) || 0;
  const read = Number(usage.cachedReadTokens) || 0;
  const write = Number(usage.cachedWriteTokens) || 0;
  const reason = asString(result.stopReason) ?? 'end_turn';
  const finish: StepFinishPart = {
    id: `${last.info.id}-finish`,
    sessionID: state.sessionId,
    messageID: last.info.id,
    type: 'step-finish',
    reason,
    cost: Number(usage.cost) || 0,
    tokens: {
      input,
      output,
      reasoning,
      cache: { read, write },
    },
  };
  const info: AssistantMessage = {
    ...last.info,
    time: { ...last.info.time, completed: Date.now() },
    finish: reason,
    cost: finish.cost,
    tokens: finish.tokens,
  };
  const messages = [...state.messages];
  messages[messages.length - 1] = {
    info,
    parts: [...last.parts.filter((part) => part.type !== 'step-finish'), finish],
  };
  return { ...state, messages, status: { type: 'idle' } };
}

export function createAcpProjection(sessionId: string): AcpProjection {
  return {
    sessionId,
    messages: [],
    status: { type: 'idle' },
    todos: [],
    permissions: [],
    questions: [],
    configOptions: [],
    availableCommands: [],
    currentModeId: null,
    sessionInfo: null,
    usage: null,
    nextId: 1,
  };
}

export function applyAcpEnvelope(
  state: AcpProjection,
  envelope: AcpEnvelope,
): AcpProjection {
  if ('method' in envelope && 'id' in envelope) {
    return applyRequest(
      state,
      envelope.id,
      envelope.method,
      envelope.params,
    );
  }

  if ('method' in envelope && envelope.method === 'session/update') {
    const params = isObject(envelope.params) ? envelope.params : {};
    if (asString(params.sessionId) !== state.sessionId) return state;
    const update = isObject(params.update) ? params.update : {};
    const kind = asString(update.sessionUpdate) ?? asString(update.type);
    const content = isObject(update.content) ? update.content : {};
    const text = asString(content.text) ?? '';
    const messageId = asString(update.messageId);

    if (kind === 'user_message_chunk') {
      return applyUserText(state, text, messageId);
    }
    if (kind === 'agent_thought_chunk') {
      return appendText(state, 'reasoning', text, messageId);
    }
    if (kind === 'agent_message_chunk') {
      return appendText(state, 'text', text, messageId);
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      return projectTool(state, update);
    }
    if (kind === 'plan') {
      return { ...state, todos: normalizeTodos(update.entries) };
    }
    if (kind === 'plan_update') {
      const plan = isObject(update.plan) ? update.plan : update;
      if (asString(plan.type) !== 'items') return state;
      return { ...state, todos: normalizeTodos(plan.entries) };
    }
    if (kind === 'plan_removed') {
      return { ...state, todos: [] };
    }
    if (kind === 'config_option_update' && Array.isArray(update.configOptions)) {
      return {
        ...state,
        configOptions: update.configOptions.filter(isObject),
      };
    }
    if (
      kind === 'available_commands_update' &&
      Array.isArray(update.availableCommands)
    ) {
      return {
        ...state,
        availableCommands: update.availableCommands.filter(isObject),
      };
    }
    if (kind === 'current_mode_update') {
      return {
        ...state,
        currentModeId: asString(update.currentModeId),
      };
    }
    if (kind === 'session_info_update') {
      const { sessionUpdate: _sessionUpdate, type: _type, ...sessionInfo } = update;
      return { ...state, sessionInfo };
    }
    if (kind === 'usage_update') {
      const { sessionUpdate: _sessionUpdate, type: _type, ...usage } = update;
      return { ...state, usage };
    }
    return state;
  }

  if ('id' in envelope) {
    const id = String(envelope.id);
    const closed = {
      ...state,
      permissions: state.permissions.filter((item) => item.id !== id),
      questions: state.questions.filter((item) => item.id !== id),
    };
    return isObject(envelope.result) &&
      (asString(envelope.result.stopReason) || isObject(envelope.result.usage))
      ? finishPrompt(closed, envelope.result)
      : closed;
  }

  return state;
}
