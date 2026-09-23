/**
 * Pure rules behind the assistant turn's activity rows — thinking, bursts,
 * same-family groups, file chips, and tool-row state. Ported from apps/web
 * `features/session/turn/activity-burst.tsx`, `activity-step.tsx`,
 * `activity-file-chips.tsx`, `tool/tool-part-renderer.tsx`, and
 * `components/ui/text-shimmer.tsx`. The grouping and counting themselves come
 * from `@kortix/sdk` (`mergeBurstSteps`, `burstSummary`, `burstSummaryLabel`,
 * `stepLabel`), so web and mobile count one burst the same way.
 *
 * No React, no React Native. `components/session/turn/*` and
 * `components/session/tool/*` own how the rows look.
 */

import {
  burstSummary,
  burstSummaryLabel,
  familyForTool,
  formatDuration,
  isReasoningPart,
  isToolPart,
  mergeBurstSteps,
  normalizeActivityToolName,
  parseReadOutput,
  partOutcome,
  reasoningIsRunning,
  stepLabel,
  type BurstStep,
  type BurstSummary,
  type Part,
  type ToolPart,
} from '@kortix/sdk';

// ─── Thinking ────────────────────────────────────────────────────────────────

/**
 * The thought row's label. `formatDuration` returns '' under 1000ms, so a
 * sub-second or untimed thought reads "Thinking", never "0s".
 *
 * `liveElapsedMs` is measured on the client from the moment the row went live
 * (web `useLiveElapsedMs`), not from the part's `time.start`: a restored
 * transcript's start stamp would render "Thinking for 4h".
 */
export function thoughtLabel(running: boolean, liveElapsedMs: number, durationMs?: number): string {
  const elapsed = formatDuration(running ? liveElapsedMs : (durationMs ?? 0));
  if (!elapsed) return 'Thinking';
  return running ? `Thinking for ${elapsed}` : `Thought for ${elapsed}`;
}

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

// ─── Thought body ────────────────────────────────────────────────────────────

/**
 * A thought still being written sits in web's `max-h-54` scroll area, pinned to
 * the newest words. A finished thought shows in full, and the transcript
 * scrolls (a deliberate departure from web's permanent cap).
 */
export function thoughtBodyCapped(running: boolean): boolean {
  return running;
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

/**
 * True when a burst should stay open as "in progress" (web `burstIsRunning`).
 * The trailing burst stays open for the whole working turn so SSE gaps between
 * tool calls do not blink it shut.
 */
export function burstIsRunning(
  parts: ReadonlyArray<Part>,
  working: boolean,
  isTrailing = false,
): boolean {
  if (!working) return false;
  if (isTrailing) return true;
  return parts.some((part) => {
    const status = (part as { state?: { status?: string } }).state?.status;
    if (status === 'pending' || status === 'running') return true;
    if (isReasoningPart(part)) return reasoningIsRunning(part);
    return false;
  });
}

/** A `question` call with both the questions asked and the user's answers. */
export function isAnsweredQuestionPart(part: Part): boolean {
  if (!isToolPart(part)) return false;
  if (normalizeActivityToolName(part.tool) !== 'question') return false;
  const state = part.state as { input?: { questions?: unknown }; metadata?: { answers?: unknown } };
  const questions = state.input?.questions;
  const answers = state.metadata?.answers;
  return Array.isArray(questions) && questions.length > 0 && Array.isArray(answers) && answers.length > 0;
}

export interface BurstView {
  running: boolean;
  steps: BurstStep[];
  summary: BurstSummary;
  /** "Working · N steps", "Completed N steps", … */
  title: string;
  /** Exactly one call: no summary line, no rail, the row IS the burst. */
  bare: boolean;
  /** Every part merged to nothing (plumbing only): render no burst at all. */
  hidden: boolean;
}

export function burstView(
  parts: ReadonlyArray<Part>,
  working: boolean,
  isTrailing = false,
): BurstView {
  const running = burstIsRunning(parts, working, isTrailing);
  const merged = mergeBurstSteps(parts, (p) => stepLabel(p).tier);
  // An answered question owns its row, so it never shares a group row.
  const steps = merged.flatMap<BurstStep>((step) =>
    step.kind === 'group' && step.step.parts.some(isAnsweredQuestionPart)
      ? step.step.parts.map((part) => ({ kind: 'part' as const, key: part.id, part }))
      : [step],
  );
  const summary = burstSummary(parts);
  return {
    running,
    steps,
    summary,
    title: burstSummaryLabel(summary, running),
    bare: steps.length === 1 && summary.total === 1,
    hidden: steps.length === 0,
  };
}

// ─── Step rows ───────────────────────────────────────────────────────────────

/**
 * A bare row drops its leading glyph — the glyph anchors the chain rail, and one
 * row has no rail. Two exceptions keep it: a failed row (the mark is the only
 * verdict left) and a delegate row (it anchors a nested thread of its own).
 */
export function hideStepIcon(part: Part, bare: boolean): boolean {
  if (!bare) return false;
  if (!isToolPart(part)) return true;
  if (partOutcome(part) !== 'ok') return false;
  return familyForTool(part.tool) !== 'delegate';
}

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
export function activityIconKey(part: Part): ActivityIconKey {
  if (!isToolPart(part)) return 'generic';
  return ICON_KEY_BY_TOOL[normalizeActivityToolName(part.tool)] ?? 'generic';
}

// ─── Tool input ──────────────────────────────────────────────────────────────

const EMPTY_RECORD: Record<string, unknown> = Object.freeze({}) as Record<string, unknown>;

/** Web `parsePartialJSON`: closes open strings, brackets, and braces. */
export function parsePartialJson(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) return parsed;
  } catch {}
  try {
    let attempt = raw.trim();
    let braces = 0;
    let brackets = 0;
    let inString = false;
    let escape = false;
    for (const ch of attempt) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '{') braces++;
      if (ch === '}') braces--;
      if (ch === '[') brackets++;
      if (ch === ']') brackets--;
    }
    if (inString) attempt += '"';
    for (let i = 0; i < brackets; i++) attempt += ']';
    for (let i = 0; i < braces; i++) attempt += '}';
    const parsed = JSON.parse(attempt);
    if (typeof parsed === 'object' && parsed !== null) return parsed;
  } catch {}
  const result: Record<string, unknown> = {};
  const re = /"(\w+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    result[m[1]] = m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return result;
}

