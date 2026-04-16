/**
 * Turn grouping & part helpers — framework-agnostic.
 *
 * Pure functions that transform SDK message data into view-model shapes.
 * Used by both web and mobile UIs.
 *
 * IMPORTANT: No React / DOM / framework imports allowed in this file.
 * Matches the SolidJS reference in opencode/packages/ui/src/components/session-turn.tsx
 */

import type {
  Part,
  TextPart,
  ReasoningPart,
  ToolPart,
  FilePart,
  AgentPart,
  CompactionPart,
  StepFinishPart,
  SnapshotPart,
  PatchPart,
  AssistantMessage,
  PermissionRequest,
  QuestionRequest,
  SessionStatus,
} from '@opencode-ai/sdk/v2/client';
import type {
  MessageWithParts,
  Turn,
  TurnCostInfo,
  RetryInfo,
  ToolInfo,
  Diagnostic,
} from './types';

// ============================================================================
// Type guards
// ============================================================================

export function isTextPart(part: Part): part is TextPart {
  return part.type === 'text';
}

export function isReasoningPart(part: Part): part is ReasoningPart {
  return part.type === 'reasoning';
}

export function isToolPart(part: Part): part is ToolPart {
  return part.type === 'tool';
}

export function isFilePart(part: Part): part is FilePart {
  return part.type === 'file';
}

export function isAgentPart(part: Part): part is AgentPart {
  return part.type === 'agent';
}

export function isCompactionPart(part: Part): part is CompactionPart {
  return part.type === 'compaction';
}

export function isSnapshotPart(part: Part): part is SnapshotPart {
  return part.type === 'snapshot';
}

export function isPatchPart(part: Part): part is PatchPart {
  return part.type === 'patch';
}

/** Get the text content from any part that has a `text` field. */
export function getPartText(part: Part): string | undefined {
  if (isTextPart(part)) return part.text;
  if (isReasoningPart(part)) return part.text;
  return undefined;
}

// ============================================================================
// Attachment helpers (images, PDFs)
// ============================================================================

/**
 * Check if a file part is an image or PDF attachment.
 * Matches SolidJS `isAttachment()` — session-turn.tsx:128
 */
export function isAttachment(part: Part): part is FilePart {
  if (!isFilePart(part)) return false;
  return part.mime.startsWith('image/') || part.mime === 'application/pdf';
}

/** Split user message parts into attachment parts and sticky (non-attachment) parts. */
export function splitUserParts(parts: Part[]): {
  attachments: FilePart[];
  stickyParts: Part[];
} {
  const attachments: FilePart[] = [];
  const stickyParts: Part[] = [];
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
export function groupMessagesIntoTurns(messages: MessageWithParts[]): Turn[] {
  const turns: Turn[] = [];
  const turnsByUserMsgId = new Map<string, Turn>();

  // First pass: create turns from user messages
  for (const msg of messages) {
    if (msg.info.role === 'user') {
      const turn: Turn = { userMessage: msg, assistantMessages: [] };
      turns.push(turn);
      turnsByUserMsgId.set(msg.info.id, turn);
    }
  }

  // Second pass: link assistant messages via parentID or sequential
  let lastTurn: Turn | null = null;
  for (const msg of messages) {
    if (msg.info.role === 'user') {
      lastTurn = turnsByUserMsgId.get(msg.info.id) ?? null;
      continue;
    }

    if (msg.info.role !== 'assistant') continue;

    const assistantMsg = msg.info as AssistantMessage;

    // Try parentID-based linking first (matches SolidJS)
    if (assistantMsg.parentID) {
      const parentTurn = turnsByUserMsgId.get(assistantMsg.parentID);
      if (parentTurn) {
        parentTurn.assistantMessages.push(msg);
        continue;
      }
    }

    // Fall back to sequential ordering
    if (lastTurn) {
      lastTurn.assistantMessages.push(msg);
      continue;
    }

    // If ordering is temporarily out of sync (e.g. part events arrive before
    // full assistant metadata), attach to the latest known user turn so
    // in-progress streaming text appears in the active turn immediately.
    if (turns.length > 0) {
      turns[turns.length - 1].assistantMessages.push(msg);
      continue;
    }

    // No user messages at all — create a synthetic turn.
    const syntheticTurn: Turn = { userMessage: msg, assistantMessages: [] };
    turns.push(syntheticTurn);
  }

  return turns;
}

// ============================================================================
// Part collection helpers
// ============================================================================

export interface PartWithMessage {
  part: Part;
  message: MessageWithParts;
}

/** Collect all parts from a turn's assistant messages. */
export function collectTurnParts(turn: Turn): PartWithMessage[] {
  const result: PartWithMessage[] = [];
  for (const msg of turn.assistantMessages) {
    for (const part of msg.parts) {
      result.push({ part, message: msg });
    }
  }
  return result;
}

/** Find the last non-empty text part in a turn (the "response"). */
export function findLastTextPart(parts: PartWithMessage[]): TextPart | undefined {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i].part;
    if (isTextPart(p) && p.text?.trim()) {
      return p;
    }
  }
  return undefined;
}

