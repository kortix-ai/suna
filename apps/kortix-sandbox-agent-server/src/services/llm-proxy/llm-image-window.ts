/**
 * Inline-image window applied INSIDE the sandbox, before a chat request leaves
 * the box.
 *
 * The gateway already keeps only the most recent images of a request
 * (@kortix/llm-gateway image-window.ts) — but it can only do so after the whole
 * body has crossed the wire. A vision-heavy agent turn accumulates every
 * screenshot it ever read as base64 in its transcript; on SampleCo
 * 2026-08-25 that reached 118 inline images and >128 MiB per request, which
 * the gateway's runtime refused with 413 before the pipeline (and its window)
 * ran. The daemon's localhost LLM proxy applies the same window here so the
 * body that leaves the sandbox is already small. Same defaults as the gateway;
 * the gateway's own pass is then a no-op.
 *
 * Shapes covered: OpenAI chat (`messages[].content[]` with `image_url` /
 * `input_image`), Anthropic (`messages[].content[]` with `image`, and the
 * images inside a `tool_result` block's `content[]`) and the OpenAI Responses
 * API (`input[].content[]` and `input[].output[]` with `input_image`).
 *
 * Claude Code puts every screenshot a tool returned inside a `tool_result`
 * block, and resends them all on every step. A window that read only the top
 * level counted none of them: on 2026-11-06 a real `claude` session grew by
 * ~0.32 MB per screenshot read through this proxy, passed Anthropic's 32 MB
 * cap, and every later turn of that session failed with "Request too large".
 *
 * The window bounds count and bytes with the gateway's rule
 * (`packages/llm-gateway/src/pipeline/image-window.ts`, the same cuts: a test
 * pins it): Bedrock and Anthropic refuse a body over ~32 MB at any token count.
 */
export interface ImageWindowOptions {
  /** Requests carrying at most this many inline images pass untouched. */
  maxImages: number;
  /** On overflow, the most recent this-many images survive (one more, as the gateway). */
  keepOnOverflow: number;
  /** Requests whose inline images exceed this many bytes are pruned. 0 or absent disables the byte cap. */
  maxBytes?: number;
  /** The inline image bytes a byte prune keeps at most. */
  keepBytesOnOverflow?: number;
}

export const DEFAULT_IMAGE_WINDOW: ImageWindowOptions = {
  maxImages: 20,
  keepOnOverflow: 12,
  maxBytes: 22 * 1024 * 1024,
  keepBytesOnOverflow: 16 * 1024 * 1024,
};

export interface ImageWindowResult {
  total: number;
  dropped: number;
}

const IMAGE_PART_TYPES = new Set(['image_url', 'input_image', 'image']);

function isImagePart(part: unknown): boolean {
  return (
    !!part &&
    typeof part === 'object' &&
    IMAGE_PART_TYPES.has(String((part as { type?: unknown }).type))
  );
}

function itemsOf(body: Record<string, unknown>): unknown[] {
  if (Array.isArray(body.messages)) return body.messages;
  if (Array.isArray(body.input)) return body.input;
  return [];
}

/** The image parts of one parts array, in order, and those of every part's own `content[]` (a `tool_result`). */
function collectSlots(parts: unknown[], slots: Array<{ content: unknown[]; index: number; bytes: number }>): void {
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (isImagePart(part)) slots.push({ content: parts, index: i, bytes: JSON.stringify(part).length });
    else if (part && typeof part === 'object' && Array.isArray((part as { content?: unknown }).content)) {
      collectSlots((part as { content: unknown[] }).content, slots);
    }
  }
}

/** Mutates the request body in place. Returns what it counted and dropped. */
export function applyInlineImageWindow(
  body: Record<string, unknown>,
  options: ImageWindowOptions = DEFAULT_IMAGE_WINDOW,
): ImageWindowResult {
  const slots: Array<{ content: unknown[]; index: number; bytes: number }> = [];
  for (const item of itemsOf(body)) {
    if (!item || typeof item !== 'object') continue;
    for (const key of ['content', 'output'] as const) {
      const parts = (item as Record<string, unknown>)[key];
      if (Array.isArray(parts)) collectSlots(parts, slots);
    }
  }
  const total = slots.length;
  const dropped = imageCut(slots.map((slot) => slot.bytes), options);
  for (let i = 0; i < dropped; i += 1) {
    const slot = slots[i];
    if (slot) slot.content[slot.index] = { type: 'text', text: NOTICE };
  }
  return { total, dropped };
}

