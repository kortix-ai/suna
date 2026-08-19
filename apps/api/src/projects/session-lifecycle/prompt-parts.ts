/**
 * The one sanitizer for prompt parts entering the durable inbox.
 *
 * Two producers accept caller-supplied parts — `POST .../prompts` (r8.ts) and
 * `pending_prompt` on session create / warm claim (lib/sessions.ts,
 * warm-sessions.ts) — and both must apply the same repairs and the same caps,
 * or the create path becomes the way around the prompt route's limits.
 *
 * File parts may carry `data:` URLs: that is how a brand-new session's first
 * prompt ships an attachment before its sandbox exists to upload into. The
 * byte cap below is what makes that safe — a durable row is a Postgres row,
 * not a blob store.
 */

import type { PromptPartWire } from './store';

export const PROMPT_MAX_PARTS = 64;
export const PROMPT_TEXT_PREVIEW_CHARS = 2000;
/**
 * Serialized-parts ceiling. Sized for "a screenshot or a few documents"
 * (base64 inflates 4/3, so ~12 MB of JSON carries ~9 MB of file bytes), far
 * under the API body limit, and small enough that the drain's re-POST to the
 * daemon stays an ordinary request.
 */
export const PROMPT_PARTS_MAX_BYTES = 12 * 1024 * 1024;

export type SanitizedPromptParts = { parts: PromptPartWire[] } | { error: string };

/** Repair-and-cap. Returns `{error}` instead of throwing so both HTTP callers
 *  can map it straight onto a 400. */
export function sanitizeInboxPromptParts(rawParts: unknown[]): SanitizedPromptParts {
  if (rawParts.length < 1 || rawParts.length > PROMPT_MAX_PARTS) {
    return { error: `parts must hold 1..${PROMPT_MAX_PARTS} entries` };
  }
  const parts = rawParts.map((part: any) => ({
    type: (part?.type === 'file' || part?.type === 'agent' ? part.type : 'text') as
      | 'file'
      | 'agent'
      | 'text',
    ...(typeof part?.text === 'string' ? { text: part.text } : {}),
    ...(typeof part?.mime === 'string' ? { mime: part.mime } : {}),
    ...(typeof part?.url === 'string' ? { url: part.url } : {}),
    ...(typeof part?.filename === 'string' ? { filename: part.filename } : {}),
    ...(typeof part?.name === 'string' ? { name: part.name } : {}),
    ...(part?.source === undefined ? {} : { source: part.source }),
  }));
  const text = flattenPromptText(parts);
  if (!text && !parts.some((part) => part.type !== 'text')) {
    return { error: 'parts must carry text' };
  }
  let bytes = 0;
  for (const part of parts) {
    bytes += JSON.stringify(part).length;
    if (bytes > PROMPT_PARTS_MAX_BYTES) {
      return {
        error: `parts are too large (over ${Math.floor(PROMPT_PARTS_MAX_BYTES / (1024 * 1024))} MB) — attach big files once the session is running`,
      };
    }
  }
  return { parts: parts as PromptPartWire[] };
}

/** Flatten a prompt body to the plain text every pre-inbox reader still wants
 *  (the title generator, the dead-letter alert, `GET /prompts`'s preview). */
export function flattenPromptText(parts: Array<{ type: string; text?: string }>): string {
  return parts
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n')
    .trim();
}