/** Check if a turn has tool steps. */
export function turnHasSteps(parts: PartWithMessage[]): boolean {
  return parts.some(({ part }) =>
    part.type === 'tool' || part.type === 'compaction' ||
    part.type === 'snapshot' || part.type === 'patch',
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
export function isShellMode(turn: Turn): boolean {
  const userParts = turn.userMessage.parts;
  if (userParts.length === 0) return false;
  const allSynthetic = userParts.every((p) => isTextPart(p) && (p as TextPart).synthetic);
  if (!allSynthetic) return false;

  if (turn.assistantMessages.length !== 1) return false;
  const assistantParts = turn.assistantMessages[0].parts;
  // Strict: exactly 1 part total (not just 1 tool part)
  if (assistantParts.length !== 1) return false;
  const part = assistantParts[0];
  return isToolPart(part) && part.tool === 'bash';
}

/** Get the bash tool part when in shell mode. */
export function getShellModePart(turn: Turn): ToolPart | undefined {
  if (!isShellMode(turn)) return undefined;
  return turn.assistantMessages[0].parts[0] as ToolPart;
}

// ============================================================================
// Working state
// ============================================================================

/** Check if this is the last user message in the session. */
export function isLastUserMessage(
  messageId: string,
  allMessages: MessageWithParts[],
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
  sessionStatus: SessionStatus | undefined,
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
  permission: PermissionRequest | undefined,
  question: QuestionRequest | undefined,
): HiddenToolRef[] {
  const out: HiddenToolRef[] = [];
  if (permission?.tool) out.push(permission.tool);
  if (question?.tool) out.push(question.tool);
  return out;
}

/** Check if a specific tool part should be hidden due to active permission/question. */
export function isToolPartHidden(
  part: ToolPart,
  messageId: string,
  hidden: HiddenToolRef[],
): boolean {
  return hidden.some(
    (h) => h.messageID === messageId && h.callID === part.callID,
  );
}

// ============================================================================
// Answered question parts (shown when collapsed)
// ============================================================================

/**
 * Collect answered question parts that should be shown outside of the
 * steps list. Questions are always rendered standalone (never inside steps),
 * so answered questions are shown regardless of stepsExpanded state.
 */
export function getAnsweredQuestionParts(
  turn: Turn,
  _stepsExpanded: boolean,
  hasActiveQuestion: boolean,
): PartWithMessage[] {
  // Active question takes precedence — don't also show old answered ones
  if (hasActiveQuestion) return [];

  const result: PartWithMessage[] = [];
  for (const msg of turn.assistantMessages) {
    for (const part of msg.parts) {
      if (
        isToolPart(part) &&
        part.tool === 'question' &&
        (part.state as any)?.metadata?.answers?.length > 0
      ) {
        result.push({ part, message: msg });
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

function extractErrorFromObject(obj: any): string | undefined {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return undefined;
  // Try common error shapes
  if (typeof obj.message === 'string' && obj.message) return obj.message;
  if (typeof obj.error === 'string' && obj.error) return obj.error;
  if (typeof obj.data?.message === 'string') return obj.data.message;
  if (typeof obj.error?.message === 'string') return obj.error.message;
  return undefined;
}

/** Extract error message from assistant messages in a turn. */
export function getTurnError(turn: Turn): string | undefined {
  for (const msg of turn.assistantMessages) {
    const info = msg.info as AssistantMessage;
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
export function computeStatusFromPart(part: Part | undefined): string | undefined {
  if (!part) return undefined;

  if (isToolPart(part)) {
    switch (part.tool) {
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
      case 'task_update':
      case 'task-update':
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
        return `Running ${part.tool}...`;
    }
  }

  if (isReasoningPart(part)) {
    const text = part.text?.trimStart();
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
  parts: PartWithMessage[],
  childMessages?: MessageWithParts[],
): string {
  // Scan parts in reverse for the last meaningful status
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i].part;

    // If it's a running task orchestration tool, try to get status from child session
    if (
      isToolPart(p) &&
      (
        p.tool === 'task' ||
        p.tool === 'agent_task' ||
        p.tool === 'agent-task' ||
        p.tool === 'task_create' ||
        p.tool === 'task-create' ||
        p.tool === 'task_start' ||
        p.tool === 'task-start'
      ) &&
      p.state.status === 'running' &&
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
export function getChildSessionId(part: ToolPart): string | undefined {
  // Native task tool, agent_spawn, or agent_task
  const t = part.tool || '';
  if (t === 'task' || t === 'agent_spawn' || t === 'agent-spawn' || t === 'agent_message' || t === 'agent-message'
    || t === 'agent_task' || t === 'agent-task' || t === 'agent_task_update' || t === 'agent-task-update'
    || t === 'agent_task_message' || t === 'agent-task-message' || t === 'agent_task_start' || t === 'agent-task-start'
    || t === 'task_create' || t === 'task-create' || t === 'task_start' || t === 'task-start'
    || t === 'task_update' || t === 'task-update' || t === 'task_message' || t === 'task-message') {
    // 1. Try metadata (ctx.metadata — available immediately for built-in tools)
    const metaSessionId = ((part.state as any)?.metadata as any)?.sessionId;
    if (metaSessionId) return metaSessionId;

    // 2. Try title (plugin tools embed session ID in title via ctx.metadata)
    const title = (part.state as any)?.title as string | undefined;
    if (title) {
      const tm = title.match(/\bses_[a-zA-Z0-9]+/);
      if (tm) return tm[0];
    }

    // 3. Try output text (available after tool completes)
    const output = (part.state as any)?.output as string | undefined;
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
    const output = (part.state as any)?.output as string | undefined;
    if (output) {
      const match = output.match(/\*?\*?Session:?\*?\*?\s*(ses_[a-zA-Z0-9]+)/);
      if (match) return match[1];
    }
    return undefined;
  }
  return undefined;
}

/**
 * Collect all tool parts from a child session's assistant messages.
 * Matches SolidJS getSessionToolParts — message-part.tsx:160-174
 */
export function getChildSessionToolParts(
  childMessages: MessageWithParts[],
): ToolPart[] {
  const result: ToolPart[] = [];
  for (const msg of childMessages) {
    if (msg.info.role !== 'assistant') continue;
    for (const part of msg.parts) {
      if (isToolPart(part) && shouldShowToolPart(part)) {
        result.push(part);
      }
    }
  }
  return result;
}

// ============================================================================
// Tool part filtering
// ============================================================================

const HIDDEN_TOOLS = new Set(['todoread', 'context_info']);

export function shouldShowToolPart(part: ToolPart): boolean {
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
export function getToolInfo(tool: string, input: Record<string, any> = {}): ToolInfo {
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
        subtitle: input.description,
      };
    case 'session_spawn':
    case 'session_start_background':
    case 'session-spawn':
    case 'session-start-background':
      return {
        icon: 'square-kanban',
        title: `Worker (${input.agent || 'KortixWorker'})`,
        subtitle: input.description || input.prompt?.slice(0, 60),
      };
    case 'bash':
      return { icon: 'terminal', title: 'Shell', subtitle: input.description };
    case 'edit':
    case 'morph_edit':
      return { icon: 'file-pen', title: 'Edit', subtitle: getFilename(input.filePath) };
    case 'write':
      return { icon: 'file-pen', title: 'Write', subtitle: getFilename(input.filePath) };
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
      return { icon: 'glasses', title: `Session Read (${input.mode || 'summary'})`, subtitle: input.session_id?.slice(-12) };
    case 'session_search':
    case 'session-search':
      return { icon: 'search', title: 'Session Search', subtitle: input.query };
    case 'session_message':
    case 'session-message':
      return { icon: 'message-circle', title: 'Message → Session', subtitle: input.session_id?.slice(-12) };
    case 'session_lineage':
    case 'session-lineage':
      return { icon: 'list-tree', title: 'Session Lineage', subtitle: input.session_id?.slice(-12) };
    case 'session_list_background':
    case 'session-list-background':
    case 'session_list_spawned':
    case 'session-list-spawned':
      return { icon: 'layers', title: 'Background Sessions', subtitle: input.project || 'all' };
    case 'session_stats':
    case 'session-stats':
      return { icon: 'layers', title: 'Session Stats', subtitle: input.session_id?.slice(-12) || 'current' };
    case 'session_list':
    case 'session-list':
      return { icon: 'list', title: 'Session List', subtitle: input.search };
    case 'session_get':
    case 'session-get':
      return { icon: 'book-open', title: 'Session Get', subtitle: input.session_id?.slice(-12) };
    case 'project_delete':
    case 'project-delete':
      return { icon: 'trash-2', title: 'Delete Project', subtitle: input.project };
    case 'agent_spawn':
    case 'agent-spawn':
      return { icon: 'cpu', title: `Agent (${input.agent_type || 'worker'})`, subtitle: input.description };
    case 'agent_message':
    case 'agent-message':
      return { icon: 'message-circle', title: 'Agent Message', subtitle: input.agent_id };
    case 'agent_stop':
    case 'agent-stop':
      return { icon: 'ban', title: 'Agent Stop', subtitle: input.agent_id };
    case 'agent_status':
    case 'agent-status':
      return { icon: 'layers', title: 'Agent Status' };
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
export function getPermissionForTool(
  permissions: PermissionRequest[],
  callID: string,
): PermissionRequest | undefined {
  return permissions.find((p) => p.tool?.callID === callID);
}

/** Get the question request matching a specific tool part. */
export function getQuestionForTool(
  questions: QuestionRequest[],
  callID: string,
): QuestionRequest | undefined {
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

/**
 * Aggregate cost/token info from step-finish parts in a turn.
 * Returns undefined if no step-finish parts found.
 *
 * The cost is multiplied by COST_MARKUP so the displayed value matches
 * the actual credits deducted (raw provider cost × 1.2).
 */
export function getTurnCost(parts: PartWithMessage[]): TurnCostInfo | undefined {
  let totalCost = 0;
  let input = 0;
  let output = 0;
  let reasoning = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let found = false;

  for (const { part } of parts) {
    if (part.type === 'step-finish') {
      found = true;
      const sfp = part as StepFinishPart;
      totalCost += sfp.cost || 0;
      input += sfp.tokens?.input || 0;
      output += sfp.tokens?.output || 0;
      reasoning += sfp.tokens?.reasoning || 0;
      cacheRead += sfp.tokens?.cache?.read || 0;
      cacheWrite += sfp.tokens?.cache?.write || 0;
    }
  }

  if (!found) return undefined;
  return { cost: totalCost * COST_MARKUP, tokens: { input, output, reasoning, cacheRead, cacheWrite } };
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
export function getRetryInfo(status: SessionStatus | undefined): RetryInfo | undefined {
  if (!status || status.type !== 'retry') return undefined;
  return {
    attempt: status.attempt,
    message:
      status.message.length > 60
        ? status.message.slice(0, 60) + '...'
        : status.message,
    next: status.next,
  };
}

export function getRetryMessage(status: SessionStatus | undefined): string | undefined {
  if (!status || status.type !== 'retry') return undefined;
  return unwrapError(status.message);
}

// ============================================================================
// hasDiffs check
// ============================================================================

/** Check if a user message has associated file diffs. */
export function hasDiffs(userMessage: MessageWithParts): boolean {
  const summary = (userMessage.info as any)?.summary;
  return (summary?.diffs?.length ?? 0) > 0;
}

// ============================================================================
// ANSI strip (used by bash tool renderer)
// ============================================================================

const ANSI_RE = /\x1B\[[\d;]*[A-Za-z]|\x1B\][\d;]*[^\x07]*\x07|\x1B[()#][A-Z0-9]|\x1B\[?[\d;]*[hl]|\x1B[>=<]|\x1B\[[?]?\d*[A-Z]|\x1B\[\d*[JKHG]|\x1B\[\d*;\d*[Hf]|\x1b\[[0-9;]*m/g;

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
  sessions: Array<{ id: string; parentID?: string }>,
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
export function allDescendantIds(
  childMap: Map<string, string[]>,
  sessionId: string,
): string[] {
  const directChildren = childMap.get(sessionId);
  if (!directChildren || directChildren.length === 0) return [];
  const result: string[] = [];
  for (const childId of directChildren) {
    result.push(childId);
    result.push(...allDescendantIds(childMap, childId));
  }
  return result;
}
