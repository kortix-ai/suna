/**
 * Part-level helpers — type guards, attachment splitting, tool-part display
 * info, and everything else that operates on a single part (or a single
 * part's tool/path/diagnostics data) rather than a whole turn.
 *
 * Split out of `turns/index.ts` — see that file's history for the original
 * single-file version. No React / DOM / framework imports allowed.
 */

import type {
  Diagnostic,
  MessageWithPartsLike,
  PartLike,
  RequestWithToolLike,
  ToolInfo,
  ToolPartLike,
} from './types';
import { unwrapError } from './errors';

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
// Tool part filtering
// ============================================================================

const HIDDEN_TOOLS = new Set(['todoread', 'context_info']);

export function shouldShowToolPart(part: Pick<ToolPartLike, 'tool'>): boolean {
  return !HIDDEN_TOOLS.has(part.tool);
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
// ANSI strip (used by bash tool renderer)
// ============================================================================

// OSC payloads (window titles, OSC-8 hyperlink URLs) are never more than a
// couple hundred bytes in real terminal output; capping the run length keeps
// stripAnsi linear-time even when `str.replace` retries the scan from every
// unterminated OSC start in an adversarial input (see turns.test.ts).
const ANSI_RE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape sequences requires literal ESC/BEL control characters
  /\x1B\[[\d;]*[A-Za-z]|\x1B\][^\x07]{0,512}\x07|\x1B[()#][A-Z0-9]|\x1B\[?[\d;]*[hl]|\x1B[>=<]|\x1B\[[?]?\d*[A-Z]|\x1B\[\d*[JKHG]|\x1B\[\d*;\d*[Hf]|\x1b\[[0-9;]*m/g;

/** Strip ANSI escape codes from terminal output. */
export function stripAnsi(str: string): string {
  if (!str) return '';
  return str.replace(ANSI_RE, '');
}
