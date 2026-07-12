/**
 * Structural protocol types for the turn helpers — framework-agnostic.
 *
 * The turn functions are pure data transformations over runtime wire data.
 * They are typed against minimal structural ("Like") protocols instead of the
 * full generated harness types so every host can flow its own message/part
 * unions through unchanged: web passes the SDK runtime types, mobile passes its
 * lean local mirrors, and generics preserve the
 * caller's concrete types end to end.
 */

/** Minimal shape of any message part: a string discriminant. */
export interface PartLike {
  type: string;
}

/** Minimal shape of a message's `info` payload. */
export interface MessageInfoLike {
  id: string;
  role: string;
  parentID?: string;
  error?: unknown;
}

/** A message with its pre-resolved parts — the shape returned by `session.messages()`. */
export interface MessageWithPartsLike {
  info: MessageInfoLike;
  parts: PartLike[];
}

/**
 * A "turn" groups a user message with all its assistant responses.
 * Generic over the host's own message type so richer unions survive grouping.
 */
export interface TurnLike<M extends MessageWithPartsLike = MessageWithPartsLike> {
  userMessage: M;
  assistantMessages: M[];
}

/** A part paired with the message it belongs to. */
export interface PartWithMessage<M extends MessageWithPartsLike = MessageWithPartsLike> {
  part: M['parts'][number];
  message: M;
}

/** Minimal shape of a tool part's state. */
export interface ToolStateLike {
  status: 'pending' | 'running' | 'completed' | 'error';
  input?: Record<string, unknown>;
  output?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  error?: string;
}

/** Minimal shape of a tool part. */
export interface ToolPartLike {
  type: 'tool';
  tool: string;
  callID: string;
  state: ToolStateLike;
}

/** Minimal shape of a session status event. */
export interface SessionStatusLike {
  type: string;
}

/** Minimal shape of a permission/question request that references a tool call. */
export interface RequestWithToolLike {
  tool?: {
    messageID: string;
    callID: string;
  };
}

/** Token usage totals reported on step-finish parts and assistant messages. */
export interface TokenUsageLike {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

/** Per-1M-token pricing for a model, used to estimate costs when the wire reports zero. */
export interface ModelCostRates {
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M?: number;
}

export type ModelPricingLookup = (providerID: string, modelID: string) => ModelCostRates | null;

/** Icon + title + subtitle for a tool part, used in tool cards & task child summaries. */
export interface ToolInfo {
  icon: string;
  title: string;
  subtitle?: string;
}

/** Aggregated cost/token info for a turn. */
export interface TurnCostInfo {
  /** Total cost in USD */
  cost: number;
  /** Total tokens */
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

/** Retry state extracted from session status. */
export interface RetryInfo {
  attempt: number;
  message: string;
  /** When the retry will happen (unix ms) */
  next: number;
}

/** LSP diagnostic from tool metadata. */
export interface Diagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  message: string;
  severity?: number; // 1 = Error, 2 = Warning
}
