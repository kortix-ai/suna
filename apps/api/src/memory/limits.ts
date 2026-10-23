/**
 * The caps of a memory page and the error every memory rule throws. Pure: no
 * database, so the routes, the import job and the unit tests share it.
 */
import { MEMORY_LIMITS } from '@kortix/api-contract';
import { findSecret } from './secret-check';

export { MEMORY_LIMITS };

/** A refusal with its HTTP status and machine code; the route answers `{error, code, ...extra}`. */
export class MemoryError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 413 | 422,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }

  get body(): Record<string, unknown> {
    return { error: this.message, code: this.code, ...this.extra };
  }
}

export const notFound = () => new MemoryError(404, 'memory_not_found', 'Memory not found.');

/** The uniqueness key of a title: NFKC, lowercase, trimmed, inner whitespace collapsed. */
export function titleKey(title: string): string {
  return title.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
}

const invalid = (message: string) => new MemoryError(400, 'invalid_input', message);

/** The fields of a page as they will be stored. Throws the first cap it breaks. */
export function checkPage(page: { title: string; summary: string; body: string; related: readonly string[] }): void {
  const title = page.title.trim();
  if (!title || title.length > MEMORY_LIMITS.title_chars) {
    throw invalid(`A title has 1 to ${MEMORY_LIMITS.title_chars} characters.`);
  }
  if (page.summary.length > MEMORY_LIMITS.summary_chars || /[\r\n]/.test(page.summary)) {
    throw invalid(`A summary is one line of at most ${MEMORY_LIMITS.summary_chars} characters.`);
  }
  if (page.related.length > MEMORY_LIMITS.related) {
    throw invalid(`A page links at most ${MEMORY_LIMITS.related} related pages.`);
  }
  if (Buffer.byteLength(page.body, 'utf8') > MEMORY_LIMITS.body_bytes) {
    throw new MemoryError(413, 'page_too_large', `A page holds at most ${MEMORY_LIMITS.body_bytes} bytes. Split it into two pages.`);
  }
  checkSecrets(page.title, page.summary, page.body);
}

/** 422 when any text holds a secret. The text itself is never logged or echoed. */
export function checkSecrets(...texts: string[]): void {
  if (texts.some((text) => findSecret(text))) {
    throw new MemoryError(422, 'secret_detected', 'That looks like a secret. Keep secrets in Secrets, not in memory.');
  }
}