// No count: a dropped image reads the same at every step, so the prefix before the cut stays cached.
const NOTICE = '[image omitted by sandbox: an older image was removed; the most recent are kept]';

/**
 * How many images, oldest first, the window drops, given each image's bytes: the gateway's
 * forward pass. Walk the images and keep a window of the newest; when an image puts it over
 * `maxImages` or `maxBytes`, its start moves to `keepOnOverflow + 1` images and
 * `keepBytesOnOverflow` bytes. The cut depends only on the images up to each point, so for a
 * history that only grows it holds still until the next overflow, and the provider's prompt
 * cache keeps the prefix. The newest image always stays.
 */
export function imageCut(sizes: readonly number[], options: ImageWindowOptions): number {
  const maxCount = Math.max(0, Math.trunc(options.maxImages));
  const keepCount = Math.min(maxCount, Math.max(0, Math.trunc(options.keepOnOverflow)));
  const countAfterPrune = keepCount < maxCount ? keepCount + 1 : maxCount;
  const maxBytes = Math.max(0, Math.trunc(options.maxBytes ?? 0));
  const keepBytes = Math.min(maxBytes, Math.max(0, Math.trunc(options.keepBytesOnOverflow ?? maxBytes)));
  let start = 0;
  let count = 0;
  let bytes = 0;
  for (let i = 0; i < sizes.length; i += 1) {
    count += 1;
    bytes += sizes[i]!;
    const overCount = maxCount > 0 && count > maxCount;
    const overBytes = maxBytes > 0 && bytes > maxBytes;
    if (!overCount && !overBytes) continue;
    while (start < i && ((overCount && count > countAfterPrune) || (maxBytes > 0 && bytes > (overBytes ? keepBytes : maxBytes)))) {
      count -= 1;
      bytes -= sizes[start]!;
      start += 1;
    }
  }
  return start;
}

/**
 * The same window on the request's raw JSON, without parsing it: one pass that jumps over
 * every string (base64 has no quote), recording where each image part of
 * `messages[*].content[*]` (else `input[*].content[*]`) starts and ends, then splices the
 * notice in. A Claude Code request re-sends every screenshot of the session; parsing and
 * re-serializing it cost about four copies of a 15 MB body per model call. Null when the text
 * is not a shape this reads (escaped keys, a duplicate `messages`, not an object): the caller
 * parses it instead.
 */
export function applyInlineImageWindowToText(
  text: string,
  options: ImageWindowOptions = DEFAULT_IMAGE_WINDOW,
): (ImageWindowResult & { text: string }) | null {
  const spans = imagePartSpans(text);
  if (!spans) return null;
  const total = spans.length;
  const dropped = imageCut(spans.map(([start, end]) => end - start), options);
  if (dropped === 0) return { text, total, dropped };
  const replacement = JSON.stringify({ type: 'text', text: NOTICE });
  const pieces: string[] = [];
  let at = 0;
  for (let i = 0; i < dropped; i += 1) {
    const [start, end] = spans[i]!;
    pieces.push(text.slice(at, start), replacement);
    at = end;
  }
  pieces.push(text.slice(at));
  return { text: pieces.join(''), total, dropped };
}

class Unreadable extends Error {}

