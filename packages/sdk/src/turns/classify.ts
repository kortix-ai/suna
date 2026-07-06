/**
 * Exhaustive part classification — the typed model a chat UI renders from.
 *
 * `@opencode-ai/sdk`'s `Part` union has 12 variants (text, subtask, reasoning,
 * file, tool, step-start, step-finish, snapshot, patch, agent, retry,
 * compaction). Before this module, hosts hand-rolled a `switch (part.type)`
 * over the raw wire shape, string-sniffed tool names, and silently dropped
 * whichever variants they hadn't gotten around to yet (subtask/patch/
 * snapshot/agent/retry/compaction, commonly). `classifyPart` normalizes every
 * variant into a `ClassifiedPart` with the fields a renderer actually needs,
 * with a compile-time exhaustiveness check (the `never` assertion in the
 * `default` branch) so a new opencode part type fails the build here instead
 * of silently rendering nothing — plus a runtime 'unknown' fallback so a
 * genuinely unrecognized value at runtime (e.g. an older client talking to a
 * newer server) degrades gracefully instead of throwing.
 *
 * Framework-free — no React/DOM imports. Typed against the concrete
 * `@opencode-ai/sdk` wire types (not the structural `*Like` protocols in
 * `./types`) because exhaustiveness checking only works against the real
 * closed union.
 */

import type {
  AgentPart,
  CompactionPart,
  FilePart,
  Part,
  PatchPart,
  ReasoningPart,
  RetryPart,
  SnapshotPart,
  StepFinishPart,
  StepStartPart,
  SubtaskPart,
  TextPart,
  ToolPart,
  ToolState,
} from '../opencode/client';
import type { MessageWithParts } from '../transcript';
import { unwrapError } from './errors';
import { toolInfo } from './tool-registry';
import type { TokenUsageLike } from './types';

// ============================================================================
// ToolView — normalized tool-part state machine
// ============================================================================

export type ToolStatus = 'pending' | 'running' | 'done' | 'error';

/** Normalized view of a tool part's state, independent of the wire's
 *  pending/running/completed/error status-union shape. */
export interface ToolView {
  name: string;
  title: string;
  status: ToolStatus;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  /**
   * `JSON.parse` of a string `output` when it parses as JSON; a non-string
   * output value passes through unchanged (defensive — the wire type is
   * always `string`, but nothing stops a future/plugin tool from handing
   * back a structured value directly). `undefined` when parsing fails or
   * there's no output. Bounded — strings over ~256KB are never parsed (a
   * huge blob is never meaningfully "structured" for view-model purposes,
   * and JSON.parse on it would be wasted work on every render).
   */
  outputParsed?: unknown;
  /** The raw output text, unconditionally — same value as `output` (kept as
   *  its own field so `outputParsed`/`outputText` read as a matched pair). */
  outputText?: string;
}

/** Never parse (or diff/pretty-print) an output blob larger than this — a
 *  cheap circuit breaker against pathological huge tool outputs. */
const MAX_PARSEABLE_OUTPUT_LENGTH = 256 * 1024;

