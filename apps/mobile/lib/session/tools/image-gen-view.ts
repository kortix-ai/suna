/**
 * What the `image_gen` card draws, from the call alone. Port of packages/ui
 * `session/tool/tools/image-gen-view.ts` (mobile does not depend on
 * `@kortix/ui`); its tests are ported verbatim beside this file.
 *
 * The tool returns `{"path", "action", "size", "model"}`. A gateway refusal
 * throws `Image generation failed (<status>): <message> <suggestion>
 * [Retry after N s.] [<code>]`; the code is the last bracketed token, present
 * only when the gateway sent one (`image_gen.ts`, `refusal`).
 *
 * Mobile-only: `aspectRatioValue` (React Native takes a number).
 */
import type { SessionLogBlock, ToolCallBlock } from '@kortix/sdk';
import { safeHttpUrl } from '@kortix/shared';

import { parseImageOutput } from './web-media';

export type ImageGenPhase = 'generating' | 'ready' | 'failed' | 'stopped';

export interface ImageGenView {
  phase: ImageGenPhase;
  action: 'generate' | 'edit';
  prompt: string;
  /** `"<w> / <h>"`: the delivered size once the call completed, else the requested size; `auto` is `1 / 1`. */
  aspectRatio: string;
  imagePath: string | null;
  /** Legacy outputs only (no `path`), and only an http(s) URL. */
  directUrl: string | null;
  /** The call's start (epoch ms), so the elapsed time survives a reload. */
  startedAt: number | null;
  error: {
    message: string;
    suggestion?: string;
    /** The gateway's stable code (`provider_not_connected`, `image_rate_limited`, …). */
    code?: string;
    /** Seconds until the ChatGPT image limit resets (`retry-after`). */
    retryAfterSeconds?: number;
    /** True only for the trailing `[provider_not_connected]` / `[provider_reauth_required]` code. */
    connectChatGpt: boolean;
  } | null;
}

const SQUARE = '1 / 1';
const CONNECT_CODES = new Set(['provider_not_connected', 'provider_reauth_required']);
const TRAILING_CODE = /\s*\[([a-z][a-z0-9_]*)\]\s*$/;
const TRAILING_RETRY = /\s*Retry after (\d+) s\.\s*$/;
const REFUSAL_PREFIX = /^Image generation failed \(\d+\):\s*/;
/**
 * The exact texts a stop leaves on the call: pi's tool loop when the turn's
 * signal aborted (`Operation aborted`), the tool's own fetch abort in Bun
 * (`The operation was aborted.`), pi's close of a call that never returned
 * (`No result provided`, also `synthetic`). A timeout ("The operation timed
 * out.") or an upstream error is a failure, not a stop.
 */
const STOPPED_TEXTS = new Set(['Operation aborted', 'The operation was aborted.', 'No result provided']);

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a;
}

/** `'1536x1024'` → `'3 / 2'`; anything else → null. */
function sizeAspect(size: unknown): string | null {
  const m = typeof size === 'string' ? /^(\d+)x(\d+)$/.exec(size.trim()) : null;
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!w || !h) return null;
  const d = gcd(w, h);
  return `${w / d} / ${h / d}`;
}

function resultText(call: ToolCallBlock): string {
  return (call.result?.content ?? [])
    .flatMap((c) => (c.type === 'text' ? [c.text] : []))
    .join('')
    .trim();
}

function inputOf(call: ToolCallBlock): Record<string, unknown> {
  const input = call.input;
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) return input as Record<string, unknown>;
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      if (typeof parsed === 'object' && parsed !== null) return parsed;
    } catch {
      // a partial argument stream: the card shows it once it parses
    }
  }
  return {};
}

function failure(text: string): NonNullable<ImageGenView['error']> {
  let rest = text.trim();
  const code = TRAILING_CODE.exec(rest);
  if (code) rest = rest.slice(0, code.index);
  const retry = TRAILING_RETRY.exec(rest);
  if (retry) rest = rest.slice(0, retry.index);
  rest = rest.replace(REFUSAL_PREFIX, '').trim();
  const error: NonNullable<ImageGenView['error']> = {
    message: rest,
    connectChatGpt: !!code && CONNECT_CODES.has(code[1]!),
    ...(code && { code: code[1] }),
    ...(retry && { retryAfterSeconds: Number(retry[1]) }),
  };
  // The tool joins the gateway's message and suggestion with a space: split after the first sentence.
  const cut = rest.search(/(?<=[.!?])\s+/);
  if (cut < 0) return error;
  return { ...error, message: rest.slice(0, cut), suggestion: rest.slice(cut).trim() };
}

