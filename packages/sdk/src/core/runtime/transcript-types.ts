/**
 * The Kortix session transcript and event format, `kortix.transcript.v1`:
 * a message is `{ info, parts }`, streamed as `{ type, properties }` events.
 *
 * A copy of `packages/api-contract/src/transcript.ts`, which kortixd and
 * apps/api import. This package is published and cannot depend on that
 * private one; `transcript-types.test.ts` fails when the two copies differ
 * below this header.
 *
 * v1 keeps OpenCode 1.18's field names, so an OpenCode frame is a valid
 * Kortix frame. The names this SDK published before v1 (`Message`, `Part`,
 * `TextPart`, …) are aliases of these types in `runtime-types.ts`.
 */

export const KORTIX_TRANSCRIPT_SCHEMA = 'kortix.transcript.v1' as const;

// ─── Turn errors ─────────────────────────────────────────────────────────────

/**
 * Why a turn failed, as the daemon classifies it. Channels (Slack, Teams) pick
 * the message a user sees from it. `unknown` covers every failure without a
 * more specific code, including an abort nobody asked for.
 */
export const TURN_ERROR_CODES = [
  'auth',
  'rate_limit',
  'credits',
  'context_length',
  'output_length',
  'aborted',
  'unknown',
] as const;
export type TurnErrorCode = (typeof TURN_ERROR_CODES)[number];

export function isTurnErrorCode(value: unknown): value is TurnErrorCode {
  return typeof value === 'string' && (TURN_ERROR_CODES as readonly string[]).includes(value);
}

export type KortixProviderAuthError = {
  /** The daemon's classification. Absent on an error an older daemon wrote. */
  code?: TurnErrorCode;
  name: 'ProviderAuthError';
  data: { providerID: string; message: string };
};
export type KortixUnknownError = {
  /** The daemon's classification. Absent on an error an older daemon wrote. */
  code?: TurnErrorCode;
  name: 'UnknownError';
  data: { message: string; ref?: string; statusCode?: number };
};
export type KortixOutputLengthError = {
  /** The daemon's classification. Absent on an error an older daemon wrote. */
  code?: TurnErrorCode;
  name: 'MessageOutputLengthError';
  data: { [key: string]: unknown };
};
export type KortixAbortedError = {
  /** The daemon's classification. Absent on an error an older daemon wrote. */
  code?: TurnErrorCode;
  name: 'MessageAbortedError';
  data: { message: string };
};
export type KortixStructuredOutputError = {
  /** The daemon's classification. Absent on an error an older daemon wrote. */
  code?: TurnErrorCode;
  name: 'StructuredOutputError';
  data: { message: string; retries: number };
};
export type KortixContextOverflowError = {
  /** The daemon's classification. Absent on an error an older daemon wrote. */
  code?: TurnErrorCode;
  name: 'ContextOverflowError';
  data: { message: string; responseBody?: string };
};
export type KortixContentFilterError = {
  /** The daemon's classification. Absent on an error an older daemon wrote. */
  code?: TurnErrorCode;
  name: 'ContentFilterError';
  data: { message: string };
};
export type KortixApiError = {
  /** The daemon's classification. Absent on an error an older daemon wrote. */
  code?: TurnErrorCode;
  name: 'APIError';
  data: {
    message: string;
    statusCode?: number;
    isRetryable: boolean;
    responseHeaders?: { [key: string]: string };
    responseBody?: string;
    metadata?: { [key: string]: string };
  };
};
export type KortixMessageError =
  | KortixProviderAuthError
  | KortixUnknownError
  | KortixOutputLengthError
  | KortixAbortedError
  | KortixStructuredOutputError
  | KortixContextOverflowError
  | KortixContentFilterError
  | KortixApiError;

// ─── Messages ────────────────────────────────────────────────────────────────

export type KortixFileDiff = {
  file?: string;
  patch?: string;
  additions: number;
  deletions: number;
  status?: 'added' | 'deleted' | 'modified';
};

export type KortixTokenUsage = {
  total?: number;
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
};

export type KortixUserMessageInfo = {
  id: string;
  sessionID: string;
  role: 'user';
  time: { created: number };
  /** The structured-output format the prompt asked for. */
  format?: unknown;
  summary?: { title?: string; body?: string; diffs: KortixFileDiff[] };
  agent: string;
  model: { providerID: string; modelID: string; variant?: string };
  system?: string;
  tools?: { [key: string]: boolean };
};