/** A call's arguments, including half-arrived ones in `state.raw` (web `partStreamingInput`). */
export function toolStreamingInput(part: Part): Record<string, unknown> {
  if (!isToolPart(part)) return EMPTY_RECORD;
  const state = part.state as { status: string; input?: Record<string, unknown>; raw?: string };
  if (state.input && Object.keys(state.input).length > 0) return state.input;
  if ((state.status === 'pending' || state.status === 'running') && state.raw) {
    return parsePartialJson(state.raw);
  }
  return state.input ?? EMPTY_RECORD;
}

// ─── File chips ──────────────────────────────────────────────────────────────

const FILE_CHIP_VERBS: ReadonlyMap<string, { verb: string; running: string }> = new Map([
  ['read', { verb: 'Read', running: 'Reading' }],
  ['write', { verb: 'Wrote', running: 'Writing' }],
]);

const PATH_KEYS = ['filePath', 'path', 'file'] as const;

export function isFileChipPart(part: Part): boolean {
  return isToolPart(part) && FILE_CHIP_VERBS.has(normalizeActivityToolName(part.tool));
}

function chipPath(part: ToolPart): string | undefined {
  const input = toolStreamingInput(part);
  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function completedOutput(part: ToolPart): string {
  const state = part.state as { status: string; output?: string };
  return state.status === 'completed' ? (state.output ?? '').trim() : '';
}

function isDirectoryTarget(part: ToolPart, path: string): boolean {
  if (path.endsWith('/')) return true;
  return parseReadOutput(completedOutput(part))?.type === 'directory';
}

export interface FileChipRun {
  /** Deduped paths, in first-seen order. */
  paths: string[];
  /** Parts that are not chips: failed, directory, or no path yet. */
  fallbacks: Part[];
  failedCount: number;
  /** Running wins over error (web `groupSteps.statusOf` precedence). */
  status: 'running' | 'error' | 'done';
  label: string;
  /** A bare run that produced no chip renders its plain tool rows instead. */
  bareFallback: boolean;
}

export function fileChipRun(
  parts: ReadonlyArray<Part>,
  options: { bare?: boolean; toDisplayPath?: (path: string) => string } = {},
): FileChipRun | null {
  const first = parts[0];
  const family =
    first && isToolPart(first) ? FILE_CHIP_VERBS.get(normalizeActivityToolName(first.tool)) : undefined;
  if (!family) return null;

  const paths: string[] = [];
  const seen = new Set<string>();
  const fallbacks: Part[] = [];
  let failedCount = 0;
  let inFlight = false;

  for (const part of parts) {
    if (!isToolPart(part)) {
      fallbacks.push(part);
      continue;
    }
    const status = part.state.status;
    if (status === 'pending' || status === 'running') inFlight = true;
    if (partOutcome(part) !== 'ok') {
      failedCount += 1;
      fallbacks.push(part);
      continue;
    }
    const path = chipPath(part);
    if (!path || isDirectoryTarget(part, path)) {
      fallbacks.push(part);
      continue;
    }
    if (!seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  }

  const status = inFlight ? 'running' : failedCount > 0 ? 'error' : 'done';
  const count = paths.length + fallbacks.length;
  const toDisplayPath = options.toDisplayPath ?? ((p: string) => p);
  const object =
    count === 1 && paths.length === 1 ? toDisplayPath(paths[0]) : `${count} ${count === 1 ? 'file' : 'files'}`;
  const label =
    `${status === 'running' ? family.running : family.verb} ${object}` +
    (status === 'error' ? ` · ${failedCount} failed` : '');

  return {
    paths,
    fallbacks,
    failedCount,
    status,
    label,
    bareFallback: Boolean(options.bare) && paths.length === 0,
  };
}

export function filenameOf(path: string): string {
  const segments = path.split('/').filter(Boolean);
  return segments[segments.length - 1] || path;
}

export type FileCategory =
  | 'image'
  | 'code'
  | 'text'
  | 'markdown'
  | 'pdf'
  | 'audio'
  | 'video'
  | 'csv'
  | 'spreadsheet'
  | 'archive'
  | 'database'
  | 'other';

function extensionOf(filename: string): string {
  return filename.includes('.') ? (filename.split('.').pop() ?? '').toLowerCase() : '';
}

/** Web `lib/utils/file-utils.ts` `getFileType`. */
export function fileCategory(filename: string): FileCategory {
  const ext = extensionOf(filename);
  const is = (list: string[]) => list.includes(ext);
  if (is(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'heic', 'heif', 'avif'])) return 'image';
  if (is(['js', 'jsx', 'ts', 'tsx', 'html', 'css', 'json', 'py', 'java', 'c', 'cpp'])) return 'code';
  if (is(['txt', 'log', 'env'])) return 'text';
  if (is(['md', 'markdown'])) return 'markdown';
  if (ext === 'pdf') return 'pdf';
  if (is(['mp3', 'wav', 'ogg', 'flac'])) return 'audio';
  if (is(['mp4', 'webm', 'mov', 'avi'])) return 'video';
  if (is(['csv', 'tsv'])) return 'csv';
  if (is(['xls', 'xlsx'])) return 'spreadsheet';
  if (is(['zip', 'rar', 'tar', 'gz'])) return 'archive';
  if (is(['db', 'sqlite', 'sql'])) return 'database';
  return 'other';
}

const CATEGORY_LABELS: Record<Exclude<FileCategory, 'code' | 'other'>, string> = {
  image: 'Image',
  text: 'Text',
  markdown: 'Markdown',
  pdf: 'PDF',
  audio: 'Audio',
  video: 'Video',
  csv: 'CSV',
  spreadsheet: 'Spreadsheet',
  archive: 'Archive',
  database: 'Database',
};

/**
 * The chip's second line: web `getTypeLabel`, with its "File" fallback
 * replaced by the extension (`activity-file-chips.tsx`).
 */
export function fileChipTypeLabel(filename: string): string {
  const ext = extensionOf(filename);
  const category = fileCategory(filename);
  if (category === 'code' || category === 'other') return ext ? ext.toUpperCase() : 'File';
  return CATEGORY_LABELS[category];
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
 * is the only discriminator (web `TurnLiveContext`).
 */
export function isStalePending(part: Part, turnLive: boolean): boolean {
  if (turnLive || !isToolPart(part)) return false;
  const state = part.state as { status: string; input?: Record<string, unknown>; raw?: string };
  return state.status === 'pending' && Object.keys(state.input ?? {}).length === 0 && !state.raw;
}

export function isToolRunning(part: Part, turnLive: boolean): boolean {
  if (!isToolPart(part)) return false;
  const status = part.state.status;
  return !isStalePending(part, turnLive) && (status === 'running' || status === 'pending');
}

export function toolDurationMs(part: Part): number | undefined {
  const time = (part as { state?: { time?: { start?: unknown; end?: unknown } } }).state?.time;
  const s = time?.start;
  const e = time?.end;
  if (typeof s === 'number' && typeof e === 'number' && e > s) return e - s;
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
