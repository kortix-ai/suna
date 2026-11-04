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
 * `input_image`), Anthropic (`messages[].content[]` with `image`) and the
 * OpenAI Responses API (`input[].content[]` with `input_image`).
 */
export interface ImageWindowOptions {
  /** Requests carrying at most this many inline images pass untouched. */
  maxImages: number;
  /** On overflow, the most recent this-many images survive. */
  keepOnOverflow: number;
}

export const DEFAULT_IMAGE_WINDOW: ImageWindowOptions = { maxImages: 20, keepOnOverflow: 12 };

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

/** Mutates the request body in place. Returns what it counted and dropped. */
export function applyInlineImageWindow(
  body: Record<string, unknown>,
  options: ImageWindowOptions = DEFAULT_IMAGE_WINDOW,
): ImageWindowResult {
  const slots: Array<{ content: unknown[]; index: number }> = [];
  for (const item of itemsOf(body)) {
    if (!item || typeof item !== 'object') continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (let i = 0; i < content.length; i += 1) {
      if (isImagePart(content[i])) slots.push({ content, index: i });
    }
  }
  const total = slots.length;
  const max = Math.max(0, Math.trunc(options.maxImages));
  if (max === 0 || total <= max) return { total, dropped: 0 };
  const keep = Math.min(max, Math.max(0, Math.trunc(options.keepOnOverflow)));
  // Stateless hysteresis: a client re-sends its whole history every request, so the cut
  // moves in steps of `max - keep` images and every request until the next step drops the
  // same images with the same notice; the provider's prompt cache keeps its prefix. (Dropping
  // `total - keep` moved the cut, and the notice's count, on every new image.) Between
  // `keep + 1` and `max` images survive.
  const step = max - keep;
  const dropped = step > 0 ? Math.ceil((total - max) / step) * step : total - keep;
  // No count: a dropped image reads the same at every step, so the prefix before the cut stays cached.
  const notice = '[image omitted by sandbox: an older image was removed; the most recent are kept]';
  for (let i = 0; i < dropped; i += 1) {
    const slot = slots[i];
    if (slot) slot.content[slot.index] = { type: 'text', text: notice };
  }
  return { total, dropped };
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
  return { maxImages, keepOnOverflow: Math.min(keepOnOverflow, maxImages) };
}

/** Paths whose JSON body carries a model request with inline images. */
export function isChatRequestPath(pathname: string): boolean {
  return /\/(chat\/completions|messages|responses)$/.test(pathname);
}
