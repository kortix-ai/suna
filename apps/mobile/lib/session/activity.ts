/**
 * Pure rules behind the assistant turn's activity rows — bursts, same-family
 * groups, and tool-row state. Ported from apps/web
 * `features/session/turn/activity-burst.tsx`, `activity-step.tsx`,
 * `tool/tool-part-renderer.tsx`, and
 * `components/ui/text-shimmer.tsx`. The grouping and counting themselves come
 * from `@kortix/sdk`'s block burst layer (`sessionLogBurstSteps`,
 * `sessionLogBurstSummary`, `burstSummaryLabel`), so web and mobile count one
 * burst the same way. Every row reads session-log blocks.
 *
 * No React, no React Native. `components/session/turn/*` and
 * `components/session/tool/*` own how the rows look.
 */

import {
  burstSummaryLabel,
  normalizeActivityToolName,
  sessionLogBurstRunning,
  sessionLogBurstSteps,
  sessionLogBurstSummary,
  sessionLogCallStatus,
  sessionLogOpenCall,
  type BurstSummary,
  type SessionLogBlock,
  type SessionLogBurstStep,
  type ToolCallBlock,
} from '@kortix/sdk';

import { partStreamingInput } from './tool-part-accessors';

// ─── Disclosure ──────────────────────────────────────────────────────────────

/**
 * One rule for every disclosure in the turn: follow the automatic state
 * (open while running) until the user toggles, then the user's choice wins
 * permanently. `forceOpen` (a pending permission or question) wins over both.
 */
export function resolveDisclosureOpen(input: {
  userChoice?: boolean;
  auto: boolean;
  forceOpen?: boolean;
}): boolean {
  if (input.forceOpen) return true;
  return input.userChoice ?? input.auto;
}

/**
 * `maxHeight` for a disclosure body with no cap in practice. A numeric sentinel,
 * not `undefined`: Reanimated never resets a style key that an animated style
 * stops returning, so a dropped `height` stays applied to the view forever.
 */
export const DISCLOSURE_UNCAPPED_HEIGHT = 10_000_000;

/**
 * The body's `maxHeight` for open progress 0..1 and the LATEST measured content
 * height. At rest open the body is uncapped: the height measured when it opened
 * goes stale the moment a nested row opens, a step streams in, or markdown
 * re-lays out, and capping at it clips every row below.
 */
export function disclosureBodyMaxHeight(progress: number, contentHeight: number): number {
  'worklet';
  if (progress >= 1) return DISCLOSURE_UNCAPPED_HEIGHT;
  if (progress <= 0) return 0;
  return Math.max(0, contentHeight) * progress;
}

/** Top/bottom fade visibility for a scroll area (web `FadedScrollArea`). */
export function scrollFades(
  offsetY: number,
  contentHeight: number,
  viewportHeight: number,
): { start: boolean; end: boolean } {
  const max = contentHeight - viewportHeight;
  if (max <= 1) return { start: false, end: false };
  return { start: offsetY > 1, end: offsetY < max - 1 };
}

/** Distance from the end, in px, that still counts as reading the newest text. */
const PIN_SLOP = 16;

/** The reader is at (or near) the end, so new text keeps the area pinned there. */
export function isScrollPinnedToEnd(offsetY: number, contentHeight: number, viewportHeight: number): boolean {
  return offsetY >= contentHeight - viewportHeight - PIN_SLOP;
}

// ─── Memo comparison ─────────────────────────────────────────────────────────

/**
 * Element-wise identity. A streaming turn rebuilds its segment arrays every
 * frame while the parts inside keep their identity (web `same-parts.ts`).
 */
export function samePartsList<T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ─── Burst ───────────────────────────────────────────────────────────────────

export interface BurstView {
  running: boolean;
  steps: SessionLogBurstStep[];
  summary: BurstSummary;
  /**
   * "Working · N steps", "Completed N steps", … Every burst, even one thought
   * or one call, renders only this line; tapping it opens the activity sheet.
   * Mobile never expands a step inline (Jay, 2026-09-24).
   */
  title: string;
  /** Every block merged to nothing (plumbing only): render no burst at all. */
  hidden: boolean;
}

