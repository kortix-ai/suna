/**
 * Turn/session-level derived state — working/idle, response visibility,
 * error text, status text, duration/cost/token formatting, retry info, and
 * diff presence. Everything here answers "what state is this turn/session
 * in", as opposed to `parts.ts` (single-part helpers) or `grouping.ts`
 * (assembling turns/parts from raw messages).
 *
 * Split out of `turns/index.ts` — see that file's history for the original
 * single-file version. No React / DOM / framework imports allowed.
 */

import type {
  MessageInfoLike,
  MessageWithPartsLike,
  ModelCostRates,
  ModelPricingLookup,
  PartLike,
  PartWithMessage,
  RetryInfo,
  SessionStatusLike,
  ToolPartLike,
  TokenUsageLike,
  TurnCostInfo,
  TurnLike,
} from './types';
import { unwrapError } from './errors';
import { isReasoningPart, isTextPart, isToolPart } from './parts';

// ============================================================================
// Internal wire shapes (structural casts, never exported)
// ============================================================================

interface ReasoningPartLike extends PartLike {
  type: 'reasoning';
  text?: string;
}

interface StepFinishPartLike extends PartLike {
  type: 'step-finish';
  cost?: number;
  tokens?: TokenUsageLike;
}

interface AssistantInfoLike extends MessageInfoLike {
  providerID?: string;
  modelID?: string;
  tokens?: TokenUsageLike;
}

interface RetryStatusLike extends SessionStatusLike {
  attempt: number;
  message: string;
  next: number;
}

// ============================================================================
// Working state
// ============================================================================

/** Check if this is the last user message in the session. */
export function isLastUserMessage(
  messageId: string,
  allMessages: readonly MessageWithPartsLike[],
): boolean {
  for (let i = allMessages.length - 1; i >= 0; i--) {
    if (allMessages[i].info.role === 'user') {
      return allMessages[i].info.id === messageId;
    }
  }
  return false;
}

/** Derive the "working" state for a turn. Only the last turn shows as working. */
export function getWorkingState(
  sessionStatus: SessionStatusLike | undefined,
  isLast: boolean,
): boolean {
  if (!isLast) return false;
  if (!sessionStatus) return false;
  return sessionStatus.type !== 'idle';
}

// ============================================================================
// Response part separation
// ============================================================================

/**
 * Whether the last text part (the "response") should be extracted from the
 * steps list and shown separately in the Response section.
 *
 * Matches SolidJS session-turn.tsx:440-443
 */
export function shouldHideResponsePart(
  working: boolean,
  responsePartId: string | undefined,
): boolean {
  return !working && !!responsePartId;
}

// ============================================================================
// Error extraction — with deep JSON unwrapping
// ============================================================================

/** Extract error message from assistant messages in a turn. */
export function getTurnError(turn: TurnLike): string | undefined {
  for (const msg of turn.assistantMessages) {
    const info = msg.info;
    if (info.error) {
      return unwrapError(info.error);
    }
  }
  return undefined;
}

// ============================================================================
// Status text computation
// ============================================================================

/**
 * Derive human-readable status from a part.
 * Matches SolidJS computeStatusFromPart — session-turn.tsx:83-119
 */
export function computeStatusFromPart(part: PartLike | undefined): string | undefined {
  if (!part) return undefined;

  if (isToolPart(part)) {
    switch ((part as PartLike as ToolPartLike).tool) {
      case 'task':
      case 'session_spawn':
      case 'session_start_background':
      case 'session-spawn':
      case 'session-start-background':
        return 'Delegating to agent...';
      case 'agent_spawn':
      case 'agent-spawn':
      case 'agent_task':
      case 'agent-task':
        return 'Delegating to agent...';
      case 'agent_task_update':
      case 'agent-task-update':
      case 'task_update':
      case 'task-update':
        return 'Updating task...';
      case 'agent_message':
      case 'agent-message':
      case 'agent_task_message':
      case 'agent-task-message':
      case 'task_message':
      case 'task-message':
        return 'Messaging agent...';
      case 'task_create':
      case 'task-create':
      case 'task_start':
      case 'task-start':
        return 'Creating task...';
      case 'task_list':
      case 'task-list':
        return 'Listing tasks...';
      case 'task_done':
      case 'task-done':
        return 'Updating task...';
      case 'todowrite':
      case 'todoread':
        return 'Planning...';
      case 'read':
        return 'Gathering context...';
      case 'list':
      case 'grep':
      case 'glob':
        return 'Searching codebase...';
      case 'webfetch':
      case 'scrape-webpage':
        return 'Fetching web page...';
      case 'websearch':
      case 'web-search':
      case 'web_search':
        return 'Searching web...';
      case 'image-search':
        return 'Searching images...';
      case 'image-gen':
        return 'Generating image...';
      case 'video-gen':
        return 'Generating video...';
      case 'presentation-gen':
        return 'Creating presentation...';
      case 'show':
      case 'show-user':
        return 'Showing output...';
      case 'edit':
      case 'write':
      case 'morph_edit':
        return 'Making edits...';
      case 'bash':
        return 'Running commands...';
      case 'apply_patch':
        return 'Applying patches...';
      case 'prune':
        return 'Pruning context...';
      case 'distill':
        return 'Distilling context...';
      case 'compress':
        return 'Compressing context...';
      case 'context_info':
        return 'Updating context info...';
      default:
        return `Running ${(part as PartLike as ToolPartLike).tool}...`;
    }
  }

  if (isReasoningPart(part)) {
    const text = (part as PartLike as ReasoningPartLike).text?.trimStart();
    if (text) {
      const match = text.match(/^\*\*(.+?)\*\*/);
      if (match) return `Thinking about ${match[1].trim()}...`;
    }
    return 'Thinking...';
  }

  if (isTextPart(part)) return 'Gathering thoughts...';
  return undefined;
}