export type KortixAssistantMessageInfo = {
  id: string;
  sessionID: string;
  role: 'assistant';
  time: { created: number; completed?: number };
  error?: KortixMessageError;
  /** The user message this reply answers. */
  parentID?: string;
  modelID: string;
  providerID: string;
  mode: string;
  agent: string;
  path: { cwd: string; root: string };
  summary?: boolean;
  cost: number;
  tokens: KortixTokenUsage;
  structured?: unknown;
  variant?: string;
  finish?: string;
};

export type KortixMessageInfo = KortixUserMessageInfo | KortixAssistantMessageInfo;

export type KortixMessage = {
  info: KortixMessageInfo;
  parts: KortixPart[];
};

// ─── Parts ───────────────────────────────────────────────────────────────────

export type KortixTextPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'text';
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
  time?: { start: number; end?: number };
  metadata?: { [key: string]: unknown };
};

export type KortixReasoningPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'reasoning';
  text: string;
  metadata?: { [key: string]: unknown };
  time: { start: number; end?: number };
};

export type KortixFilePartSourceText = {
  value: string;
  start: number;
  end: number;
};
export type KortixFilePartSource =
  | { type: 'file'; path: string; text: KortixFilePartSourceText }
  | {
      type: 'symbol';
      path: string;
      text: KortixFilePartSourceText;
      range: { start: { line: number; character: number }; end: { line: number; character: number } };
      name: string;
      kind: number;
    }
  | { type: 'resource'; clientName: string; uri: string; text: KortixFilePartSourceText };

export type KortixFilePart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'file';
  mime: string;
  filename?: string;
  url: string;
  source?: KortixFilePartSource;
};

export type KortixToolStatePending = {
  status: 'pending';
  input: { [key: string]: unknown };
  raw: string;
};
export type KortixToolStateRunning = {
  status: 'running';
  input: { [key: string]: unknown };
  title?: string;
  metadata?: { [key: string]: unknown };
  time: { start: number };
};
export type KortixToolStateCompleted = {
  status: 'completed';
  input: { [key: string]: unknown };
  output: string;
  title: string;
  metadata: { [key: string]: unknown };
  time: { start: number; end: number; compacted?: number };
  attachments?: KortixFilePart[];
};
export type KortixToolStateError = {
  status: 'error';
  input: { [key: string]: unknown };
  error: string;
  metadata?: { [key: string]: unknown };
  time: { start: number; end: number };
};
export type KortixToolState =
  | KortixToolStatePending
  | KortixToolStateRunning
  | KortixToolStateCompleted
  | KortixToolStateError;

export type KortixToolPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'tool';
  callID: string;
  tool: string;
  state: KortixToolState;
  metadata?: { [key: string]: unknown };
};

export type KortixStepStartPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'step-start';
  snapshot?: string;
};

export type KortixStepFinishPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'step-finish';
  reason: string;
  snapshot?: string;
  cost: number;
  tokens: KortixTokenUsage;
};

/** A review snapshot of the workspace. */
export type KortixSnapshotPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'snapshot';
  snapshot: string;
};

export type KortixPatchPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'patch';
  hash: string;
  files: string[];
};

export type KortixAgentPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'agent';
  name: string;
  source?: { value: string; start: number; end: number };
};

export type KortixRetryPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'retry';
  attempt: number;
  error: KortixApiError;
  time: { created: number };
};

export type KortixCompactionPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'compaction';
  auto: boolean;
  overflow?: boolean;
  tail_start_id?: string;
};

/**
 * OpenCode's `@agent` prompt input.
 * @deprecated OpenCode-only; no Kortix surface writes it. Removed with OpenCode.
 */
export type KortixSubtaskPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'subtask';
  prompt: string;
  description: string;
  agent: string;
  model?: { providerID: string; modelID: string };
  command?: string;
};

export type KortixPart =
  | KortixTextPart
  | KortixSubtaskPart
  | KortixReasoningPart
  | KortixFilePart
  | KortixToolPart
  | KortixStepStartPart
  | KortixStepFinishPart
  | KortixSnapshotPart
  | KortixPatchPart
  | KortixAgentPart
  | KortixRetryPart
  | KortixCompactionPart;

export type KortixPartType = KortixPart['type'];

