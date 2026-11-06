/**
 * Image window: bound the inline images one request carries, by count and by bytes.
 *
 * A coding agent that takes a screenshot per step re-sends EVERY screenshot
 * on every turn — the request that OOM-killed the SampleCo gateway on
 * 2026-08-22 carried 40 base64 screenshots (28 MB, 334k tokens) in 224
 * messages. Providers cap both dimensions, and a model reasons from the last
 * few screens, not the fortieth-last:
 *   - count: Bedrock accepts 600 images and documents per request (probed 2026-11-06 on
 *     Opus 5.5: 601 → "too many images and documents: 601 + 0 > 600"). 20 is a choice:
 *     every kept image is resent, billed and held in memory on every step.
 *   - bytes: Bedrock rejects a request body over ~32 MB with "Input is too long
 *     for requested model." — the context-overflow text, at ~22k tokens
 *     (probed 2026-11-06: 31,262,126 bytes → 200, 32,029,742 bytes → 400).
 *     Twelve 1600x1200 PNG reads (3.6 MB base64 each) are 43 MB: a count
 *     window alone sent them, every retry failed the same way, and pi's
 *     compaction could not help, because it keeps the newest images.
 *
 * Policy, applied once per request after parse and before dispatch: walk the
 * inline images oldest first and keep a window of the newest. When adding an
 * image puts the window over `maxImages` or `maxBytes`, the window's start
 * moves forward to `keepOnOverflow + 1` images and `keepBytesOnOverflow`
 * bytes. Every image before the start becomes a short text part.
 *
 * The walk depends only on the images up to each point. A client re-sends its
 * whole history every request, so the start holds still until the next
 * overflow, and the prefix before it stays byte-identical: the provider's
 * prompt cache keeps it. For count alone the start moves in steps of
 * `maxImages - keepOnOverflow` images, as it always did.
 *
 * The replacement is a text part rather than deletion so a user message never
 * becomes empty and the user/assistant alternation the providers depend on is
 * preserved.
 */

export interface ImageWindowOptions {
  /** Requests with more inline images than this are pruned. 0 disables the count cap. */
  maxImages: number;
  /** How many most-recent images survive a count prune (one more, see above). Must be <= maxImages. */
  keepOnOverflow: number;
  /** Requests whose inline images exceed this many base64 bytes are pruned. 0 or absent disables the byte cap. */
  maxBytes?: number;
  /** The inline image bytes a byte prune keeps at most. Must be <= maxBytes. */
  keepBytesOnOverflow?: number;
}

/**
 * 22 MiB of base64 images: Bedrock and Anthropic accept ~32 MB per request, and a
 * full 1M-token text history adds ~4 MB. A byte prune keeps 16 MiB: four fresh
 * 3.6 MB screenshots survive together, and the next ~6 MiB of new images leave
 * the cached prefix unchanged.
 */
export const DEFAULT_IMAGE_WINDOW: ImageWindowOptions = {
  maxImages: 20,
  keepOnOverflow: 12,
  maxBytes: 22 * 1024 * 1024,
  keepBytesOnOverflow: 16 * 1024 * 1024,
};

export interface ImageWindowResult {
  total: number;
  dropped: number;
  /** Base64 bytes of every inline image the request carried. */
  bytes: number;
  /** Base64 bytes of the inline images that survived. */
  keptBytes: number;
}

const IMAGE_PART_TYPES = new Set(['image_url', 'input_image', 'image']);

/** No count: a dropped image reads the same at every step, so the prefix before the cut stays cached. */
export const IMAGE_WINDOW_NOTICE = '[image omitted by gateway: an older image was removed; the most recent are kept]';

function isImagePart(part: unknown): boolean {
  return (
    !!part &&
    typeof part === 'object' &&
    IMAGE_PART_TYPES.has(String((part as { type?: unknown }).type))
  );
}

/**
 * The base64 bytes one image part puts on the wire: a `data:` URL (chat
 * `image_url`, responses `input_image`) or an inline `data`/`source.data`
 * payload. A remote URL costs the provider a fetch, not request bytes: 0.
 */
function inlineBytes(part: unknown): number {
  const p = part as { image_url?: unknown; data?: unknown; source?: { data?: unknown } };
  const url = typeof p.image_url === 'string' ? p.image_url : (p.image_url as { url?: unknown } | undefined)?.url;
  if (typeof url === 'string') return url.startsWith('data:') ? url.length : 0;
  const data = p.source?.data ?? p.data;
  return typeof data === 'string' ? data.length : 0;
}

/** Mutates `body.messages` in place. Returns what it counted and dropped. */
export function applyImageWindow(
  body: Record<string, unknown>,
  options: ImageWindowOptions = DEFAULT_IMAGE_WINDOW,
): ImageWindowResult {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const slots: Array<{ content: unknown[]; index: number; bytes: number }> = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (let i = 0; i < content.length; i += 1) {
      if (isImagePart(content[i])) slots.push({ content, index: i, bytes: inlineBytes(content[i]) });
    }
  }
  const total = slots.length;
  const bytes = slots.reduce((sum, slot) => sum + slot.bytes, 0);
  const maxCount = Math.max(0, Math.trunc(options.maxImages));
  const keepCount = Math.min(maxCount, Math.max(0, Math.trunc(options.keepOnOverflow)));
  const maxBytes = Math.max(0, Math.trunc(options.maxBytes ?? 0));
  const keepBytes = Math.min(maxBytes, Math.max(0, Math.trunc(options.keepBytesOnOverflow ?? maxBytes)));
  // A count prune leaves `keepCount + 1` images: the step stays `maxCount - keepCount`.
  const countAfterPrune = keepCount < maxCount ? keepCount + 1 : maxCount;

  // The window [start, i]: its image count and its bytes.
  let start = 0;
  let count = 0;
  let windowBytes = 0;
  for (let i = 0; i < total; i += 1) {
    count += 1;
    windowBytes += slots[i]!.bytes;
    const overCount = maxCount > 0 && count > maxCount;
    const overBytes = maxBytes > 0 && windowBytes > maxBytes;
    if (!overCount && !overBytes) continue;
    // The newest image always stays: one image over the byte cap on its own is the
    // provider's to refuse (`request_too_large`), not the gateway's to hide. The
    // next image moves it out of the window.
    while (
      start < i &&
      ((overCount && count > countAfterPrune) || (maxBytes > 0 && windowBytes > (overBytes ? keepBytes : maxBytes)))
    ) {
      count -= 1;
      windowBytes -= slots[start]!.bytes;
      start += 1;
    }
  }

  for (let i = 0; i < start; i += 1) {
    const slot = slots[i]!;
    slot.content[slot.index] = { type: 'text', text: IMAGE_WINDOW_NOTICE };
  }
  return { total, dropped: start, bytes, keptBytes: windowBytes };
}