/** Image part spans, `[start, end)`, in the order a parse would visit them. */
function imagePartSpans(text: string): Array<[number, number]> | null {
  let i = 0;
  const ws = () => {
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c !== 32 && c !== 10 && c !== 13 && c !== 9) return;
      i += 1;
    }
  };
  /** Past a string starting at `i`; its raw contents (only when `keep`), escapes refused for kept ones. */
  const string = (keep: boolean): string | undefined => {
    if (text[i] !== '"') throw new Unreadable();
    let j = i;
    for (;;) {
      j = text.indexOf('"', j + 1);
      if (j === -1) throw new Unreadable();
      let slashes = 0;
      for (let k = j - 1; text.charCodeAt(k) === 92; k -= 1) slashes += 1;
      if (slashes % 2 === 0) break;
    }
    const raw = keep ? text.slice(i + 1, j) : undefined;
    if (raw !== undefined && raw.includes('\\')) throw new Unreadable();
    i = j + 1;
    return raw;
  };
  const scalar = () => {
    while (i < text.length && !',}]'.includes(text[i]!) && text.charCodeAt(i) > 32) i += 1;
  };
  type Role = 'other' | 'items' | 'item' | 'content' | 'part';
  /** Past one value; for a `part`, whether it is an image part. */
  const value = (role: Role, onPart?: (start: number, end: number, image: boolean) => void): void => {
    ws();
    const c = text[i];
    if (c === '"') return void string(false);
    if (c === '[') {
      i += 1;
      ws();
      if (text[i] === ']') return void (i += 1);
      for (;;) {
        value(role === 'items' ? 'item' : role === 'content' ? 'part' : 'other', onPart);
        ws();
        if (text[i] === ',') { i += 1; continue; }
        if (text[i] === ']') return void (i += 1);
        throw new Unreadable();
      }
    }
    if (c === '{') {
      const start = i;
      let type: string | undefined;
      const seen = new Set<string>();
      i += 1;
      ws();
      if (text[i] === '}') {
        i += 1;
      } else {
        for (;;) {
          ws();
          const key = string(true)!;
          if (seen.has(key)) throw new Unreadable();
          seen.add(key);
          ws();
          if (text[i] !== ':') throw new Unreadable();
          i += 1;
          ws();
          if (role === 'part' && key === 'type' && text[i] === '"') type = string(true);
          // An item's `content` / `output`, and a part's own `content` (a `tool_result`), hold parts.
          else value((role === 'item' && (key === 'content' || key === 'output')) || (role === 'part' && key === 'content') ? 'content' : 'other', onPart);
          ws();
          if (text[i] === ',') { i += 1; continue; }
          if (text[i] === '}') { i += 1; break; }
          throw new Unreadable();
        }
      }
      if (role === 'part') onPart?.(start, i, type !== undefined && IMAGE_PART_TYPES.has(type));
      return;
    }
    scalar();
  };
  try {
    ws();
    if (text[i] !== '{') return null;
    i += 1;
    const lists: Record<'messages' | 'input', { array: boolean; spans: Array<[number, number]> }> = {
      messages: { array: false, spans: [] },
      input: { array: false, spans: [] },
    };
    const seen = new Set<string>();
    ws();
    if (text[i] === '}') return [];
    for (;;) {
      ws();
      const key = string(true)!;
      if (seen.has(key)) return null;
      seen.add(key);
      ws();
      if (text[i] !== ':') return null;
      i += 1;
      ws();
      if (key === 'messages' || key === 'input') {
        const list = lists[key];
        list.array = text[i] === '[';
        value(list.array ? 'items' : 'other', (start, end, image) => image && list.spans.push([start, end]));
      } else {
        value('other');
      }
      ws();
      if (text[i] === ',') { i += 1; continue; }
      if (text[i] === '}') { i += 1; break; }
      return null;
    }
    ws();
    if (i !== text.length) return null;
    return lists.messages.array ? lists.messages.spans : lists.input.array ? lists.input.spans : [];
  } catch (err) {
    if (err instanceof Unreadable) return null;
    throw err;
  }
}

export function imageWindowFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ImageWindowOptions | null {
  const raw = env.KORTIX_LLM_MAX_INLINE_IMAGES?.trim();
  if (raw === '0') return null;
  const maxImages = raw && /^\d+$/.test(raw) ? Number(raw) : DEFAULT_IMAGE_WINDOW.maxImages;
  const keepRaw = env.KORTIX_LLM_IMAGE_KEEP_ON_OVERFLOW?.trim();
  const keepOnOverflow =
    keepRaw && /^\d+$/.test(keepRaw) ? Number(keepRaw) : DEFAULT_IMAGE_WINDOW.keepOnOverflow;
  const int = (name: string, fallback: number) => {
    const value = env[name]?.trim();
    return value && /^\d+$/.test(value) ? Number(value) : fallback;
  };
  const maxBytes = int('KORTIX_LLM_MAX_INLINE_IMAGE_BYTES', DEFAULT_IMAGE_WINDOW.maxBytes!);
  const keepBytesOnOverflow = int('KORTIX_LLM_IMAGE_KEEP_BYTES_ON_OVERFLOW', DEFAULT_IMAGE_WINDOW.keepBytesOnOverflow!);
  return { maxImages, keepOnOverflow: Math.min(keepOnOverflow, maxImages), maxBytes, keepBytesOnOverflow: Math.min(keepBytesOnOverflow, maxBytes) };
}

/** Paths whose JSON body carries a model request with inline images. */
export function isChatRequestPath(pathname: string): boolean {
  return /\/(chat\/completions|messages|responses)$/.test(pathname);
}
