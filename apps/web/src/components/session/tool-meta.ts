/**
 * Minimal tool metadata — matches the reference opencode implementation.
 *
 * Only two concerns:
 * 1. Which tools group into a "context" block (read, glob, grep, list).
 * 2. Extracting a one-line identity for any tool call (primary arg).
 */

import type { ToolPart } from '@/ui';

// ─── Context tool grouping ───────────────────────────────────────────────

export const CONTEXT_TOOLS = new Set(['read', 'glob', 'grep', 'list']);

/** Normalize `oc-foo_bar` → `foo_bar`, `foo-bar` → `foo_bar`. */
function normalizeName(name: string): string {
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
  return trimmed.length > max ? trimmed.slice(0, max - 1) + '…' : trimmed;
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
      if (pat && where)
        return `"${truncate(String(pat), 40)}" in ${basename(String(where))}`;
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
    if (typeof v === 'string' && v.length > 0) return truncate(v, 60);
  }
  return '';
}

/**
 * Build a trigger { title, subtitle } for any tool inside the expanded
 * UnifiedGroup. Context tools get friendly names; others use their
 * canonical name in Title Case.
 */
export function contextToolTrigger(part: ToolPart): {
  title: string;
  subtitle: string;
} {
  const n = normalizeName(part.tool);
  const sub = getToolPrimaryArg(part);
  switch (n) {
    case 'read':
      return { title: 'Read', subtitle: sub };
    case 'glob':
      return { title: 'Search', subtitle: sub };
    case 'grep':
      return { title: 'Search', subtitle: sub };
    case 'list':
      return { title: 'List', subtitle: sub };
    case 'bash':
      return { title: 'Shell', subtitle: sub };
    case 'edit':
    case 'morph_edit':
      return { title: 'Edit', subtitle: sub };
    case 'write':
      return { title: 'Write', subtitle: sub };
    case 'webfetch':
      return { title: 'Fetch', subtitle: sub };
    case 'websearch':
    case 'web_search':
      return { title: 'Web Search', subtitle: sub };
    case 'task':
      return { title: 'Task', subtitle: sub };
    case 'session_spawn':
    case 'session_start_background':
      return { title: 'Worker', subtitle: sub };
    case 'project_select':
      return { title: 'Project', subtitle: sub };
    case 'project_list':
      return { title: 'Projects', subtitle: sub };
    default: {
      const display = n
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
      return { title: display, subtitle: sub };
    }
  }
}
