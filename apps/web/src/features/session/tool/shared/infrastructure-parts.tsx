'use client';

import { stripBashMetadata } from '@kortix/shared/tool-output';
import { type ToolPart, type TriggerTitle } from '@/ui';
import { CheckIcon as Check, WarningCircleIcon as CircleAlert, MagnifyingGlassIcon as Search } from '@phosphor-icons/react';
import Loading from '@/components/ui/loading';
import { STATUS_TEXT } from '@/components/ui/status';
import { cn } from '@/lib/utils';

export function parsePartialJSON(raw: string): Record<string, unknown> {
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
  let m;
  while ((m = re.exec(raw)) !== null) {
    result[m[1]] = m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return result;
}

/**
 * The one empty object every "no input / no metadata yet" answer shares.
 *
 * `?? {}` looks free and is not: it hands back a NEW object on every call, and
 * these two helpers are the first thing almost every one of the ~58 tool
 * renderers does. A fresh identity there invalidates every `useMemo([input])`
 * and `useMemo([metadata])` downstream — so the memos those components were
 * carefully given could never hold, for any tool, on any render.
 *
 * Frozen so that a caller mutating what it believes is its own object fails
 * loudly instead of quietly poisoning every other tool on the screen.
 */
const EMPTY_RECORD: Record<string, unknown> = Object.freeze({});

function isEmptyObject(value: Record<string, unknown>): boolean {
  for (const key in value) {
    if (Object.hasOwn(value, key)) return false;
  }
  return true;
}

/**
 * A call's arguments, including the half-arrived ones — memoised per part.
 *
 * While a call streams, its arguments live in `state.raw` as incomplete JSON,
 * and `parsePartialJSON` builds a fresh object out of it on every render. That
 * object is the dependency of the `useMemo`s inside the tool components, so
 * during exactly the period when a tool is doing the most re-rendering, all of
 * its memoisation was guaranteed to miss.
 *
 * The cache is keyed on the part and guarded on BOTH `state` and the raw text,
 * because a streaming part keeps its object while its buffer grows.
 */
const STREAMING_INPUT_CACHE = new WeakMap<
  ToolPart,
  { state: ToolPart['state']; raw: string; input: Record<string, unknown> }
>();

export function partStreamingInput(part: ToolPart): Record<string, unknown> {
  const input = part.state.input;
  // A settled call's `input` is already one stable object owned by the part.
  if (input && !isEmptyObject(input)) return input;

  if (part.state.status === 'pending' || part.state.status === 'running') {
    const raw = 'raw' in part.state ? ((part.state as { raw?: string }).raw ?? '') : '';
    if (raw) {
      const cached = STREAMING_INPUT_CACHE.get(part);
      if (cached && cached.state === part.state && cached.raw === raw) return cached.input;

      const parsed = parsePartialJSON(raw);
      STREAMING_INPUT_CACHE.set(part, { state: part.state, raw, input: parsed });
      return parsed;
    }
  }
  return input ?? EMPTY_RECORD;
}

export function partInput(part: ToolPart): Record<string, unknown> {
  return partStreamingInput(part);
}

export function partMetadata(part: ToolPart): Record<string, unknown> {
  if (
    part.state.status === 'completed' ||
    part.state.status === 'running' ||
    part.state.status === 'error'
  ) {
    return (part.state.metadata as Record<string, unknown>) ?? EMPTY_RECORD;
  }
  return EMPTY_RECORD;
}

/**
 * A completed tool's output, stripped of transport noise — memoised per part.
 *
 * Nine call sites read this (`read`, `bash`, `edit`, `write`, `apply_patch`,
 * `web_search`, `generic`, `getToolDiagnostics`, the file-chip row), most of
 * them in the component BODY, so they run whether the row is open or closed.
 * Uncached, each call was two global regex passes plus a `trim()` over the whole
 * output — three full scans and two string copies of a payload that is routinely
 * tens of kilobytes, per row, per frame.
 *
 * Keyed the same way as `partOutcome`: a part is replaced rather than mutated
 * when it changes, so the object identity IS the version, and the guard on
 * `state` keeps the entry sound if a part object is ever reused.
 */
const OUTPUT_CACHE = new WeakMap<ToolPart, { state: ToolPart['state']; output: string }>();

export function partOutput(part: ToolPart): string {
  if (part.state.status !== 'completed') return '';

  const cached = OUTPUT_CACHE.get(part);
  if (cached && cached.state === part.state) return cached.output;

  const output = stripBashMetadata(part.state.output ?? '')
    .replace(/<\/?(?:system_info|exit_code|stderr_note)>[\s\S]*?(?:<\/\w+>)?$/g, '')
    .trim();

  OUTPUT_CACHE.set(part, { state: part.state, output });
  return output;
}

export function partStatus(part: ToolPart): string {
  return part.state.status;
}

export function firstMeaningfulLine(value: unknown, maxLength = 120): string {
  if (typeof value !== 'string') return '';
  const line = value
    .split('\n')
    .map((segment) => segment.trim())
    .find(Boolean);
  if (!line) return '';
  return line.length > maxLength ? `${line.slice(0, maxLength).trim()}…` : line;
}

export function getAgentCardLabel(input: Record<string, unknown>): string {
  const title = firstMeaningfulLine(input.title, 80);
  if (title) return title;

  const description = firstMeaningfulLine(input.description);
  if (description) return description;

  const message = firstMeaningfulLine(input.message);
  if (message) return message;

  const promptPreview = firstMeaningfulLine(input.prompt);
  if (promptPreview) return promptPreview;

  const agentId = firstMeaningfulLine(input.agent_id, 40);
  if (agentId) return `Agent ${agentId}`;

  return 'Worker task';
}

export function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'completed':
      return <Check className={cn('size-3 shrink-0', STATUS_TEXT.success)} />;
    case 'error':
      return <CircleAlert className="text-muted-foreground size-3 shrink-0" />;
    case 'running':
    case 'pending':
      return <Loading className="text-muted-foreground size-3 shrink-0" />;
    default:
      return null;
  }
}

export function isTriggerTitle(val: unknown): val is TriggerTitle {
  return (
    typeof val === 'object' &&
    val !== null &&
    'title' in val &&
    typeof (val as TriggerTitle).title === 'string'
  );
}

export function ToolEmptyState({ message }: { message: string }) {
  return (
    <div className="text-muted-foreground/40 flex items-center justify-center gap-1.5 px-3 py-3">
      <Search className="size-3" />
      <span className="text-xs">{message}</span>
    </div>
  );
}