// ─── Questions and permission requests ───────────────────────────────────────

/** The tool call an interaction belongs to. */
export type RuntimeToolRef = {
  messageID: string;
  callID: string;
};

export type RuntimeQuestionOption = {
  /** Display text, 1–5 words. */
  label: string;
  /** What choosing it means. */
  description: string;
};

export type RuntimeQuestion = {
  question: string;
  /** A short label, up to 30 characters. */
  header: string;
  options: RuntimeQuestionOption[];
  multiple?: boolean;
  custom?: boolean;
};

/** A question the agent asks, as `question.asked` carries it and apps/api stores it. */
export type RuntimeQuestionRequest = {
  id: string;
  sessionID: string;
  questions: RuntimeQuestion[];
  tool?: RuntimeToolRef;
};

/** One answer per question: the chosen option labels or free text. */
export type RuntimeQuestionAnswer = string[];

/**
 * A tool call waiting for approval. `permission` is a capability
 * (`RUNTIME_PERMISSION_CAPABILITIES`), `patterns` the subjects the call
 * touches (a command, a path).
 */
export type RuntimePermissionRequest = {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: { [key: string]: unknown };
  always: string[];
  tool?: RuntimeToolRef;
};

/** `once` allows this call, `always` allows the capability for the session, `reject` denies it. */
export const RUNTIME_PERMISSION_REPLIES = ['once', 'always', 'reject'] as const;
export type RuntimePermissionReply = (typeof RUNTIME_PERMISSION_REPLIES)[number];

/**
 * The capabilities a permission rule names. A harness maps each of its tool
 * names onto one of these: pi's `write` is `edit`, OpenCode's `pty_*` tools
 * are `bash`. They equal the manifest's permission keys.
 */
export const RUNTIME_PERMISSION_CAPABILITIES = [
  'read',
  'edit',
  'glob',
  'grep',
  'list',
  'bash',
  'task',
  'external_directory',
  'todowrite',
  'question',
  'webfetch',
  'websearch',
  'lsp',
  'doom_loop',
  'skill',
] as const;
export type RuntimePermissionCapability = (typeof RUNTIME_PERMISSION_CAPABILITIES)[number];

// ─── Events ──────────────────────────────────────────────────────────────────

export type KortixSessionStatus =
  | { type: 'idle' }
  | {
      type: 'retry';
      attempt: number;
      message: string;
      action?: { reason: string; provider: string; title: string; message: string; label: string; link?: string };
      next: number;
    }
  | { type: 'busy' };

export type KortixTodo = {
  content: string;
  status: string;
  priority: string;
};

/**
 * The events a session runtime streams, as `{ type, properties }`. A harness
 * may stream more (session tree, pty, lsp); a client ignores the types it does
 * not know.
 */
export type KortixSessionEvent =
  | { type: 'message.updated'; properties: { sessionID: string; info: KortixMessageInfo } }
  | { type: 'message.removed'; properties: { sessionID: string; messageID: string } }
  | { type: 'message.part.updated'; properties: { sessionID: string; part: KortixPart; time: number } }
  | { type: 'message.part.removed'; properties: { sessionID: string; messageID: string; partID: string } }
  | {
      /** Text appended to a part's `field` (`text`). The next `message.part.updated` carries the whole value. */
      type: 'message.part.delta';
      properties: { sessionID: string; messageID: string; partID: string; field: string; delta: string };
    }
  | { type: 'session.status'; properties: { sessionID: string; status: KortixSessionStatus } }
  | { type: 'session.idle'; properties: { sessionID: string } }
  | { type: 'session.error'; properties: { sessionID?: string; error?: KortixMessageError } }
  | { type: 'permission.asked'; properties: RuntimePermissionRequest }
  | {
      type: 'permission.replied';
      properties: { sessionID: string; requestID: string; reply: RuntimePermissionReply };
    }
  | { type: 'question.asked'; properties: RuntimeQuestionRequest }
  | {
      type: 'question.replied';
      properties: { sessionID: string; requestID: string; answers: RuntimeQuestionAnswer[] };
    }
  | { type: 'question.rejected'; properties: { sessionID: string; requestID: string } }
  | { type: 'todo.updated'; properties: { sessionID: string; todos: KortixTodo[] } };

export type KortixSessionEventType = KortixSessionEvent['type'];
