/**
 * What the `image_gen` card draws, from the call alone: no React, no DOM, so
 * the mobile card ports the same mapping and its tests.
 *
 * The tool returns `{"path", "action", "size", "model"}` and fails with the
 * gateway's text, `<message> <suggestion>`.
 */
import type { SessionLogBlock, ToolCallBlock } from '@kortix/sdk';
import { safeHttpUrl } from '@kortix/shared';

import { parseImageOutput } from '../../media/image-output-path';

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
  error: { message: string; suggestion?: string; connectChatGpt: boolean } | null;
}

const SQUARE = '1 / 1';
const CONNECT_CODES = /\b(provider_not_connected|provider_reauth_required)\b/;
const CONNECT_TEXT = /\b(re)?connect\b[^.]*\b(chatgpt|codex)\b/i;
const LEADING_CODE = /^(?:error:\s*)?(?:[a-z]+(?:_[a-z]+)+:\s*)?/i;
const STOPPED_TEXT = /\b(aborted|interrupted)\b|^No result provided/i;

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
  const connectChatGpt = CONNECT_CODES.test(text) || CONNECT_TEXT.test(text);
  const clean = text.replace(LEADING_CODE, '').trim();
  // The gateway joins its message and its suggestion with a space: split after the first sentence.
  const cut = clean.search(/(?<=[.!?])\s+/);
  if (cut < 0) return { message: clean, connectChatGpt };
  return { message: clean.slice(0, cut), suggestion: clean.slice(cut).trim(), connectChatGpt };
}

export function imageGenView(call: ToolCallBlock): ImageGenView {
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
    const stopped = call.result?.error?.code === 'interrupted' || call.result?.synthetic || STOPPED_TEXT.test(text);
    if (stopped) return { ...view, phase: 'stopped' };
    return { ...view, phase: 'failed', error: failure(text) };
  }
  if (call.status !== 'complete') return view;

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