function toolStatus(state: ToolState): ToolStatus {
  switch (state.status) {
    case 'pending':
      return 'pending';
    case 'running':
      return 'running';
    case 'completed':
      return 'done';
    case 'error':
      return 'error';
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

function parseToolOutput(rawOutput: string | undefined): {
  outputParsed?: unknown;
  outputText?: string;
} {
  if (rawOutput === undefined) return {};
  if (rawOutput.length > MAX_PARSEABLE_OUTPUT_LENGTH) return { outputText: rawOutput };
  try {
    return { outputParsed: JSON.parse(rawOutput), outputText: rawOutput };
  } catch {
    return { outputText: rawOutput };
  }
}

/**
 * Detect the "completed but actually failed" shape router/executor tools
 * (web_search, image_search, connector calls) commonly return: the wire's
 * `state.status` says `completed`, but the JSON output body itself carries
 * `success: false` or a top-level `error`. Without this, a real prod failure
 * (e.g. a 402 "Insufficient credits" from the search router) renders as a
 * successful tool call with raw JSON garbage inside.
 */
function detectEmbeddedFailure(outputParsed: unknown): string | undefined {
  if (typeof outputParsed !== 'object' || outputParsed === null || Array.isArray(outputParsed)) {
    return undefined;
  }
  const obj = outputParsed as Record<string, unknown>;
  const failedFlag = obj.success === false;
  const errorField = obj.error;
  const hasErrorField =
    (typeof errorField === 'string' && errorField.length > 0) ||
    (typeof errorField === 'object' && errorField !== null);
  if (!failedFlag && !hasErrorField) return undefined;

  if (hasErrorField) return unwrapError(errorField);
  if (typeof obj.message === 'string' && obj.message) return obj.message;
  return 'Tool reported failure';
}

function classifyToolState(tool: string, state: ToolState): ToolView {
  const liveTitle = 'title' in state ? state.title : undefined;
  const rawOutput = state.status === 'completed' ? state.output : undefined;
  const { outputParsed, outputText } = parseToolOutput(rawOutput);

  let status = toolStatus(state);
  let error = state.status === 'error' ? state.error : undefined;

  if (status === 'done') {
    const embeddedError = detectEmbeddedFailure(outputParsed);
    if (embeddedError) {
      status = 'error';
      error = embeddedError;
    }
  }

  return {
    name: tool,
    title: liveTitle || toolInfo(tool).label,
    status,
    input: state.input,
    output: rawOutput,
    outputParsed,
    outputText,
    error,
  };
}

// ============================================================================
// ClassifiedPart — one variant per opencode Part type, plus 'unknown'
// ============================================================================

export interface ClassifiedTextPart {
  kind: 'text';
  id: string;
  text: string;
  /** Synthetic text parts (e.g. shell-mode's synthetic user prompt) are
   *  wire-internal — hosts typically skip rendering them as chat bubbles. */
  synthetic: boolean;
}

export interface ClassifiedReasoningPart {
  kind: 'reasoning';
  id: string;
  text: string;
}

export interface ClassifiedToolPart {
  kind: 'tool';
  id: string;
  tool: ToolView;
}

export interface ClassifiedFilePart {
  kind: 'file';
  id: string;
  filename?: string;
  mime: string;
  url: string;
  /** Mirrors the `isAttachment()` check in index.ts — image/PDF parts are
   *  typically rendered inline, everything else as a filename marker. */
  isImage: boolean;
  isPdf: boolean;
}

export interface ClassifiedSubtaskPart {
  kind: 'subtask';
  id: string;
  description: string;
  agent: string;
  prompt: string;
  model?: { providerID: string; modelID: string };
}

export interface ClassifiedPatchPart {
  kind: 'patch';
  id: string;
  hash: string;
  files: string[];
  fileCount: number;
}

export interface ClassifiedSnapshotPart {
  kind: 'snapshot';
  id: string;
  snapshot: string;
}

export interface ClassifiedAgentPart {
  kind: 'agent';
  id: string;
  name: string;
}

export interface ClassifiedRetryPart {
  kind: 'retry';
  id: string;
  attempt: number;
  message: string;
  createdAt: number;
}

export interface ClassifiedCompactionPart {
  kind: 'compaction';
  id: string;
  auto: boolean;
  overflow: boolean;
  tailStartId?: string;
}

export interface ClassifiedStepPart {
  kind: 'step';
  id: string;
  phase: 'start' | 'finish';
  snapshot?: string;
  /** step-finish only. */
  reason?: string;
  cost?: number;
  tokens?: TokenUsageLike;
}

/** Forward-compat fallback for any part type this module doesn't know about
 *  yet (version skew between client and server). `raw` is the untouched
 *  wire value so a host can still attempt best-effort handling. */
export interface ClassifiedUnknownPart {
  kind: 'unknown';
  raw: unknown;
}

export type ClassifiedPart =
  | ClassifiedTextPart
  | ClassifiedReasoningPart
  | ClassifiedToolPart
  | ClassifiedFilePart
  | ClassifiedSubtaskPart
  | ClassifiedPatchPart
  | ClassifiedSnapshotPart
  | ClassifiedAgentPart
  | ClassifiedRetryPart
  | ClassifiedCompactionPart
  | ClassifiedStepPart
  | ClassifiedUnknownPart;

function classifyText(part: TextPart): ClassifiedTextPart {
  return { kind: 'text', id: part.id, text: part.text, synthetic: !!part.synthetic };
}

function classifyReasoning(part: ReasoningPart): ClassifiedReasoningPart {
  return { kind: 'reasoning', id: part.id, text: part.text };
}

function classifyTool(part: ToolPart): ClassifiedToolPart {
  return { kind: 'tool', id: part.id, tool: classifyToolState(part.tool, part.state) };
}

function classifyFile(part: FilePart): ClassifiedFilePart {
  const mime = part.mime;
  return {
    kind: 'file',
    id: part.id,
    filename: part.filename,
    mime,
    url: part.url,
    isImage: mime.startsWith('image/'),
    isPdf: mime === 'application/pdf',
  };
}

function classifySubtask(part: SubtaskPart): ClassifiedSubtaskPart {
  return {
    kind: 'subtask',
    id: part.id,
    description: part.description,
    agent: part.agent,
    prompt: part.prompt,
    model: part.model,
  };
}

function classifyPatch(part: PatchPart): ClassifiedPatchPart {
  return {
    kind: 'patch',
    id: part.id,
    hash: part.hash,
    files: part.files,
    fileCount: part.files.length,
  };
}

function classifySnapshot(part: SnapshotPart): ClassifiedSnapshotPart {
  return { kind: 'snapshot', id: part.id, snapshot: part.snapshot };
}

function classifyAgent(part: AgentPart): ClassifiedAgentPart {
  return { kind: 'agent', id: part.id, name: part.name };
}

function classifyRetry(part: RetryPart): ClassifiedRetryPart {
  return {
    kind: 'retry',
    id: part.id,
    attempt: part.attempt,
    message: unwrapError(part.error),
    createdAt: part.time.created,
  };
}

function classifyCompaction(part: CompactionPart): ClassifiedCompactionPart {
  return {
    kind: 'compaction',
    id: part.id,
    auto: part.auto,
    overflow: !!part.overflow,
    tailStartId: part.tail_start_id,
  };
}

function classifyStepStart(part: StepStartPart): ClassifiedStepPart {
  return { kind: 'step', id: part.id, phase: 'start', snapshot: part.snapshot };
}

function classifyStepFinish(part: StepFinishPart): ClassifiedStepPart {
  return {
    kind: 'step',
    id: part.id,
    phase: 'finish',
    snapshot: part.snapshot,
    reason: part.reason,
    cost: part.cost,
    tokens: part.tokens,
  };
}

/**
 * Classify a single opencode message part into a `ClassifiedPart`.
 *
 * The `default` branch's `const _exhaustive: never = part` line is a
 * compile-time guard: if opencode's `Part` union grows a new variant and this
 * switch isn't updated to handle it, this file fails to typecheck. At
 * runtime, a value that doesn't match any known `type` (version skew) falls
 * through to `{ kind: 'unknown', raw: part }` instead of throwing.
 */
export function classifyPart(part: Part): ClassifiedPart {
  switch (part.type) {
    case 'text':
      return classifyText(part);
    case 'reasoning':
      return classifyReasoning(part);
    case 'tool':
      return classifyTool(part);
    case 'file':
      return classifyFile(part);
    case 'subtask':
      return classifySubtask(part);
    case 'patch':
      return classifyPatch(part);
    case 'snapshot':
      return classifySnapshot(part);
    case 'agent':
      return classifyAgent(part);
    case 'retry':
      return classifyRetry(part);
    case 'compaction':
      return classifyCompaction(part);
    case 'step-start':
      return classifyStepStart(part);
    case 'step-finish':
      return classifyStepFinish(part);
    default: {
      const _exhaustive: never = part;
      return { kind: 'unknown', raw: _exhaustive };
    }
  }
}

// ============================================================================
// classifyTurn — turn-level part classification + error normalization
// ============================================================================

/** Normalized turn-level error — the "failed turn renders as silence" bug
 *  class, solved once here instead of in every host's renderer. */
export interface TurnError {
  name: string;
  message: string;
}

function normalizeTurnError(error: unknown): TurnError | undefined {
  if (!error) return undefined;
  // (`!error` above already excludes null — no separate null check needed.)
  const name =
    typeof error === 'object' &&
    'name' in error &&
    typeof (error as { name?: unknown }).name === 'string'
      ? (error as { name: string }).name
      : 'Error';
  return { name, message: unwrapError(error) };
}

/** Whether a classified part renders any visible content on its own — used
 *  to compute `isEmpty` below. step/snapshot markers with no sibling content
 *  don't count; a lone empty text/reasoning part doesn't either. */
function partHasContent(part: ClassifiedPart): boolean {
  switch (part.kind) {
    case 'text':
    case 'reasoning':
      return part.text.trim().length > 0;
    case 'step':
      return false;
    default:
      return true;
  }
}

export interface ClassifiedTurn {
  parts: ClassifiedPart[];
  error?: TurnError;
  /** True when the turn has no error and no part with visible content — the
   *  case that used to render as silent nothingness. */
  isEmpty: boolean;
}

/**
 * Classify every part of a message and normalize its error (assistant
 * messages only carry `info.error`; user messages never do).
 */
export function classifyTurn(message: MessageWithParts): ClassifiedTurn {
  const parts = message.parts.map(classifyPart);
  const rawError = message.info.role === 'assistant' ? message.info.error : undefined;
  const error = normalizeTurnError(rawError);
  const isEmpty = !error && !parts.some(partHasContent);
  return { parts, error, isEmpty };
}
