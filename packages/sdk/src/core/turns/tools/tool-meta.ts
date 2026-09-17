/**
 * Minimal tool metadata — matches the reference opencode implementation.
 *
 * Only two concerns:
 * 1. Which tools group into a "context" block (read, glob, grep, list).
 * 2. Extracting a one-line identity for any tool call (primary arg).
 */

import type { ToolPart } from '../../runtime/client';
import { humanizeSearchQuery } from './search-query';

// ─── Context tool grouping ───────────────────────────────────────────────

export const CONTEXT_TOOLS = new Set(['read', 'glob', 'grep', 'list']);

/** Normalize `oc-foo_bar` → `foo_bar`, `foo-bar` → `foo_bar`. */
export function normalizeName(name: string): string {
  return name.replace(/^oc-/, '').replace(/-/g, '_');
}

export function isContextTool(toolName: string): boolean {
  const n = normalizeName(toolName);
  return CONTEXT_TOOLS.has(n);
}

/**
 * Summary counts for a context group: { read: N, search: N, list: N }.
 * "search" covers both glob and grep.
 */
export function contextToolSummary(parts: ToolPart[]): {
  read: number;
  search: number;
  list: number;
} {
  let read = 0;
  let search = 0;
  let list = 0;
  for (const part of parts) {
    const n = normalizeName(part.tool);
    if (n === 'read') read++;
    else if (n === 'glob' || n === 'grep') search++;
    else if (n === 'list') list++;
  }
  return { read, search, list };
}

// ─── Primary-arg extraction ──────────────────────────────────────────────

function basename(p: string): string {
  if (!p) return '';
  const cleaned = p.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = cleaned.lastIndexOf('/');
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

function truncate(s: string, max = 60): string {
  if (!s) return '';
  const trimmed = s.replace(/\s+/g, ' ').trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * Extract the one thing that identifies a tool call in a one-liner.
 * Used for context-group item labels and any future compact views.
 */
export function getToolPrimaryArg(part: ToolPart): string {
  const state = (part.state ?? {}) as any;
  const input = (state.input ?? {}) as Record<string, any>;
  const key = normalizeName(part.tool);

  switch (key) {
    case 'read':
    case 'edit':
    case 'write':
    case 'morph_edit': {
      const p = input.filePath ?? input.file_path ?? input.path;
      return p ? basename(String(p)) : '';
    }
    case 'glob':
      return input.pattern ? String(input.pattern) : '';
    case 'grep': {
      const pat = input.pattern ?? input.query;
      const where = input.path ?? input.include;
      if (pat && where) return `"${truncate(String(pat), 40)}" in ${basename(String(where))}`;
      if (pat) return `"${truncate(String(pat), 60)}"`;
      return '';
    }
    case 'list':
      return input.path ? basename(String(input.path)) : '';
    case 'bash':
      return truncate(String(input.command ?? ''), 80);
    default:
      break;
  }

  // Generic fallback: first meaningful input key (matches reference's `label()` helper)
  const fallbackKeys = [
    'description',
    'query',
    'url',
    'filePath',
    'file_path',
    'path',
    'pattern',
    'name',
    'prompt',
  ];
  for (const k of fallbackKeys) {
    const v = input[k];
    if (typeof v === 'string' && v.length > 0) {
      // A query reaches the screen as prose, so it drops its engine operators
      // first — `site:daytona.io foo` is an instruction, not a subject. See
      // `humanizeSearchQuery`.
      return truncate(k === 'query' ? humanizeSearchQuery(v) || v : v, 60);
    }
  }
  return '';
}

/**
 * The titles `contextToolTrigger` gives the tools it knows by name.
 *
 * Every field is optional: a host passes its translated strings and keeps the
 * English default for any it omits. The defaults are the exact strings the
 * web app's `en` locale renders.
 */
export interface ContextToolTriggerLabels {
  /** `read` */
  read: string;
  /** `glob`, `grep` */
  search: string;
  /** `list` */
  list: string;
  /** `bash` */
  shell: string;
  /** `edit`, `morph_edit` */
  edit: string;
  /** `write` */
  write: string;
  /** `webfetch`, `web_fetch` */
  fetch: string;
  /** `websearch`, `web_search` */
  webSearch: string;
  /** `scrape`, `scrape_webpage` */
  scrape: string;
  /** `apply_patch` */
  applyPatch: string;
  /** `task` */
  task: string;
  /** `session_spawn`, `session_start_background` */
  worker: string;
  /** `project_select`, `project_list` */
  workspace: string;
}

export const DEFAULT_CONTEXT_TOOL_TRIGGER_LABELS: Readonly<ContextToolTriggerLabels> = {
  read: 'Read',
  search: 'Search',
  list: 'List',
  shell: 'Shell',
  edit: 'Edit',
  write: 'Write',
  fetch: 'Fetch',
  webSearch: 'Web Search',
  scrape: 'Scrape',
  applyPatch: 'Apply Patch',
  task: 'Task',
  worker: 'Worker',
  workspace: 'Workspace',
};

/**
 * Build a trigger { title, subtitle } for any tool inside the expanded
 * UnifiedGroup. Context tools get friendly names; others use their
 * canonical name in Title Case.
 */
export function contextToolTrigger(
  part: ToolPart,
  labels: Partial<ContextToolTriggerLabels> = {},
): {
  title: string;
  subtitle: string;
} {
  const l = { ...DEFAULT_CONTEXT_TOOL_TRIGGER_LABELS, ...labels };
  const n = normalizeName(part.tool);
  const sub = getToolPrimaryArg(part);
  switch (n) {
    case 'read':
      return { title: l.read, subtitle: sub };
    case 'glob':
    case 'grep':
      return { title: l.search, subtitle: sub };
    case 'list':
      return { title: l.list, subtitle: sub };
    case 'bash':
      return { title: l.shell, subtitle: sub };
    case 'edit':
    case 'morph_edit':
      return { title: l.edit, subtitle: sub };
    case 'write':
      return { title: l.write, subtitle: sub };
    case 'webfetch':
    case 'web_fetch':
      return { title: l.fetch, subtitle: sub };
    case 'websearch':
    case 'web_search':
      return { title: l.webSearch, subtitle: sub };
    case 'scrape':
    case 'scrape_webpage':
      return { title: l.scrape, subtitle: sub };
    case 'apply_patch':
      return { title: l.applyPatch, subtitle: sub };
    case 'task':
      return { title: l.task, subtitle: sub };
    case 'session_spawn':
    case 'session_start_background':
      return { title: l.worker, subtitle: sub };
    case 'project_select':
    case 'project_list':
      return { title: l.workspace, subtitle: sub };
    default: {
      const display = n.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      return { title: display, subtitle: sub };
    }
  }
}
