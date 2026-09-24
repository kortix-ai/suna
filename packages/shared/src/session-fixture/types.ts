/**
 * Structural wire types for the session parity fixture.
 *
 * `@kortix/shared` does not depend on `@kortix/sdk`, so these types mirror the
 * OpenCode v2 wire shapes (`@opencode-ai/sdk/v2` `Message`, `Part`,
 * `SessionStatus`, `QuestionRequest`, `PermissionRequest`) field for field.
 * They carry every REQUIRED field of the SDK types, so a fixture value is
 * assignable to the SDK types. `apps/mobile/lib/debug/session-fixture.types.test.ts`
 * proves that assignment under the mobile `tsc` gate.
 */

// ─── Messages ────────────────────────────────────────────────────────────────

export interface FixtureModelRef {
  providerID: string;
  modelID: string;
}

export interface FixtureUserMessage {
  id: string;
  sessionID: string;
  role: 'user';
  time: { created: number };
  agent: string;
  model: FixtureModelRef & { variant?: string };
}

export interface FixtureTokens {
  total?: number;
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

export type FixtureMessageError =
  | { name: 'ProviderAuthError'; data: { providerID: string; message: string } }
  | { name: 'UnknownError'; data: { message: string; ref?: string } }
  | { name: 'MessageAbortedError'; data: { message: string } }
  | { name: 'ContextOverflowError'; data: { message: string; responseBody?: string } }
  | {
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

export interface FixtureAssistantMessage {
  id: string;
  sessionID: string;
  role: 'assistant';
  time: { created: number; completed?: number };
  error?: FixtureMessageError;
  parentID: string;
  modelID: string;
  providerID: string;
  mode: string;
  agent: string;
  path: { cwd: string; root: string };
  summary?: boolean;
  cost: number;
  tokens: FixtureTokens;
  variant?: string;
  finish?: string;
}

export type FixtureMessage = FixtureUserMessage | FixtureAssistantMessage;

// ─── Parts ───────────────────────────────────────────────────────────────────

interface FixturePartBase {
  id: string;
  sessionID: string;
  messageID: string;
}

export interface FixtureTextPart extends FixturePartBase {
  type: 'text';
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
  time?: { start: number; end?: number };
  metadata?: { [key: string]: unknown };
}

export interface FixtureReasoningPart extends FixturePartBase {
  type: 'reasoning';
  text: string;
  metadata?: { [key: string]: unknown };
  time: { start: number; end?: number };
}

export interface FixtureFilePart extends FixturePartBase {
  type: 'file';
  mime: string;
  filename?: string;
  url: string;
}

export interface FixtureToolStatePending {
  status: 'pending';
  input: { [key: string]: unknown };
  raw: string;
}

export interface FixtureToolStateRunning {
  status: 'running';
  input: { [key: string]: unknown };
  title?: string;
  metadata?: { [key: string]: unknown };
  time: { start: number };
}

export interface FixtureToolStateCompleted {
  status: 'completed';
  input: { [key: string]: unknown };
  output: string;
  title: string;
  metadata: { [key: string]: unknown };
  time: { start: number; end: number; compacted?: number };
}

export interface FixtureToolStateError {
  status: 'error';
  input: { [key: string]: unknown };
  error: string;
  metadata?: { [key: string]: unknown };
  time: { start: number; end: number };
}

export type FixtureToolState =
  | FixtureToolStatePending
  | FixtureToolStateRunning
  | FixtureToolStateCompleted
  | FixtureToolStateError;

export type FixtureToolStatus = FixtureToolState['status'];

export interface FixtureToolPart extends FixturePartBase {
  type: 'tool';
  callID: string;
  tool: string;
  state: FixtureToolState;
  metadata?: { [key: string]: unknown };
}

export interface FixtureSubtaskPart extends FixturePartBase {
  type: 'subtask';
  prompt: string;
  description: string;
  agent: string;
  model?: FixtureModelRef;
  command?: string;
}

export interface FixtureStepStartPart extends FixturePartBase {
  type: 'step-start';
  snapshot?: string;
}

export interface FixtureStepFinishPart extends FixturePartBase {
  type: 'step-finish';
  reason: string;
  snapshot?: string;
  cost: number;
  tokens: FixtureTokens;
}

export interface FixtureSnapshotPart extends FixturePartBase {
  type: 'snapshot';
  snapshot: string;
}

export interface FixturePatchPart extends FixturePartBase {
  type: 'patch';
  hash: string;
  files: string[];
}

export interface FixtureAgentPart extends FixturePartBase {
  type: 'agent';
  name: string;
  source?: { value: string; start: number; end: number };
}

export interface FixtureRetryPart extends FixturePartBase {
  type: 'retry';
  attempt: number;
  error: Extract<FixtureMessageError, { name: 'APIError' }>;
  time: { created: number };
}

export interface FixtureCompactionPart extends FixturePartBase {
  type: 'compaction';
  auto: boolean;
  overflow?: boolean;
  tail_start_id?: string;
}

export type FixturePart =
  | FixtureTextPart
  | FixtureSubtaskPart
  | FixtureReasoningPart
  | FixtureFilePart
  | FixtureToolPart
  | FixtureStepStartPart
  | FixtureStepFinishPart
  | FixtureSnapshotPart
  | FixturePatchPart
  | FixtureAgentPart
  | FixtureRetryPart
  | FixtureCompactionPart;

export type FixturePartType = FixturePart['type'];

export interface FixtureMessageWithParts {
  info: FixtureMessage;
  parts: FixturePart[];
}

// ─── Session-level state ─────────────────────────────────────────────────────

export type FixtureSessionStatus =
  | { type: 'idle' }
  | { type: 'busy' }
  | { type: 'retry'; attempt: number; message: string; next: number };

export interface FixtureQuestionRequest {
  id: string;
  sessionID: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiple?: boolean;
    custom?: boolean;
  }>;
  tool?: { messageID: string; callID: string };
}

export interface FixturePermissionRequest {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: { [key: string]: unknown };
  always: string[];
  tool?: { messageID: string; callID: string };
}

// ─── Declarative tool specs ──────────────────────────────────────────────────

/**
 * One representative call of one web tool renderer. The assembly
 * (`session.ts`) expands a spec into one tool part per state in `states`.
 */
export interface FixtureToolSpec {
  /** The apps/web renderer file this call exercises, e.g. `bash-tool.tsx`. */
  renderer: string;
  /** Wire tool name, exactly as registered (`bash`, `oc-trigger_create`, …). */
  tool: string;
  /** Tool input for the running, completed, and error states. */
  input: { [key: string]: unknown };
  /** Completed-state output. Structured outputs are `JSON.stringify`-ed, as on the wire. */
  output: string;
  /** Completed-state title. Default: the tool name. */
  title?: string;
  /** Completed-state metadata. Default: `{}`. */
  metadata?: { [key: string]: unknown };
  /** Running-state title. */
  runningTitle?: string;
  /** Running-state metadata (streamed partial output, child session id, …). */
  runningMetadata?: { [key: string]: unknown };
  /** Error-state message, as the runtime writes it. */
  error: string;
  /** Wall time of the completed / error call. Default: 1200 ms. */
  durationMs?: number;
  /** States to emit. Default: all four. */
  states?: ReadonlyArray<FixtureToolStatus>;
  /** Why this call exists (alias with a different input shape, embedded failure, …). */
  note?: string;
}

/**
 * A child session a tool call points at (task, agent_spawn, session_spawn).
 * The assembly builds one user prompt and one assistant reply from it and
 * exports the result in `SessionFixture.childSessions`.
 */
export interface FixtureChildSessionSpec {
  /** Must match `/^ses_[A-Za-z0-9]+$/` — the SDK's child-id regex. */
  id: string;
  title: string;
  prompt: string;
  /** Completed tool calls of the child. Only the completed state is emitted. */
  tools: FixtureToolSpec[];
  /** The child's final answer. Empty while `running`. */
  reply: string;
  /** Default: `completed`. `running` leaves the assistant message open. */
  status?: 'completed' | 'running' | 'error';
  /** Error text when `status` is `error`. */
  error?: string;
}

/** One group of tool specs, rendered as one settled turn. */
export interface FixtureToolGroup {
  /** Stable key, e.g. `files`. */
  key: string;
  /** The user prompt that opens the turn. */
  prompt: string;
  /** Reasoning shown before the calls. */
  reasoning: string;
  /** Closing assistant text after the calls. */
  summary: string;
  specs: FixtureToolSpec[];
  childSessions?: FixtureChildSessionSpec[];
}

// ─── The assembled fixture ───────────────────────────────────────────────────

export type FixtureQueueState = 'queued' | 'interrupted';

export interface SessionFixture {
  sessionId: string;
  title: string;
  /** Every message of the root session, in display order. */
  messages: FixtureMessageWithParts[];
  /** Child sessions keyed by session id. Seed them into the sync store too. */
  childSessions: Record<string, FixtureMessageWithParts[]>;
  /** Session status per child session id: `busy` for a running child, else `idle`. */
  childStatuses: Record<string, FixtureSessionStatus>;
  /**
   * The working turn: its user message id, the session status it reads
   * (`busy`), and the alternate `retry` status a host can switch to.
   */
  working: {
    userMessageId: string;
    status: Extract<FixtureSessionStatus, { type: 'busy' }>;
    retryStatus: Extract<FixtureSessionStatus, { type: 'retry' }>;
  };
  /** Queue state per user message id (interrupted before a run, or queued behind the working turn). */
  queueStates: Record<string, FixtureQueueState>;
  /** Pending question requests of the root session (the unanswered question). */
  questions: FixtureQuestionRequest[];
  /** Pending permission requests of the root session. */
  permissions: FixturePermissionRequest[];
  /** Agent names the user message mentions resolve against. */
  agentNames: string[];
  /** Every web renderer file and tool name the fixture exercises, with the states emitted. */
  toolCoverage: FixtureToolCoverage[];
}

export interface FixtureToolCoverage {
  renderer: string;
  tool: string;
  states: FixtureToolStatus[];
}