/**
 * The burst's line and sheet steps, from the SDK's block burst layer
 * (`sessionLogBurstSteps`, `sessionLogBurstSummary`, `sessionLogBurstRunning`):
 * the trailing burst stays running for the whole working turn, so SSE gaps
 * between calls do not blink it shut, and an answered question owns its row.
 */
export function burstView(
  allBlocks: ReadonlyArray<SessionLogBlock>,
  working: boolean,
  isTrailing = false,
): BurstView {
  // Mobile never shows thinking: a thought is not a step, in the row or the sheet.
  const blocks = allBlocks.filter((block) => block.type !== 'reasoning');
  const running = sessionLogBurstRunning(blocks, { working, trailing: isTrailing });
  const steps = sessionLogBurstSteps(blocks);
  const summary = sessionLogBurstSummary(blocks);
  return {
    running,
    steps,
    summary,
    title: burstSummaryLabel(summary, running),
    hidden: steps.length === 0,
  };
}

// ─── Step rows ───────────────────────────────────────────────────────────────

export type ActivityIconKey =
  | 'read'
  | 'edit'
  | 'shell'
  | 'search'
  | 'list'
  | 'web'
  | 'delegate'
  | 'skill'
  | 'generic';

const ICON_KEY_BY_TOOL: Record<string, ActivityIconKey> = {
  read: 'read',
  write: 'edit',
  edit: 'edit',
  apply_patch: 'edit',
  bash: 'shell',
  glob: 'search',
  grep: 'search',
  list: 'list',
  web_search: 'web',
  websearch: 'web',
  webfetch: 'web',
  web_fetch: 'web',
  scrape: 'web',
  scrape_webpage: 'web',
  task: 'delegate',
  skill: 'skill',
};

/** Web `activity-step.tsx` `ICONS` table, as keys. */
export function activityIconKey(block: SessionLogBlock): ActivityIconKey {
  if (block.type !== 'tool_call') return 'generic';
  return ICON_KEY_BY_TOOL[normalizeActivityToolName(block.name)] ?? 'generic';
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export interface ValidationIssue {
  code: string;
  message: string;
  path: string[];
  values?: string[];
}

export interface ParsedErrorContent {
  summary: string;
  traceback: string | null;
  errorType: string | null;
  validationIssues: ValidationIssue[] | null;
}

/** Web `tool/shared/error-and-connector.tsx` `parseErrorContent`. */
export function parseErrorContent(error: string): ParsedErrorContent {
  const cleaned = error.replace(/^Error:\s*/, '');
  const trimmed = cleaned.trim();

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const arr: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
      const isIssue = (item: unknown): item is Record<string, unknown> =>
        !!item && typeof item === 'object' && 'message' in item;
      if (arr.length > 0 && arr.every(isIssue)) {
        const issues: ValidationIssue[] = (arr as Record<string, unknown>[]).map((item) => ({
          code: typeof item.code === 'string' && item.code ? item.code : 'error',
          message: typeof item.message === 'string' && item.message ? item.message : String(item),
          path: Array.isArray(item.path) ? item.path.map(String) : [],
          values: Array.isArray(item.values) ? item.values.map(String) : undefined,
        }));
        const first = issues[0];
        const pathStr = first.path.length > 0 ? first.path.join('.') : '';
        return {
          summary: pathStr ? `${pathStr}: ${first.message}` : first.message,
          traceback: null,
          errorType: 'Validation Error',
          validationIssues: issues,
        };
      }
    } catch {}
  }

  const tracebackIdx = cleaned.indexOf('Traceback (most recent call last):');
  if (tracebackIdx >= 0) {
    const before = cleaned.slice(0, tracebackIdx).trim();
    const traceSection = cleaned.slice(tracebackIdx);
    const lines = traceSection.split('\n').filter((l) => l.trim());
    const lastLine = lines[lines.length - 1] || '';
    const typeMatch = lastLine.match(/^([\w._]+(?:Error|Exception|Warning)):\s*/);
    const errorType = typeMatch ? typeMatch[1].split('.').pop() || typeMatch[1] : null;
    const summary = before || (errorType ? lastLine : lastLine.slice(0, 120));
    return { summary, traceback: traceSection, errorType, validationIssues: null };
  }

  const stackIdx = cleaned.indexOf('\n    at ');
  if (stackIdx >= 0) {
    return {
      summary: cleaned.slice(0, stackIdx).trim(),
      traceback: cleaned.slice(stackIdx),
      errorType: null,
      validationIssues: null,
    };
  }

  const colonIdx = cleaned.indexOf(': ');
  if (colonIdx > 0 && colonIdx < 60) {
    const left = cleaned.slice(0, colonIdx);
    if (/^[\w._-]+$/.test(left)) {
      return { summary: cleaned, traceback: null, errorType: left, validationIssues: null };
    }
  }

  return { summary: cleaned, traceback: null, errorType: null, validationIssues: null };
}

