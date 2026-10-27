/**
 * Part-level helpers — type guards, attachment splitting, tool-part display
 * info, and everything else that operates on a single part (or a single
 * part's tool/path/diagnostics data) rather than a whole turn.
 *
 * Split out of `turns/index.ts` — see that file's history for the original
 * single-file version. No React / DOM / framework imports allowed.
 */

import { unwrapError } from './errors';
import { isToolCallBlock, toolPartOf } from '../session-log/tool-call';
import type { ToolCallBlock } from '../session-log/types';
import { inputPath, toolKind } from './tool-kind';
import { normalizeName } from './tools/tool-meta';
import type {
  Diagnostic,
  MessageWithPartsLike,
  PartLike,
  RequestWithToolLike,
  ToolInfo,
  ToolPartLike,
} from './types';

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

/** A model step boundary (`step-start` / `step-finish`): bookkeeping, never content. */
export function isStepPart<P extends PartLike>(
  part: P,
): part is P & { type: 'step-start' | 'step-finish' } {
  return part.type === 'step-start' || part.type === 'step-finish';
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
 * Check if a file part is a model-native image or PDF attachment.
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
  for (const part of parts) {
    if (isFilePart(part)) {
      attachments.push(part);
    } else {
      stickyParts.push(part);
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

export function shouldShowToolPart(part: Pick<ToolPartLike, 'tool'> | ToolCallBlock): boolean {
  return !HIDDEN_TOOLS.has(isToolCallBlock(part) ? part.name : part.tool);
}

// ============================================================================
// Child session helpers
// ============================================================================

const CHILD_SESSION_TOOLS = new Set([
  'task',
  'agent_spawn',
  'agent_message',
  'agent_task',
  'agent_task_update',
  'agent_task_message',
  'agent_task_start',
  'task_create',
  'task_start',
  'task_update',
  'task_message',
]);

/**
 * The child session a delegating tool call runs: `state.metadata.sessionId`,
 * which OpenCode's and pi's `task` both set. Reads a tool call block the same way.
 */
export function getChildSessionId(call: Pick<ToolPartLike, 'tool' | 'state'> | ToolCallBlock): string | undefined {
  const part: Pick<ToolPartLike, 'tool' | 'state'> = isToolCallBlock(call) ? toolPartOf(call) : call;
  const tool = part.tool || '';
  // `oc-` twins of the plugin tools never name a child.
  if (tool.startsWith('oc-')) return undefined;
  const kind = toolKind(tool);
  if (kind === 'task' || kind === 'delegate') {
    const metaSessionId = (part.state?.metadata as { sessionId?: unknown } | undefined)?.sessionId;
    if (typeof metaSessionId === 'string' && metaSessionId) return metaSessionId;
    if (kind === 'task' && part.state?.status === 'error') {
      return part.state.error?.match(/\btask_id:\s*(ses_[A-Za-z0-9]+)/)?.[1];
    }
  }
  return legacyChildSessionId(tool, part.state);
}

/**
 * Retired plugin tools named their child only in text: in the title or output
 * (`agent_*`, `task_*`), or as `Session: ses_…` in the output
 * (`session_spawn`). Kept for transcripts they wrote.
 */
function legacyChildSessionId(tool: string, state: ToolPartLike['state'] | undefined): string | undefined {
  const name = normalizeName(tool);
  if (CHILD_SESSION_TOOLS.has(name)) {
    const inTitle = state?.title?.match(/\bses_[a-zA-Z0-9]+/);
    if (inTitle) return inTitle[0];
    return state?.output?.match(/\bses_[a-zA-Z0-9]+/)?.[0];
  }
  if (name === 'session_spawn' || name === 'session_start_background') {
    return state?.output?.match(/\*?\*?Session:?\*?\*?\s*(ses_[a-zA-Z0-9]+)/)?.[1];
  }
  return undefined;
}

/**
 * Extract the error message from a child (sub-agent) session's raw messages.
 *
 * Mirrors `getTurnError` but operates over the flat `MessageWithParts` list
 * returned by `useRuntimeMessages`, so a parent thread can surface a sub-agent
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
 * The tool presentation catalog: one card per known tool name, keyed by
 * `normalizeName`. A title is either a literal or built from the input;
 * a subtitle reads the input. Anything not in the table falls back to
 * {@link coreToolInfo}, which cards by tool KIND.
 */
// biome-ignore lint/suspicious/noExplicitAny: tool inputs are free-form wire data with heterogeneous shapes
type ToolCardInput = Record<string, any>;

type ToolCard = {
  icon: string;
  title: string | ((input: ToolCardInput) => string);
  subtitle?: (input: ToolCardInput) => string | undefined;
};

const TOOL_CARDS: Record<string, ToolCard> = {
  webfetch: { icon: 'globe', title: 'Web Fetch', subtitle: (input) => input.url },
  websearch: { icon: 'search', title: 'Web Search', subtitle: (input) => input.query },
  web_search: { icon: 'search', title: 'Web Search', subtitle: (input) => input.query },
  scrape_webpage: { icon: 'globe', title: 'Scrape', subtitle: (input) => input.urls?.split?.(',')[0] },
  image_search: { icon: 'image', title: 'Image Search', subtitle: (input) => input.query },
  image_gen: { icon: 'image', title: 'Image Gen', subtitle: (input) => input.prompt?.slice?.(0, 40) },
  video_gen: { icon: 'cpu', title: 'Video Gen', subtitle: (input) => input.prompt?.slice?.(0, 40) },
  presentation_gen: {
    icon: 'presentation',
    title: (input) => {
      const action = input.action || '';
      const labels: Record<string, string> = {
        create_slide: 'Create Slide',
        list_slides: 'List Slides',
        preview: 'Preview',
        export_pdf: 'Export PDF',
        export_pptx: 'Export PPTX',
      };
      return labels[action] || 'Presentation';
    },
    subtitle: (input) => input.slide_title || input.presentation_name,
  },
  show: { icon: 'globe', title: 'Output', subtitle: (input) => input.title || input.description },
  show_user: { icon: 'globe', title: 'Output', subtitle: (input) => input.title || input.description },
  task: {
    icon: 'square-kanban',
    title: (input) => `Agent (${input.subagent_type || 'task'})`,
    subtitle: (input) => getAgentCardLabel(input),
  },
  session_spawn: {
    icon: 'square-kanban',
    title: (input) => `Worker (${input.agent || 'KortixWorker'})`,
    subtitle: (input) => input.description || input.prompt?.slice(0, 60),
  },
  session_start_background: {
    icon: 'square-kanban',
    title: (input) => `Worker (${input.agent || 'KortixWorker'})`,
    subtitle: (input) => input.description || input.prompt?.slice(0, 60),
  },
  apply_patch: {
    icon: 'file-pen',
    title: 'Patch',
    subtitle: (input) =>
      input.files?.length
        ? `${input.files.length} file${input.files.length > 1 ? 's' : ''}`
        : undefined,
  },
  todoread: { icon: 'check-square', title: 'Todos (read)' },
  prune: { icon: 'scissors', title: 'DCP Prune', subtitle: (input) => input.reason },
  distill: { icon: 'scissors', title: 'DCP Distill' },
  compress: { icon: 'scissors', title: 'DCP Compress', subtitle: (input) => input.topic },
  context_info: { icon: 'scissors', title: 'Context Info' },
  session_read: {
    icon: 'glasses',
    title: (input) => `Session Read (${input.mode || 'summary'})`,
    subtitle: (input) => input.session_id?.slice(-12),
  },
  session_search: { icon: 'search', title: 'Session Search', subtitle: (input) => input.query },
  session_message: {
    icon: 'message-circle',
    title: 'Message → Session',
    subtitle: (input) => input.session_id?.slice(-12),
  },
  session_lineage: {
    icon: 'list-tree',
    title: 'Session Lineage',
    subtitle: (input) => input.session_id?.slice(-12),
  },
  session_list_background: {
    icon: 'layers',
    title: 'Background Sessions',
    subtitle: (input) => input.project || 'all',
  },
  session_list_spawned: {
    icon: 'layers',
    title: 'Background Sessions',
    subtitle: (input) => input.project || 'all',
  },
  session_stats: {
    icon: 'layers',
    title: 'Session Stats',
    subtitle: (input) => input.session_id?.slice(-12) || 'current',
  },
  session_list: { icon: 'list', title: 'Session List', subtitle: (input) => input.search },
  session_get: {
    icon: 'book-open',
    title: 'Session Get',
    subtitle: (input) => input.session_id?.slice(-12),
  },
  session_context: {
    icon: 'book-open',
    title: 'Session Context',
    subtitle: (input) => input.session_id?.slice(-12),
  },
  project_delete: {
    icon: 'trash-2',
    title: 'Workspace Delete Disabled',
    subtitle: (input) => input.project,
  },
  project_list: { icon: 'folder', title: 'Projects' },
  project_get: { icon: 'folder', title: 'Project', subtitle: (input) => input.name || input.project },
  project_update: { icon: 'folder', title: 'Project', subtitle: (input) => input.name || input.project },
  project_select: { icon: 'folder', title: 'Project Select', subtitle: (input) => input.project },
  project_create: { icon: 'folder-plus', title: 'Project Create', subtitle: (input) => input.name },
  triggers: { icon: 'clock', title: 'Create Trigger', subtitle: (input) => input.name },
  trigger_create: { icon: 'clock', title: 'Create Trigger', subtitle: (input) => input.name },
  trigger_list: { icon: 'clock', title: 'List Triggers' },
  trigger_get: { icon: 'clock', title: 'Trigger Details', subtitle: (input) => input.name || input.id },
  trigger_delete: { icon: 'clock', title: 'Delete Trigger', subtitle: (input) => input.name || input.id },
  trigger_update: { icon: 'clock', title: 'Update Trigger', subtitle: (input) => input.name || input.id },
  trigger_test: { icon: 'clock', title: 'Test Trigger', subtitle: (input) => input.name || input.id },
  trigger_pause: { icon: 'clock', title: 'Pause Trigger', subtitle: (input) => input.name || input.id },
  trigger_resume: { icon: 'clock', title: 'Resume Trigger', subtitle: (input) => input.name || input.id },
  agent_spawn: {
    icon: 'cpu',
    title: (input) => `Agent (${input.agent_type || 'worker'})`,
    subtitle: (input) => input.description,
  },
  agent_message: { icon: 'message-circle', title: 'Agent Message', subtitle: (input) => input.agent_id },
  agent_stop: { icon: 'ban', title: 'Agent Stop', subtitle: (input) => input.agent_id },
  agent_status: { icon: 'layers', title: 'Agent Status' },
  agent_task: { icon: 'check-square', title: 'Create Task', subtitle: (input) => input.title },
  agent_task_update: { icon: 'check-square', title: 'Update Task', subtitle: (input) => input.task_id },
  agent_task_list: { icon: 'check-square', title: 'List Tasks' },
  agent_task_get: { icon: 'check-square', title: 'Task Details', subtitle: (input) => input.task_id },
  task_create: { icon: 'plus', title: 'Create Task', subtitle: (input) => input.title },
  task_list: { icon: 'list', title: 'Tasks', subtitle: (input) => input.status || 'all' },
  task_update: { icon: 'refresh-cw', title: 'Update Task', subtitle: (input) => input.id },
  task_done: { icon: 'check-circle', title: 'Task Done', subtitle: (input) => input.id },
  task_delete: { icon: 'trash-2', title: 'Delete Task', subtitle: (input) => input.id },
  pty_spawn: { icon: 'terminal', title: 'Spawn', subtitle: (input) => input.title || input.command },
  pty_read: { icon: 'terminal', title: 'Terminal Output', subtitle: (input) => input.id },
  pty_write: { icon: 'terminal', title: 'Terminal Input', subtitle: (input) => input.id },
  pty_input: { icon: 'terminal', title: 'Terminal Input', subtitle: (input) => input.id },
  pty_kill: { icon: 'terminal', title: 'Kill Process', subtitle: (input) => input.id },
};

/**
 * Get icon, title, subtitle for a tool part.
 * Matches SolidJS getToolInfo — message-part.tsx:184-270
 *
 * Icon names are Lucide icon names used by the React frontend.
 */
export function getToolInfo(
  tool: string,
  input: ToolCardInput = {},
): ToolInfo {
  const card = TOOL_CARDS[normalizeName(tool)];
  if (!card) return coreToolInfo(tool, input);
  const title = typeof card.title === 'string' ? card.title : card.title(input);
  return { icon: card.icon, title, subtitle: card.subtitle?.(input) };
}

/** The tool kinds every harness shares, by kind rather than by name. */
function coreToolInfo(
  tool: string,
  // biome-ignore lint/suspicious/noExplicitAny: tool inputs are free-form wire data with heterogeneous shapes
  input: Record<string, any>,
): ToolInfo {
  switch (toolKind(tool)) {
    case 'read':
      return { icon: 'glasses', title: 'Read', subtitle: getFilename(inputPath(input)) };
    case 'list':
      return { icon: 'list', title: 'List', subtitle: getDirectory(input.path) };
    case 'glob':
      return { icon: 'search', title: 'Glob', subtitle: input.pattern };
    case 'grep':
      return { icon: 'search', title: 'Grep', subtitle: input.pattern };
    case 'bash':
      return { icon: 'terminal', title: 'Shell', subtitle: input.description };
    case 'edit':
      return { icon: 'file-pen', title: 'Edit', subtitle: getFileWithDir(inputPath(input)) };
    case 'write':
      return { icon: 'file-pen', title: 'Write', subtitle: getFileWithDir(inputPath(input)) };
    case 'todowrite':
      return { icon: 'check-square', title: 'Todos' };
    case 'question':
      return { icon: 'message-circle', title: 'Questions' };
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