/**
 * Get status text for a turn, with child session delegation.
 *
 * Matches SolidJS rawStatus — session-turn.tsx:381-428
 * When the last part is a running `task` tool, drills into the child session
 * to derive the real status.
 */
export function getTurnStatus(
  parts: ReadonlyArray<{ part: PartLike }>,
  childMessages?: readonly MessageWithPartsLike[],
): string {
  // Scan parts in reverse for the last meaningful status
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i].part;

    // If it's a running task orchestration tool, try to get status from child session
    const tp = isToolPart(p) ? (p as PartLike as ToolPartLike) : undefined;
    if (
      tp &&
      (tp.tool === 'task' ||
        tp.tool === 'agent_task' ||
        tp.tool === 'agent-task' ||
        tp.tool === 'task_create' ||
        tp.tool === 'task-create' ||
        tp.tool === 'task_start' ||
        tp.tool === 'task-start') &&
      tp.state.status === 'running' &&
      childMessages &&
      childMessages.length > 0
    ) {
      // Walk child session messages in reverse to find status
      for (let mi = childMessages.length - 1; mi >= 0; mi--) {
        const childMsg = childMessages[mi];
        if (childMsg.info.role !== 'assistant') continue;
        for (let pi = childMsg.parts.length - 1; pi >= 0; pi--) {
          const childStatus = computeStatusFromPart(childMsg.parts[pi]);
          if (childStatus) return childStatus;
        }
      }
      // Fall through to parent status
      return 'Delegating to agent...';
    }

    const s = computeStatusFromPart(p);
    if (s) return s;
  }
  return 'Considering next steps...';
}

// ============================================================================
// Duration formatting
// ============================================================================

export function formatDuration(ms: number): string {
  // Sub-second durations are noise — skip the badge entirely. Callers
  // should conditionally render based on whether the returned string is
  // non-empty, so nothing visible changes when a tool returns in 200ms.
  if (!Number.isFinite(ms) || ms < 1000) return '';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return secs > 0 ? `${minutes}m ${secs}s` : `${minutes}m`;
}

// ============================================================================
// Cost & Token helpers
// ============================================================================

/**
 * Platform markup applied to raw provider costs.
 *
 * The step-finish parts report raw provider cost (what the LLM vendor charges).
 * The billing system deducts cost × COST_MARKUP from the user's credits.
 * We apply the same multiplier here so the UI matches what's actually billed.
 *
 * Must stay in sync with KORTIX_MARKUP in apps/api/src/config.ts.
 */
export const COST_MARKUP = 1.2;

function estimateTokenCost(tokens: TokenUsageLike | undefined, rates: ModelCostRates): number {
  if (!tokens) return 0;
  const input = tokens.input ?? 0;
  const output = (tokens.output ?? 0) + (tokens.reasoning ?? 0);
  const cacheRead = tokens.cache?.read ?? 0;
  const cacheWrite = tokens.cache?.write ?? 0;
  const regularInput = Math.max(0, input - cacheRead - cacheWrite);

  let cost = (regularInput / 1_000_000) * rates.inputPer1M;
  cost += (output / 1_000_000) * rates.outputPer1M;
  if (cacheRead > 0) {
    cost += (cacheRead / 1_000_000) * (rates.cacheReadPer1M ?? rates.inputPer1M);
  }
  if (cacheWrite > 0) {
    cost += (cacheWrite / 1_000_000) * rates.inputPer1M;
  }
  return cost;
}

function stepFinishRawCost(
  sfp: StepFinishPartLike,
  providerID: string | undefined,
  modelID: string | undefined,
  lookup?: ModelPricingLookup,
): number {
  const reported = sfp.cost || 0;
  if (reported > 0) return reported;
  if (!lookup || !providerID || !modelID) return 0;
  const rates = lookup(providerID, modelID);
  if (!rates) return 0;
  return estimateTokenCost(sfp.tokens, rates);
}

function assistantMessageIds(message: MessageInfoLike): {
  providerID?: string;
  modelID?: string;
} {
  if (message.role !== 'assistant') return {};
  const assistant = message as AssistantInfoLike;
  return { providerID: assistant.providerID, modelID: assistant.modelID };
}

