/**
 * What an `image_gen` card draws, from the call alone: pure data, no
 * framework, so the web card (`@kortix/ui`) and the mobile card read one
 * mapping.
 *
 * One call asks for one to four images (`prompts`; a Phase 1 call has one
 * `prompt`) and returns `{"action", "model", "provider", "images": [{"path",
 * "size", "prompt"}], "failed": [{"prompt", "error"}]}`; a path ends in
 * `.png`, `.jpg` or `.webp`. Older calls returned one image as
 * `{"path", …}`, a Replicate URL, or a bare path. A gateway refusal, of the
 * whole call or of one prompt, reads `Image generation failed (<status>):
 * <message> <suggestion> [Retry after N s.] [<code>]`; the code is the last
 * bracketed token, present only when the gateway sent one (kortixd
 * `image_gen.ts`, `refusal`).
 */
import type { SessionLogBlock, ToolCallBlock } from '../../session-log/types';
import { safeHttpUrl } from '../safe-url';
import { normalizeName } from './tool-meta';

export type ImageGenPhase = 'generating' | 'ready' | 'failed' | 'stopped';

export interface ImageGenView {
  /**
   * The call: `generating` while it runs, `ready` once it returned (each of
   * `images` says how its prompt went), `failed` when the whole call failed
   * (`error`), `stopped` when the turn stopped it.
   */
  phase: ImageGenPhase;
  action: 'generate' | 'edit';
  /** The prompts the call asked for; a Phase 1 call's one `prompt`. */
  prompts: string[];
  /**
   * `"<w> / <h>"`: the ratio the call asked for (`aspect_ratio`, else a legacy
   * `size`, else `1 / 1`), the same in every phase. A layout of several
   * images sizes its rectangle from it, so nothing moves when they land.
   */
  aspectRatio: string;
  /** The call's start (epoch ms), so the elapsed time survives a reload. */
  startedAt: number | null;
  /** The model that made the images (`codex/gpt-image-2`, `google/gemini-2.5-flash-image`); null until the call completed, or when the output names none. */
  model: string | null;
  /** The provider that answered, as the tool output names it; null until the call completed, or when the output names none. */
  provider: string | null;
  /**
   * One frame per image: one per prompt while the call runs (one while its
   * arguments stream), then each image it made and each prompt that failed,
   * in prompt order. Empty when the call `failed` or `stopped` as a whole.
   */
  images: {
    prompt: string;
    /** `generating`, `ready` (the image is in) or `failed` (this prompt failed; see `error`). */
    phase: ImageGenPhase;
    /**
     * `"<w> / <h>"`: the delivered size once the image came, else the
     * requested `aspect_ratio` (`16:9` is `16 / 9`), else a legacy requested
     * `size`; `auto` or neither is `1 / 1`.
     */
    aspectRatio: string;
    /** A sandbox file. */
    imagePath: string | null;
    /** Legacy outputs only (no `path`), and only an http(s) URL. */
    directUrl: string | null;
    error: ImageGenView['error'];
  }[];
  /** A failure: of the whole call on the view, of one prompt on an image. */
  error: {
    message: string;
    suggestion?: string;
    /** The gateway's stable code (`provider_not_connected`, `image_rate_limited`, …). */
    code?: string;
    /** Seconds until the image limit resets (`retry-after`). */
    retryAfterSeconds?: number;
    /**
     * True only for a trailing `[image_model_unavailable]`,
     * `[provider_not_connected]` or `[provider_reauth_required]` code: a
     * model connection in the project's settings fixes the call.
     */
    connectModel: boolean;
  } | null;
}

type ImageGenFrame = ImageGenView['images'][number];

const SQUARE = '1 / 1';
const CONNECT_CODES = new Set(['image_model_unavailable', 'provider_not_connected', 'provider_reauth_required']);
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

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;

/**
 * A one-image output → a sandbox path and/or a URL. Every older `image_gen`
 * (the kortixd tool and the retired Replicate tool) returned JSON; a bare,
 * possibly quoted image path is read too.
 */
function imageOutput(text: string): { imagePath: string | null; directUrl: string | null } {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      const p = parsed.path || parsed.image_path || parsed.output_path || null;
      const url = parsed.replicate_url || parsed.url || parsed.image_url || null;
      return { imagePath: p ? String(p).trim() : null, directUrl: url ? String(url).trim() : null };
    }
  } catch {
    // not JSON
  }
  const bare = text.replace(/^["'`]+|["'`]+$/g, '').trim();
  if (IMAGE_EXT.test(bare) && !/\s/.test(bare)) {
    return { imagePath: bare.startsWith('workspace/') ? `/${bare}` : bare, directUrl: null };
  }
  return { imagePath: null, directUrl: null };
}

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a;
}