/**
 * `live`: whether the turn that owns the call still runs, when the host knows
 * it (the transcript does). A call still open on a turn that ended was stopped:
 * the transcript hands a call the closure rule closed back as open
 * (`sessionLogOpenCall`), so its own status cannot say so.
 */
export function imageGenView(call: ToolCallBlock, live?: boolean): ImageGenView {
  const input = inputOf(call);
  const started = call.started_at ? Date.parse(call.started_at) : NaN;
  const view: ImageGenView = {
    phase: 'generating',
    action: input.action === 'edit' ? 'edit' : 'generate',
    prompt: typeof input.prompt === 'string' ? input.prompt : '',
    aspectRatio: sizeAspect(input.size) ?? SQUARE,
    imagePath: null,
    directUrl: null,
    startedAt: Number.isFinite(started) ? started : null,
    error: null,
  };

  if (call.status === 'error') {
    const text = call.result?.error?.message || resultText(call);
    const stopped = call.result?.error?.code === 'interrupted' || call.result?.synthetic || STOPPED_TEXTS.has(text.trim());
    if (stopped) return { ...view, phase: 'stopped' };
    return { ...view, phase: 'failed', error: failure(text) };
  }
  if (call.status !== 'complete') return live === false ? { ...view, phase: 'stopped' } : view;

  const text = resultText(call);
  const { imagePath, directUrl } = parseImageOutput(text);
  // S6: a path means a sandbox file. A URL beside it is never loaded.
  const remote = imagePath ? null : directUrl ? safeHttpUrl(directUrl) : null;
  if (!imagePath && !remote) return { ...view, phase: 'failed', error: failure(text) };
  let size: unknown;
  try {
    size = JSON.parse(text).size;
  } catch {
    // a legacy text output carries no size
  }
  return {
    ...view,
    phase: 'ready',
    aspectRatio: sizeAspect(size) ?? view.aspectRatio,
    imagePath,
    directUrl: remote,
  };
}

/** The retry wait in the largest whole unit a person reads: `{ value: 2, unit: 'hour' }`. */
export function retryDelay(seconds: number): { value: number; unit: 'second' | 'minute' | 'hour' } {
  if (seconds < 90) return { value: Math.max(1, Math.ceil(seconds)), unit: 'second' };
  if (seconds < 90 * 60) return { value: Math.ceil(seconds / 60), unit: 'minute' };
  return { value: Math.ceil(seconds / 3600), unit: 'hour' };
}

/** `0:42`, `2:05`. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** One key per sandbox file, with or without the `/workspace/` prefix. */
export function imagePathKey(path: string): string {
  return path.trim().replace(/^\/?workspace\//, '');
}

/** The images the turn's `image_gen` calls already drew, as `imagePathKey`s. */
export function imagePathsShownByImageGen(blocks: readonly SessionLogBlock[]): Set<string> {
  const paths = new Set<string>();
  for (const block of blocks) {
    if (block.type !== 'tool_call' || !/^image[-_]gen$/.test(block.name)) continue;
    const view = imageGenView(block);
    if (view.phase === 'ready' && view.imagePath) paths.add(imagePathKey(view.imagePath));
  }
  return paths;
}

/** The `show` items an `image_gen` card of the same turn did not draw already. */
export function withoutImageGenDuplicates<T extends { path?: string }>(items: T[], paths: ReadonlySet<string>): T[] {
  if (!paths.size) return items;
  return items.filter((item) => !item.path || !paths.has(imagePathKey(item.path)));
}

/** True when every file a `show` input names is an image the turn's `image_gen` already drew. */
export function showDrawnByImageGen(input: Record<string, unknown>, paths: ReadonlySet<string>): boolean {
  if (!paths.size) return false;
  let items: unknown = input.items;
  if (typeof items === 'string') {
    try {
      items = JSON.parse(items);
    } catch {
      items = null;
    }
  }
  const list: { path?: string }[] = Array.isArray(items) && items.length
    ? items
    : typeof input.path === 'string' && input.path
      ? [{ path: input.path }]
      : [];
  return list.length > 0 && withoutImageGenDuplicates(list, paths).length === 0;
}

/** `'3 / 2'` → `1.5`, the number React Native's `aspectRatio` takes; a bad string → `1`. */
export function aspectRatioValue(ratio: string): number {
  const [w, h] = ratio.split('/').map(Number);
  return w && h ? w / h : 1;
}
