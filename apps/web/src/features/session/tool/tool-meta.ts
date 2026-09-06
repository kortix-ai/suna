import type { UiTranslator } from '@/i18n/translator';
/**
 * Minimal tool metadata — matches the reference opencode implementation.
 *
 * Only two concerns:
 * 1. Which tools group into a "context" block (read, glob, grep, list).
 * 2. Extracting a one-line identity for any tool call (primary arg).
 */

import { truncate as sharedTruncate } from '@/lib/utils/string';
import type { ToolPart } from '@/ui';
import { humanizeSearchQuery } from './shared/search-query';

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
  return sharedTruncate(trimmed, max);
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
 * Build a trigger { title, subtitle } for any tool inside the expanded
 * UnifiedGroup. Context tools get friendly names; others use their
 * canonical name in Title Case.
 */
export function contextToolTrigger(
  part: ToolPart,
  tI18nComplete: UiTranslator,
): {
  title: string;
  subtitle: string;
} {
  const n = normalizeName(part.tool);
  const sub = getToolPrimaryArg(part);
  switch (n) {
    case 'read':
      return { title: tI18nComplete.raw('text9b9a8d05a7ec'), subtitle: sub };
    case 'glob':
      return { title: tI18nComplete.raw('text49c266baaaa7'), subtitle: sub };
    case 'grep':
      return { title: tI18nComplete.raw('text49c266baaaa7'), subtitle: sub };
    case 'list':
      return { title: tI18nComplete.raw('text6f202f54a7b2'), subtitle: sub };
    case 'bash':
      return { title: tI18nComplete.raw('texta733285486d5'), subtitle: sub };
    case 'edit':
    case 'morph_edit':
      return { title: tI18nComplete.raw('text464c4ffd019e'), subtitle: sub };
    case 'write':
      return { title: tI18nComplete.raw('text3f00927a7193'), subtitle: sub };
    case 'webfetch':
    case 'web_fetch':
      return { title: tI18nComplete.raw('textcd7d61bf7e38'), subtitle: sub };
    case 'websearch':
    case 'web_search':
      return { title: tI18nComplete.raw('textd04fc7d7e197'), subtitle: sub };
    case 'scrape':
    case 'scrape_webpage':
      return { title: tI18nComplete.raw('text9af605fcac97'), subtitle: sub };
    case 'apply_patch':
      return { title: tI18nComplete.raw('text01bcfe7a9296'), subtitle: sub };
    case 'task':
      return { title: tI18nComplete.raw('text4bc74b21357c'), subtitle: sub };
    case 'session_spawn':
    case 'session_start_background':
      return { title: tI18nComplete.raw('texta67b04cd5c49'), subtitle: sub };
    case 'project_select':
      return { title: tI18nComplete.raw('text87bb59ba2f92'), subtitle: sub };
    case 'project_list':
      return { title: tI18nComplete.raw('text87bb59ba2f92'), subtitle: sub };
    default: {
      const display = n.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      return { title: display, subtitle: sub };
    }
  }
}