// ─── Tool row state ──────────────────────────────────────────────────────────

/**
 * A call whose arguments never arrived, from a turn that is over. While the
 * turn is live the same shape is a call that has not spoken YET, so `turnLive`
 * is the only discriminator (web `TurnLiveContext`). A call the closure rule
 * closed reads as the open call it was (`sessionLogCallStatus`).
 */
export function isStalePending(call: ToolCallBlock, turnLive: boolean): boolean {
  const open = sessionLogOpenCall(call);
  return (
    sessionLogCallStatus(open, turnLive) === 'interrupted' &&
    open.status === 'pending' &&
    Object.keys(partStreamingInput(open)).length === 0
  );
}

export function isToolRunning(call: ToolCallBlock, turnLive: boolean): boolean {
  const { status } = sessionLogOpenCall(call);
  return !isStalePending(call, turnLive) && (status === 'running' || status === 'pending');
}

export function toolDurationMs(call: ToolCallBlock): number | undefined {
  const s = call.started_at ? Date.parse(call.started_at) : NaN;
  const e = call.ended_at ? Date.parse(call.ended_at) : NaN;
  if (Number.isFinite(s) && Number.isFinite(e) && e > s) return e - s;
  return undefined;
}

/** `linear/create_issue` → `{ display: 'Create Issue', server: 'linear' }` (web error row). */
export function toolDisplayName(tool: string): { display: string; server: string | null } {
  const slash = tool.lastIndexOf('/');
  const server = slash > 0 ? tool.slice(0, slash) : null;
  const name = slash > 0 ? tool.slice(slash + 1) : tool;
  const display = name.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return { display, server };
}

/** Web `ui/types.ts` `PERMISSION_LABELS`. */
const PERMISSION_LABELS: Record<string, string> = {
  bash: 'Run command',
  edit: 'Edit file',
  write: 'Write file',
  read: 'Read file',
  webfetch: 'Fetch URL',
  mcp: 'Use MCP tool',
  doom_loop: 'Repeated tool call',
};

export function permissionLabel(permission: string): string {
  return PERMISSION_LABELS[permission] || permission;
}

// ─── Text shimmer ────────────────────────────────────────────────────────────

/** Web `text-shimmer.tsx`: `duration={2}`, `repeatDelay` 0.5s, `bg-[length:250%]`, `spread={2}`. */
export const SHIMMER = {
  sweepMs: 2000,
  holdMs: 500,
  backgroundScale: 2.5,
  spreadPerChar: 2,
} as const;

/** Half-width of the highlight band in px: text length × 2px (web `dynamicSpread`). */
export function shimmerSpread(text: string, spreadPerChar: number = SHIMMER.spreadPerChar): number {
  return text.length * spreadPerChar;
}

/**
 * Band centre in px for sweep progress 0..1 over text width `width`.
 *
 * Web animates `background-position` 100% → 0% on a 250%-wide background. The
 * offset is `p × (W − 2.5W)`, so the background's centre (the band) moves from
 * `−1.5W + 1.25W = −0.25W` to `1.25W`.
 */
export function shimmerBandCenter(progress: number, width: number): number {
  'worklet';
  const scale = 2.5;
  const offset = (1 - progress) * (width - scale * width);
  return offset + (scale * width) / 2;
}
