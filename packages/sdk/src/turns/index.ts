/**
 * Turn grouping & part helpers — framework-agnostic.
 *
 * Pure functions that transform SDK message data into view-model shapes.
 * Single implementation shared by the web and mobile UIs.
 *
 * IMPORTANT: No React / DOM / framework imports allowed in this module.
 * Matches the SolidJS reference in opencode/packages/ui/src/components/session-turn.tsx
 */

import type {
  Diagnostic,
  MessageInfoLike,
  MessageWithPartsLike,
  ModelCostRates,
  ModelPricingLookup,
  PartLike,
  PartWithMessage,
  RequestWithToolLike,
  RetryInfo,
  SessionStatusLike,
  TokenUsageLike,
  ToolInfo,
  ToolPartLike,
  TurnCostInfo,
  TurnLike,
} from './types';

export type * from './types';

// ============================================================================
// Internal wire shapes (structural casts, never exported)
// ============================================================================

interface TextPartLike extends PartLike {
  type: 'text';
  text?: string;
  synthetic?: boolean;
}

interface ReasoningPartLike extends PartLike {
  type: 'reasoning';
  text?: string;
}

interface FilePartLike extends PartLike {
  type: 'file';
  mime: string;
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
// Type guards
// ============================================================================

export function isTextPart<P extends PartLike>(part: P): part is P & { type: 'text' } {
  return part.type === 'text';
}

export function isReasoningPart<P extends PartLike>(part: P): part is P & { type: 'reasoning' } {
  return part.type === 'reasoning';
}

export function isToolPart<P extends PartLike>(part: P): part is P & { type: 'tool' } {
  return part.type === 'tool';
}

export function isFilePart<P extends PartLike>(part: P): part is P & { type: 'file' } {
  return part.type === 'file';
}

export function isAgentPart<P extends PartLike>(part: P): part is P & { type: 'agent' } {
  return part.type === 'agent';
}

export function isCompactionPart<P extends PartLike>(part: P): part is P & { type: 'compaction' } {
  return part.type === 'compaction';
}

export function isSnapshotPart<P extends PartLike>(part: P): part is P & { type: 'snapshot' } {
  return part.type === 'snapshot';
}

export function isPatchPart<P extends PartLike>(part: P): part is P & { type: 'patch' } {
  return part.type === 'patch';
}

/** Get the text content from any part that has a `text` field. */
export function getPartText(part: PartLike): string | undefined {
  if (isTextPart(part)) return (part as TextPartLike).text;
  if (isReasoningPart(part)) return (part as ReasoningPartLike).text;
  return undefined;
}

// ============================================================================
// Attachment helpers (images, PDFs)
// ============================================================================

/**
 * Check if a file part is an image or PDF attachment.
 * Matches SolidJS `isAttachment()` — session-turn.tsx:128
 */
export function isAttachment<P extends PartLike>(part: P): part is P & { type: 'file' } {
  if (!isFilePart(part)) return false;
  const mime = (part as PartLike as FilePartLike).mime;
  return mime.startsWith('image/') || mime === 'application/pdf';
}

/** Split user message parts into attachment parts and sticky (non-attachment) parts. */
export function splitUserParts<P extends PartLike>(
  parts: readonly P[],
): {
  attachments: Array<P & { type: 'file' }>;
  stickyParts: P[];
} {
  const attachments: Array<P & { type: 'file' }> = [];
  const stickyParts: P[] = [];
  for (const p of parts) {
    if (isAttachment(p)) {
      attachments.push(p);
    } else {
      stickyParts.push(p);
    }
  }
  return { attachments, stickyParts };
}

// ============================================================================
// Turn grouping
// ============================================================================

/**
 * Group messages into turns: each turn starts with a user message followed
 * by 0+ assistant messages.
 *
 * Uses parentID-based linking (matching SolidJS session-turn.tsx:272-292):
 * assistant messages are associated with their parent user message via
 * `parentID`. Falls back to sequential ordering when parentID is absent.
 */
export function groupMessagesIntoTurns<M extends MessageWithPartsLike>(
  messages: readonly M[],
): TurnLike<M>[] {
  const turns: TurnLike<M>[] = [];
  const turnsByUserMsgId = new Map<string, TurnLike<M>>();

  // First pass: create turns from user messages.
  // Dedupe by id — a user message can transiently appear twice (e.g. an
  // optimistic copy + the real one before reconcile finishes, or a hydrate
  // that races a part.updated event). Two turns with the same userMessage.id
  // would crash list renderers keyed by it (e.g. FlatList's keyExtractor).
  for (const msg of messages) {
    if (msg.info.role === 'user') {
      if (turnsByUserMsgId.has(msg.info.id)) continue;
      const turn: TurnLike<M> = { userMessage: msg, assistantMessages: [] };
      turns.push(turn);
      turnsByUserMsgId.set(msg.info.id, turn);
    }
  }

  // Second pass: link assistant messages via parentID or sequential
  let lastTurn: TurnLike<M> | null = null;
  for (const msg of messages) {
    if (msg.info.role === 'user') {
      lastTurn = turnsByUserMsgId.get(msg.info.id) ?? null;
      continue;
    }

    if (msg.info.role !== 'assistant') continue;

    const assistantMsg = msg.info;

    // Try parentID-based linking first (matches SolidJS)
    if (assistantMsg.parentID) {
      const parentTurn = turnsByUserMsgId.get(assistantMsg.parentID);
      if (parentTurn) {
        parentTurn.assistantMessages.push(msg);
        continue;
      }
    }

    // Fall back to sequential ordering — attach to the most recently seen
    // user turn in iteration order. This keeps streaming parts that arrive
    // before their parent metadata in the right turn.
    if (lastTurn) {
      lastTurn.assistantMessages.push(msg);
      continue;
    }

    // Orphan assistant message that precedes every user message in the
    // session (e.g. a session-init failure with no parentID). Attaching to
    // the LAST turn would surface its error under an unrelated, much later
    // user prompt. Attach to the FIRST turn instead so it renders at its
    // real chronological position — or create a synthetic turn if no user
    // messages exist at all.
    if (turns.length > 0) {
      turns[0].assistantMessages.unshift(msg);
      continue;
    }

    const syntheticTurn: TurnLike<M> = { userMessage: msg, assistantMessages: [] };
    turns.push(syntheticTurn);
  }

  return turns;
}

// ============================================================================
// Part collection helpers
// ============================================================================

/** Collect all parts from a turn's assistant messages. */
export function collectTurnParts<M extends MessageWithPartsLike>(
  turn: TurnLike<M>,
): PartWithMessage<M>[] {
  const result: PartWithMessage<M>[] = [];
  for (const msg of turn.assistantMessages) {
    for (const part of msg.parts) {
      result.push({ part, message: msg } as PartWithMessage<M>);
    }
  }
  return result;
}

/** Find the last non-empty text part in a turn (the "response"). */
export function findLastTextPart<P extends PartLike>(
  parts: ReadonlyArray<{ part: P }>,
): (P & { type: 'text' }) | undefined {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i].part;
    if (isTextPart(p) && (p as PartLike as TextPartLike).text?.trim()) {
      return p;
    }
  }
  return undefined;
}