/** `'1536x1024'` or `'3:2'` → `'3 / 2'`; anything else (`auto`) → null. */
function sizeAspect(size: unknown): string | null {
  const m = typeof size === 'string' ? /^(\d+)[x:](\d+)$/.exec(size.trim()) : null;
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
    connectModel: !!code && CONNECT_CODES.has(code[1]!),
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
  const prompts = Array.isArray(input.prompts)
    ? input.prompts.filter((prompt): prompt is string => typeof prompt === 'string')
    : typeof input.prompt === 'string'
      ? [input.prompt]
      : [];
  const requested = sizeAspect(input.aspect_ratio) ?? sizeAspect(input.size) ?? SQUARE;
  const frame = (prompt: string, phase: ImageGenPhase): ImageGenFrame => ({
    prompt,
    phase,
    aspectRatio: requested,
    imagePath: null,
    directUrl: null,
    error: null,
  });
  const view: ImageGenView = {
    phase: 'generating',
    action: input.action === 'edit' ? 'edit' : 'generate',
    prompts,
    aspectRatio: requested,
    startedAt: Number.isFinite(started) ? started : null,
    model: null,
    provider: null,
    images: (prompts.length ? prompts : ['']).map((prompt) => frame(prompt, 'generating')),
    error: null,
  };

  if (call.status === 'error') {
    const text = call.result?.error?.message || resultText(call);
    const stopped = call.result?.error?.code === 'interrupted' || call.result?.synthetic || STOPPED_TEXTS.has(text.trim());
    if (stopped) return { ...view, phase: 'stopped', images: [] };
    return { ...view, phase: 'failed', images: [], error: failure(text) };
  }
  if (call.status !== 'complete') return live === false ? { ...view, phase: 'stopped', images: [] } : view;

  const text = resultText(call);
  let output: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') output = parsed;
  } catch {
    // a legacy text output carries no size, model or provider
  }
  const named = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);
  const failedCard: ImageGenView = { ...view, phase: 'failed', images: [], error: failure(text) };
  const done: ImageGenView = { ...view, phase: 'ready', model: named(output.model), provider: named(output.provider) };

  if (Array.isArray(output.images) || Array.isArray(output.failed)) {
    const entries: ImageGenFrame[] = [];
    for (const image of Array.isArray(output.images) ? output.images : []) {
      // S6: a batch image is a sandbox path, never a URL.
      const path = named(image?.path);
      if (path) entries.push({ ...frame(String(image.prompt ?? ''), 'ready'), aspectRatio: sizeAspect(image.size) ?? requested, imagePath: path });
    }
    for (const miss of Array.isArray(output.failed) ? output.failed : []) {
      entries.push({ ...frame(String(miss?.prompt ?? ''), 'failed'), error: failure(String(miss?.error ?? '')) });
    }
    // In the order the call asked: a frame keeps its place from generating to done.
    const asked = prompts.flatMap((prompt) => {
      const at = entries.findIndex((entry) => entry.prompt === prompt);
      return at < 0 ? [] : entries.splice(at, 1);
    });
    const images = [...asked, ...entries];
    return images.length ? { ...done, images } : failedCard;
  }

  const { imagePath, directUrl } = imageOutput(text);
  // S6: a path means a sandbox file. A URL beside it is never loaded.
  const remote = imagePath ? null : directUrl ? safeHttpUrl(directUrl) : null;
  if (!imagePath && !remote) return failedCard;
  return {
    ...done,
    images: [{ ...frame(prompts[0] ?? '', 'ready'), aspectRatio: sizeAspect(output.size) ?? requested, imagePath, directUrl: remote }],
  };
}

/** The retry wait in the largest whole unit a person reads: `{ value: 2, unit: 'hour' }`. */
export function imageGenRetryDelay(seconds: number): { value: number; unit: 'second' | 'minute' | 'hour' } {
  if (seconds < 90) return { value: Math.max(1, Math.ceil(seconds)), unit: 'second' };
  if (seconds < 90 * 60) return { value: Math.ceil(seconds / 60), unit: 'minute' };
  return { value: Math.ceil(seconds / 3600), unit: 'hour' };
}

/** `0:42`, `2:05`. */
export function formatImageGenElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** One key per sandbox file, with or without the `/workspace/` prefix. */
function imageGenPathKey(path: string): string {
  return path.trim().replace(/^\/?workspace\//, '');
}

/** The images the turn's `image_gen` calls already drew, as paths without the `/workspace/` prefix. */
export function imagePathsShownByImageGen(blocks: readonly SessionLogBlock[]): Set<string> {
  const paths = new Set<string>();
  for (const block of blocks) {
    if (block.type !== 'tool_call' || !/^image[-_]gen$/.test(block.name)) continue;
    for (const image of imageGenView(block).images) if (image.imagePath) paths.add(imageGenPathKey(image.imagePath));
  }
  return paths;
}

/** The `show` items an `image_gen` card of the same turn did not draw already. */
export function withoutImageGenDuplicates<T extends { path?: string }>(items: T[], paths: ReadonlySet<string>): T[] {
  if (!paths.size) return items;
  return items.filter((item) => !item.path || !paths.has(imageGenPathKey(item.path)));
}

const SHOW_TOOLS = new Set(['show', 'show_user']);

/**
 * True when `call` is a `show` / `show_user` and every file it names is an
 * image the turn's `image_gen` already drew: the host renders nothing for it.
 */
export function showDrawnByImageGen(call: ToolCallBlock, paths: ReadonlySet<string>): boolean {
  if (!paths.size || !SHOW_TOOLS.has(normalizeName(call.name))) return false;
  const input = inputOf(call);
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