/**
 * Aggregate cost/token info from step-finish parts in a turn.
 * Returns undefined if no step-finish parts found.
 *
 * The cost is multiplied by COST_MARKUP so the displayed value matches
 * the actual credits deducted (raw provider cost × 1.2).
 */
export function getTurnCost(
  parts: ReadonlyArray<PartWithMessage>,
  lookup?: ModelPricingLookup,
): TurnCostInfo | undefined {
  let totalCost = 0;
  let input = 0;
  let output = 0;
  let reasoning = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let found = false;

  for (const { part, message } of parts) {
    if (part.type === 'step-finish') {
      found = true;
      const sfp = part as StepFinishPartLike;
      const { providerID, modelID } = assistantMessageIds(message.info);
      totalCost += stepFinishRawCost(sfp, providerID, modelID, lookup);
      input += sfp.tokens?.input || 0;
      output += sfp.tokens?.output || 0;
      reasoning += sfp.tokens?.reasoning || 0;
      cacheRead += sfp.tokens?.cache?.read || 0;
      cacheWrite += sfp.tokens?.cache?.write || 0;
    }
  }

  if (!found) {
    for (const { message } of parts) {
      if (message.info.role !== 'assistant') continue;
      const assistant = message.info as AssistantInfoLike;
      const stepCost = assistantTokensCost(assistant, lookup);
      if (stepCost <= 0) continue;
      found = true;
      totalCost += stepCost;
      const t = assistant.tokens;
      if (t) {
        input += t.input ?? 0;
        output += t.output ?? 0;
        reasoning += t.reasoning ?? 0;
        cacheRead += t.cache?.read ?? 0;
        cacheWrite += t.cache?.write ?? 0;
      }
    }
  }

  if (!found) return undefined;
  return {
    cost: totalCost * COST_MARKUP,
    tokens: { input, output, reasoning, cacheRead, cacheWrite },
  };
}

function assistantTokensCost(assistant: AssistantInfoLike, lookup?: ModelPricingLookup): number {
  if (!lookup || !assistant.providerID || !assistant.modelID || !assistant.tokens) return 0;
  const rates = lookup(assistant.providerID, assistant.modelID);
  if (!rates) return 0;
  return estimateTokenCost(
    {
      input: assistant.tokens.input,
      output: assistant.tokens.output,
      reasoning: assistant.tokens.reasoning,
      cache: assistant.tokens.cache,
    },
    rates,
  );
}

/**
 * Aggregate billed cost for an entire session from step-finish parts.
 * Matches per-turn `getTurnCost` and mobile session stats aggregation.
 */
export function getSessionCost(
  messages: ReadonlyArray<{ info?: MessageInfoLike; parts: PartLike[] }>,
  lookup?: ModelPricingLookup,
): number {
  let totalCost = 0;
  for (const msg of messages) {
    if (msg.info?.role !== 'assistant') continue;
    const assistant = msg.info as AssistantInfoLike;
    const { providerID, modelID } = assistantMessageIds(assistant);

    let msgCost = 0;
    let sawStepFinish = false;
    for (const part of msg.parts) {
      if (part.type !== 'step-finish') continue;
      sawStepFinish = true;
      msgCost += stepFinishRawCost(part as StepFinishPartLike, providerID, modelID, lookup);
    }

    if (!sawStepFinish) {
      msgCost += assistantTokensCost(assistant, lookup);
    }

    totalCost += msgCost;
  }
  return totalCost * COST_MARKUP;
}

/** Format cost in USD (e.g. "$0.0032") */
export function formatCost(cost: number): string {
  if (cost === 0) return '$0.00';
  if (cost < 0.001) return `$${cost.toFixed(4)}`;
  if (cost < 0.01) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

/** Format token count (e.g. "12.3k") */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 10000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${Math.round(tokens / 1000)}k`;
}

// ============================================================================
// Retry helpers
// ============================================================================

/**
 * Extract retry info from session status.
 * Truncates message to 60 chars matching SolidJS session-turn.tsx:695
 */
export function getRetryInfo(status: SessionStatusLike | undefined): RetryInfo | undefined {
  if (!status || status.type !== 'retry') return undefined;
  const retry = status as RetryStatusLike;
  return {
    attempt: retry.attempt,
    message: retry.message.length > 60 ? `${retry.message.slice(0, 60)}...` : retry.message,
    next: retry.next,
  };
}

/**
 * Extract the full retry error message from session status (not truncated).
 */
export function getRetryMessage(status: SessionStatusLike | undefined): string | undefined {
  if (!status || status.type !== 'retry') return undefined;
  return unwrapError((status as RetryStatusLike).message);
}

// ============================================================================
// hasDiffs check
// ============================================================================

/** Check if a user message has associated file diffs. */
export function hasDiffs(userMessage: MessageWithPartsLike): boolean {
  const summary = (userMessage.info as { summary?: { diffs?: unknown[] } }).summary;
  return (summary?.diffs?.length ?? 0) > 0;
}