/** Check if a turn has tool steps. */
export function turnHasSteps(parts: ReadonlyArray<{ part: PartLike }>): boolean {
  return parts.some(
    ({ part }) =>
      part.type === 'tool' ||
      part.type === 'compaction' ||
      part.type === 'snapshot' ||
      part.type === 'patch',
  );
}

// ============================================================================
// Shell mode detection
// ============================================================================

/**
 * Detect "shell mode": user message is entirely synthetic text parts AND
 * there's exactly one assistant message with exactly one part which is a bash tool.
 *
 * Stricter than our previous implementation — matches SolidJS session-turn.tsx:364-379
 * which checks `msgParts.length !== 1` (exactly one assistant part total).
 */
export function isShellMode(turn: TurnLike): boolean {
  const userParts = turn.userMessage.parts;
  if (userParts.length === 0) return false;
  const allSynthetic = userParts.every(
    (p) => isTextPart(p) && (p as PartLike as TextPartLike).synthetic,
  );
  if (!allSynthetic) return false;

  if (turn.assistantMessages.length !== 1) return false;
  const assistantParts = turn.assistantMessages[0].parts;
  // Strict: exactly 1 part total (not just 1 tool part)
  if (assistantParts.length !== 1) return false;
  const part = assistantParts[0];
  return isToolPart(part) && (part as PartLike as ToolPartLike).tool === 'bash';
}

