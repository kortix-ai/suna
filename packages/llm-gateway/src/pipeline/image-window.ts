/**
 * Image window: bound the number of inline images one request carries.
 *
 * A coding agent that takes a screenshot per step re-sends EVERY screenshot
 * on every turn — the request that OOM-killed the SampleCo gateway on
 * 2026-08-22 carried 40 base64 screenshots (28 MB, 334k tokens) in 224
 * messages. Two facts make an unbounded image history worthless as well as
 * expensive: providers cap it (Bedrock Converse rejects >20 images per
 * request; Anthropic caps at 100), and a model reasons from the last few
 * screens, not the fortieth-last.
 *
 * Policy, applied once per request after parse and before dispatch:
 *   - Count `image_url` parts across every user message.
 *   - If the count is at or under `maxImages`, do nothing.
 *   - Otherwise keep the most recent `keepOnOverflow` images and replace each
 *     older image part with a short text part that says so. Dropping down to
 *     `keepOnOverflow` (< `maxImages`) rather than to `maxImages` gives
 *     hysteresis: the prefix of the conversation then stays byte-identical
 *     for the next `maxImages - keepOnOverflow` turns, which is what keeps
 *     provider prompt caches warm instead of invalidating them every turn.
 *
 * The replacement is a text part rather than deletion so a user message never
 * becomes empty and the user/assistant alternation the providers depend on is
 * preserved.
 */

export interface ImageWindowOptions {
  /** Requests with more inline images than this are pruned. 0 disables. */
  maxImages: number;
  /** How many most-recent images survive a prune. Must be <= maxImages. */
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

/** Mutates `body.messages` in place. Returns what it counted and dropped. */
export function applyImageWindow(
  body: Record<string, unknown>,
  options: ImageWindowOptions = DEFAULT_IMAGE_WINDOW,
): ImageWindowResult {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const slots: Array<{ content: unknown[]; index: number }> = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const content = (message as { content?: unknown }).content;
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
  const notice = '[image omitted by gateway: an older image was removed; the most recent are kept]';
  for (let i = 0; i < dropped; i += 1) {
    const slot = slots[i];
    slot.content[slot.index] = { type: 'text', text: notice };
  }
  return { total, dropped };
}