/** Get the bash tool part when in shell mode. */
export function getShellModePart<M extends MessageWithPartsLike>(
  turn: TurnLike<M>,
): (M['parts'][number] & { type: 'tool' }) | undefined {
  if (!isShellMode(turn)) return undefined;
  return turn.assistantMessages[0].parts[0] as M['parts'][number] & { type: 'tool' };
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
// Hidden parts (permission / question active)
// ============================================================================

/** Tool part references to hide from the step list when permission/question is pending. */
export interface HiddenToolRef {
  messageID: string;
  callID: string;
}

/**
 * Get the list of tool parts to hide from the step list.
 * Matches SolidJS session-turn.tsx:332-339
 */
export function getHiddenToolParts(
  permission: RequestWithToolLike | undefined,
  question: RequestWithToolLike | undefined,
): HiddenToolRef[] {
  const out: HiddenToolRef[] = [];
  if (permission?.tool) out.push(permission.tool);
  if (question?.tool) out.push(question.tool);
  return out;
}

/** Check if a specific tool part should be hidden due to active permission/question. */
export function isToolPartHidden(
  part: Pick<ToolPartLike, 'callID'>,
  messageId: string,
  hidden: HiddenToolRef[],
): boolean {
  return hidden.some((h) => h.messageID === messageId && h.callID === part.callID);
}

// ============================================================================
// Answered question parts (shown when collapsed)
// ============================================================================

/**
 * Collect answered question parts that should be shown outside of the
 * steps list. Questions are always rendered standalone (never inside steps),
 * so answered questions are shown regardless of stepsExpanded state.
 */
export function getAnsweredQuestionParts<M extends MessageWithPartsLike>(
  turn: TurnLike<M>,
  _stepsExpanded: boolean,
  hasActiveQuestion: boolean,
): PartWithMessage<M>[] {
  // Active question takes precedence — don't also show old answered ones
  if (hasActiveQuestion) return [];

  const result: PartWithMessage<M>[] = [];
  for (const msg of turn.assistantMessages) {
    for (const part of msg.parts) {
      if (!isToolPart(part)) continue;
      const tp = part as PartLike as ToolPartLike;
      const answers = (tp.state?.metadata as { answers?: unknown[] } | undefined)?.answers;
      if (tp.tool === 'question' && (answers?.length ?? 0) > 0) {
        result.push({ part, message: msg } as PartWithMessage<M>);
      }
    }
  }
  return result;
}

// ============================================================================
// Error extraction — with deep JSON unwrapping
// ============================================================================

/**
 * Extract human-readable error message from a raw error value.
 * Matches SolidJS `unwrap()` function — session-turn.tsx:34-81
 */
export function unwrapError(raw: unknown): string {
  if (!raw) return 'An error occurred';

  if (typeof raw === 'string') {
    // Strip "Error: " prefix
    let str = raw.startsWith('Error: ') ? raw.slice(7) : raw;

    // Try JSON parsing (might be double-encoded)
    try {
      const parsed = JSON.parse(str);
      if (typeof parsed === 'string') {
        str = parsed; // double-encoded string
        try {
          const inner = JSON.parse(str);
          return extractErrorFromObject(inner) || str;
        } catch {
          return str;
        }
      }
      return extractErrorFromObject(parsed) || str;
    } catch {
      return str;
    }
  }

  if (typeof raw === 'object' && raw !== null) {
    return extractErrorFromObject(raw) || 'An error occurred';
  }

  return String(raw);
}

function extractErrorFromObject(obj: unknown): string | undefined {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return undefined;
  // Try common error shapes
  const record = obj as Record<string, unknown>;
  if (typeof record.message === 'string' && record.message) return record.message;
  if (typeof record.error === 'string' && record.error) return record.error;
  const data = record.data as { message?: unknown } | undefined | null;
  if (typeof data?.message === 'string') return data.message;
  const error = record.error as { message?: unknown } | undefined | null;
  if (typeof error?.message === 'string') return error.message;
  return undefined;
}

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
// Child session helpers
// ============================================================================

/**
 * Extract child session ID from a task tool part's metadata.
 */
export function getChildSessionId(part: Pick<ToolPartLike, 'tool' | 'state'>): string | undefined {
  // Native task tool, agent_spawn, or agent_task
  const t = part.tool || '';
  if (
    t === 'task' ||
    t === 'agent_spawn' ||
    t === 'agent-spawn' ||
    t === 'agent_message' ||
    t === 'agent-message' ||
    t === 'agent_task' ||
    t === 'agent-task' ||
    t === 'agent_task_update' ||
    t === 'agent-task-update' ||
    t === 'agent_task_message' ||
    t === 'agent-task-message' ||
    t === 'agent_task_start' ||
    t === 'agent-task-start' ||
    t === 'task_create' ||
    t === 'task-create' ||
    t === 'task_start' ||
    t === 'task-start' ||
    t === 'task_update' ||
    t === 'task-update' ||
    t === 'task_message' ||
    t === 'task-message'
  ) {
    // 1. Try metadata (ctx.metadata — available immediately for built-in tools)
    const metaSessionId = (part.state?.metadata as { sessionId?: unknown } | undefined)?.sessionId;
    if (typeof metaSessionId === 'string' && metaSessionId) return metaSessionId;

    // 2. Try title (plugin tools embed session ID in title via ctx.metadata)
    const title = part.state?.title;
    if (title) {
      const tm = title.match(/\bses_[a-zA-Z0-9]+/);
      if (tm) return tm[0];
    }

    // 3. Try output text (available after tool completes)
    const output = part.state?.output;
    if (output) {
      const m = output.match(/\bses_[a-zA-Z0-9]+/);
      if (m) return m[0];
    }
    return undefined;
  }
  // session_spawn / session_start_background: extract session ID from output text
  // Output format: "- **Session:** ses_xxx" or "Session: ses_xxx"
  const toolName = part.tool?.replace(/-/g, '_') || '';
  if (toolName === 'session_spawn' || toolName === 'session_start_background') {
    const output = part.state?.output;
    if (output) {
      const match = output.match(/\*?\*?Session:?\*?\*?\s*(ses_[a-zA-Z0-9]+)/);
      if (match) return match[1];
    }
    return undefined;
  }
  return undefined;
}

/**
 * Extract the error message from a child (sub-agent) session's raw messages.
 *
 * Mirrors `getTurnError` but operates over the flat `MessageWithParts` list
 * returned by `useOpenCodeMessages`, so a parent thread can surface a sub-agent
 * failure (e.g. "Free usage exceeded, subscribe to Go") that otherwise only
 * lives on the child session and never reaches the parent's turn renderer.
 * Scans newest-first so the most recent failure wins.
 */
export function getChildSessionError(
  childMessages: readonly MessageWithPartsLike[] | undefined,
): string | undefined {
  if (!childMessages) return undefined;
  for (let i = childMessages.length - 1; i >= 0; i--) {
    const info = childMessages[i]?.info;
    if (info?.role === 'assistant' && info.error) {
      return unwrapError(info.error);
    }
  }
  return undefined;
}

/**
 * Collect all tool parts from a child session's assistant messages.
 * Matches SolidJS getSessionToolParts — message-part.tsx:160-174
 */
export function getChildSessionToolParts<M extends MessageWithPartsLike>(
  childMessages: readonly M[],
): Array<M['parts'][number] & { type: 'tool' }> {
  const result: Array<M['parts'][number] & { type: 'tool' }> = [];
  for (const msg of childMessages) {
    if (msg.info.role !== 'assistant') continue;
    for (const part of msg.parts) {
      if (isToolPart(part) && shouldShowToolPart(part as PartLike as ToolPartLike)) {
        result.push(part as M['parts'][number] & { type: 'tool' });
      }
    }
  }
  return result;
}

// ============================================================================
// Tool part filtering
// ============================================================================

const HIDDEN_TOOLS = new Set(['todoread', 'context_info']);

export function shouldShowToolPart(part: Pick<ToolPartLike, 'tool'>): boolean {
  return !HIDDEN_TOOLS.has(part.tool);
}

// ============================================================================
// Tool info (icon + title + subtitle)
// ============================================================================

/**
 * Get icon, title, subtitle for a tool part.
 * Matches SolidJS getToolInfo — message-part.tsx:184-270
 *
 * Icon names are Lucide icon names used by the React frontend.
 */
export function getToolInfo(
  tool: string,
  // biome-ignore lint/suspicious/noExplicitAny: tool inputs are free-form wire data with heterogeneous shapes
  input: Record<string, any> = {},
): ToolInfo {
  switch (tool) {
    case 'read':
      return { icon: 'glasses', title: 'Read', subtitle: getFilename(input.filePath) };
    case 'list':
      return { icon: 'list', title: 'List', subtitle: getDirectory(input.path) };
    case 'glob':
      return { icon: 'search', title: 'Glob', subtitle: input.pattern };
    case 'grep':
      return { icon: 'search', title: 'Grep', subtitle: input.pattern };
    case 'webfetch':
      return { icon: 'globe', title: 'Web Fetch', subtitle: input.url };
    case 'websearch':
    case 'web-search':
    case 'web_search':
      return { icon: 'search', title: 'Web Search', subtitle: input.query };
    case 'scrape-webpage':
      return { icon: 'globe', title: 'Scrape', subtitle: input.urls?.split?.(',')[0] };
    case 'image-search':
      return { icon: 'image', title: 'Image Search', subtitle: input.query };
    case 'image-gen':
      return { icon: 'image', title: 'Image Gen', subtitle: input.prompt?.slice?.(0, 40) };
    case 'video-gen':
      return { icon: 'cpu', title: 'Video Gen', subtitle: input.prompt?.slice?.(0, 40) };
    case 'presentation-gen': {
      const action = input.action || '';
      const labels: Record<string, string> = {
        create_slide: 'Create Slide',
        list_slides: 'List Slides',
        preview: 'Preview',
        export_pdf: 'Export PDF',
        export_pptx: 'Export PPTX',
      };
      return {
        icon: 'presentation',
        title: labels[action] || 'Presentation',
        subtitle: input.slide_title || input.presentation_name,
      };
    }
    case 'show':
    case 'show-user':
      return { icon: 'globe', title: 'Output', subtitle: input.title || input.description };
    case 'task':
      return {
        icon: 'square-kanban',
        title: `Agent (${input.subagent_type || 'task'})`,
        subtitle: getAgentCardLabel(input),
      };
    case 'session_spawn':
    case 'session_start_background':
    case 'session-spawn':
    case 'session-start-background':
    case 'oc-session_spawn':
    case 'oc-session-spawn':
    case 'oc-session_start_background':
    case 'oc-session-start-background':
      return {
        icon: 'square-kanban',
        title: `Worker (${input.agent || 'KortixWorker'})`,
        subtitle: input.description || input.prompt?.slice(0, 60),
      };
    case 'bash':
      return { icon: 'terminal', title: 'Shell', subtitle: input.description };
    case 'edit':
    case 'morph_edit':
      return { icon: 'file-pen', title: 'Edit', subtitle: getFileWithDir(input.filePath) };
    case 'write':
      return { icon: 'file-pen', title: 'Write', subtitle: getFileWithDir(input.filePath) };
    case 'apply_patch':
      return {
        icon: 'file-pen',
        title: 'Patch',
        subtitle: input.files?.length
          ? `${input.files.length} file${input.files.length > 1 ? 's' : ''}`
          : undefined,
      };
    case 'todowrite':
      return { icon: 'check-square', title: 'Todos' };
    case 'todoread':
      return { icon: 'check-square', title: 'Todos (read)' };
    case 'question':
      return { icon: 'message-circle', title: 'Questions' };
    case 'prune':
      return { icon: 'scissors', title: 'DCP Prune', subtitle: input.reason };
    case 'distill':
      return { icon: 'scissors', title: 'DCP Distill' };
    case 'compress':
      return { icon: 'scissors', title: 'DCP Compress', subtitle: input.topic };
    case 'context_info':
      return { icon: 'scissors', title: 'Context Info' };
    case 'session_read':
    case 'session-read':
    case 'oc-session_read':
    case 'oc-session-read':
      return {
        icon: 'glasses',
        title: `Session Read (${input.mode || 'summary'})`,
        subtitle: input.session_id?.slice(-12),
      };
    case 'session_search':
    case 'session-search':
    case 'oc-session_search':
    case 'oc-session-search':
      return { icon: 'search', title: 'Session Search', subtitle: input.query };
    case 'session_message':
    case 'session-message':
    case 'oc-session_message':
    case 'oc-session-message':
      return {
        icon: 'message-circle',
        title: 'Message → Session',
        subtitle: input.session_id?.slice(-12),
      };
    case 'session_lineage':
    case 'session-lineage':
    case 'oc-session_lineage':
    case 'oc-session-lineage':
      return {
        icon: 'list-tree',
        title: 'Session Lineage',
        subtitle: input.session_id?.slice(-12),
      };
    case 'session_list_background':
    case 'session-list-background':
    case 'session_list_spawned':
    case 'session-list-spawned':
    case 'oc-session_list_background':
    case 'oc-session-list-background':
    case 'oc-session_list_spawned':
    case 'oc-session-list-spawned':
      return { icon: 'layers', title: 'Background Sessions', subtitle: input.project || 'all' };
    case 'session_stats':
    case 'session-stats':
    case 'oc-session_stats':
    case 'oc-session-stats':
      return {
        icon: 'layers',
        title: 'Session Stats',
        subtitle: input.session_id?.slice(-12) || 'current',
      };
    case 'session_list':
    case 'session-list':
    case 'oc-session_list':
    case 'oc-session-list':
      return { icon: 'list', title: 'Session List', subtitle: input.search };
    case 'session_get':
    case 'session-get':
    case 'oc-session_get':
    case 'oc-session-get':
      return { icon: 'book-open', title: 'Session Get', subtitle: input.session_id?.slice(-12) };
    case 'session_context':
    case 'session-context':
    case 'oc-session_context':
    case 'oc-session-context':
      return {
        icon: 'book-open',
        title: 'Session Context',
        subtitle: input.session_id?.slice(-12),
      };
    case 'project_delete':
    case 'project-delete':
    case 'oc-project_delete':
    case 'oc-project-delete':
      return { icon: 'trash-2', title: 'Workspace Delete Disabled', subtitle: input.project };
    case 'project_list':
    case 'project-list':
    case 'oc-project_list':
    case 'oc-project-list':
      return { icon: 'folder', title: 'Projects' };
    case 'project_get':
    case 'project-get':
    case 'oc-project_get':
    case 'oc-project-get':
    case 'project_update':
    case 'project-update':
    case 'oc-project_update':
    case 'oc-project-update':
      return { icon: 'folder', title: 'Project', subtitle: input.name || input.project };
    case 'project_select':
    case 'project-select':
    case 'oc-project_select':
    case 'oc-project-select':
      return { icon: 'folder', title: 'Project Select', subtitle: input.project };
    case 'project_create':
    case 'project-create':
    case 'oc-project_create':
    case 'oc-project-create':
      return { icon: 'folder-plus', title: 'Project Create', subtitle: input.name };
    case 'triggers':
    case 'trigger_create':
    case 'trigger-create':
    case 'oc-trigger_create':
    case 'oc-trigger-create':
      return { icon: 'clock', title: 'Create Trigger', subtitle: input.name };
    case 'trigger_list':
    case 'trigger-list':
    case 'oc-trigger_list':
    case 'oc-trigger-list':
      return { icon: 'clock', title: 'List Triggers' };
    case 'trigger_get':
    case 'trigger-get':
    case 'oc-trigger_get':
    case 'oc-trigger-get':
      return { icon: 'clock', title: 'Trigger Details', subtitle: input.name || input.id };
    case 'trigger_delete':
    case 'trigger-delete':
    case 'oc-trigger_delete':
    case 'oc-trigger-delete':
      return { icon: 'clock', title: 'Delete Trigger', subtitle: input.name || input.id };
    case 'trigger_update':
    case 'trigger-update':
    case 'oc-trigger_update':
    case 'oc-trigger-update':
      return { icon: 'clock', title: 'Update Trigger', subtitle: input.name || input.id };
    case 'trigger_test':
    case 'trigger-test':
    case 'oc-trigger_test':
    case 'oc-trigger-test':
      return { icon: 'clock', title: 'Test Trigger', subtitle: input.name || input.id };
    case 'trigger_pause':
    case 'trigger-pause':
    case 'oc-trigger_pause':
    case 'oc-trigger-pause':
      return { icon: 'clock', title: 'Pause Trigger', subtitle: input.name || input.id };
    case 'trigger_resume':
    case 'trigger-resume':
    case 'oc-trigger_resume':
    case 'oc-trigger-resume':
      return { icon: 'clock', title: 'Resume Trigger', subtitle: input.name || input.id };
    case 'agent_spawn':
    case 'agent-spawn':
      return {
        icon: 'cpu',
        title: `Agent (${input.agent_type || 'worker'})`,
        subtitle: input.description,
      };
    case 'agent_message':
    case 'agent-message':
      return { icon: 'message-circle', title: 'Agent Message', subtitle: input.agent_id };
    case 'agent_stop':
    case 'agent-stop':
      return { icon: 'ban', title: 'Agent Stop', subtitle: input.agent_id };
    case 'agent_status':
    case 'agent-status':
      return { icon: 'layers', title: 'Agent Status' };
    case 'agent_task':
    case 'agent-task':
    case 'oc-agent_task':
    case 'oc-agent-task':
      return { icon: 'check-square', title: 'Create Task', subtitle: input.title };
    case 'agent_task_update':
    case 'agent-task-update':
    case 'oc-agent_task_update':
    case 'oc-agent-task-update':
      return { icon: 'check-square', title: 'Update Task', subtitle: input.task_id };
    case 'agent_task_list':
    case 'agent-task-list':
    case 'oc-agent_task_list':
    case 'oc-agent-task-list':
      return { icon: 'check-square', title: 'List Tasks' };
    case 'agent_task_get':
    case 'agent-task-get':
    case 'oc-agent_task_get':
    case 'oc-agent-task-get':
      return { icon: 'check-square', title: 'Task Details', subtitle: input.task_id };
    case 'task_create':
    case 'task-create':
      return { icon: 'plus', title: 'Create Task', subtitle: input.title };
    case 'task_list':
    case 'task-list':
      return { icon: 'list', title: 'Tasks', subtitle: input.status || 'all' };
    case 'task_update':
    case 'task-update':
      return { icon: 'refresh-cw', title: 'Update Task', subtitle: input.id };
    case 'task_done':
    case 'task-done':
      return { icon: 'check-circle', title: 'Task Done', subtitle: input.id };
    case 'task_delete':
    case 'task-delete':
      return { icon: 'trash-2', title: 'Delete Task', subtitle: input.id };
    case 'pty_spawn':
      return { icon: 'terminal', title: 'Spawn', subtitle: input.title || input.command };
    case 'pty_read':
      return { icon: 'terminal', title: 'Terminal Output', subtitle: input.id };
    case 'pty_write':
    case 'pty_input':
      return { icon: 'terminal', title: 'Terminal Input', subtitle: input.id };
    case 'pty_kill':
      return { icon: 'terminal', title: 'Kill Process', subtitle: input.id };
    default:
      return { icon: 'cpu', title: tool };
  }
}

// ============================================================================
// Path helpers
// ============================================================================

/** Extract filename from a path. */
export function getFilename(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

/** Extract filename + parent directory, e.g. "main.go /workspace" */
export function getFileWithDir(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const parts = path.split('/');
  const filename = parts[parts.length - 1] || path;
  if (parts.length <= 1) return filename;
  // Get parent directory name (last directory segment)
  const dir = parts[parts.length - 2];
  return dir ? `${filename} /${dir}` : filename;
}

/** Extract directory from a path and strip trailing slash. */
export function getDirectory(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const idx = path.lastIndexOf('/');
  if (idx < 0) return undefined;
  return path.slice(0, idx) || '/';
}

/** Strip the project root directory from paths for display. */
export function relativizePath(path: string, projectDir?: string): string {
  if (!projectDir) return path;
  if (path.startsWith(projectDir)) {
    const rel = path.slice(projectDir.length);
    return rel.startsWith('/') ? rel.slice(1) : rel;
  }
  return path;
}

// ============================================================================
// Agent card labels
// ============================================================================

function firstMeaningfulLine(value: unknown, maxLength = 120): string {
  if (typeof value !== 'string') return '';
  const line = value
    .split('\n')
    .map((segment: string) => segment.trim())
    .find(Boolean);
  if (!line) return '';
  return line.length > maxLength ? `${line.slice(0, maxLength).trim()}…` : line;
}

/**
 * One-line label for an agent/task card, with graceful fallbacks when the
 * tool input has no description.
 */
export function getAgentCardLabel(input: Record<string, unknown>): string {
  const description = firstMeaningfulLine(input.description);
  if (description) return description;

  const title = firstMeaningfulLine(input.title, 80);
  if (title) return title;

  const message = firstMeaningfulLine(input.message);
  if (message) return message;

  const promptPreview = firstMeaningfulLine(input.prompt);
  if (promptPreview) return promptPreview;

  const agentId = firstMeaningfulLine(input.agent_id, 40);
  if (agentId) return `Agent ${agentId}`;

  return 'Worker task';
}

// ============================================================================
// Diagnostics
// ============================================================================

/**
 * Filter diagnostics for a file path, keeping only errors (severity=1), max 3.
 * Matches SolidJS getDiagnostics — message-part.tsx:53-90
 */
export function getDiagnostics(
  diagnosticsByFile: Record<string, Diagnostic[]> | undefined,
  filePath: string | undefined,
): Diagnostic[] {
  if (!diagnosticsByFile || !filePath) return [];
  const diags = diagnosticsByFile[filePath] ?? [];
  return diags.filter((d) => d.severity === 1).slice(0, 3);
}

// ============================================================================
// Permission / Question matching
// ============================================================================

/** Get the permission request matching a specific tool part. */
export function getPermissionForTool<T extends RequestWithToolLike>(
  permissions: readonly T[],
  callID: string,
): T | undefined {
  return permissions.find((p) => p.tool?.callID === callID);
}

/** Get the question request matching a specific tool part. */
export function getQuestionForTool<T extends RequestWithToolLike>(
  questions: readonly T[],
  callID: string,
): T | undefined {
  return questions.find((q) => q.tool?.callID === callID);
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

// ============================================================================
// ANSI strip (used by bash tool renderer)
// ============================================================================

const ANSI_RE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape sequences requires literal ESC/BEL control characters
  /\x1B\[[\d;]*[A-Za-z]|\x1B\][\d;]*[^\x07]*\x07|\x1B[()#][A-Z0-9]|\x1B\[?[\d;]*[hl]|\x1B[>=<]|\x1B\[[?]?\d*[A-Z]|\x1B\[\d*[JKHG]|\x1B\[\d*;\d*[Hf]|\x1b\[[0-9;]*m/g;

/** Strip ANSI escape codes from terminal output. */
export function stripAnsi(str: string): string {
  if (!str) return '';
  return str.replace(ANSI_RE, '');
}

// ============================================================================
// Session list helpers (sidebar / tabs)
// ============================================================================

/**
 * Build a map from parent session ID → array of child session IDs.
 * Used to aggregate child session status (permissions, busy) in the sidebar.
 * Matches SolidJS reference `childMapByParent()` in helpers.ts.
 */
export function childMapByParent(
  sessions: ReadonlyArray<{ id: string; parentID?: string }>,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const session of sessions) {
    if (!session.parentID) continue;
    const existing = map.get(session.parentID);
    if (existing) {
      existing.push(session.id);
    } else {
      map.set(session.parentID, [session.id]);
    }
  }
  return map;
}

/**
 * Sort comparator for sessions.
 * Two tiers:
 *  1. Sessions updated within `now - 60s` are pinned to top, sorted by ID (stable).
 *  2. Older sessions sorted by `updated` time descending.
 * Matches SolidJS reference `sortSessions()` in helpers.ts.
 */
export function sortSessions(now: number) {
  const oneMinuteAgo = now - 60 * 1000;
  return (
    a: { id: string; time: { updated?: number; created: number } },
    b: { id: string; time: { updated?: number; created: number } },
  ) => {
    const aUpdated = a.time.updated ?? a.time.created;
    const bUpdated = b.time.updated ?? b.time.created;
    const aRecent = aUpdated > oneMinuteAgo;
    const bRecent = bUpdated > oneMinuteAgo;
    if (aRecent && bRecent) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    if (aRecent && !bRecent) return -1;
    if (!aRecent && bRecent) return 1;
    return bUpdated - aUpdated;
  };
}

/**
 * Recursively collect ALL descendant session IDs for a given parent.
 * Walks the full tree so deeply nested sub-agents are included.
 */
export function allDescendantIds(childMap: Map<string, string[]>, sessionId: string): string[] {
  const directChildren = childMap.get(sessionId);
  if (!directChildren || directChildren.length === 0) return [];
  const result: string[] = [];
  for (const childId of directChildren) {
    result.push(childId);
    result.push(...allDescendantIds(childMap, childId));
  }
  return result;
}
