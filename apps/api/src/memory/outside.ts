/**
 * Outside content (pure). A `remember` call is from outside the thread when it
 * sets `outside`, or when its text holds an http(s) URL the page does not
 * already cite or contain. Such a fact waits for a person: a new page is saved
 * `unconfirmed`; an addition to a confirmed page goes to a separate
 * unconfirmed page "<title> (to confirm)" that names the page in `related`.
 */
import { MEMORY_LIMITS } from '@kortix/api-contract';

export const PENDING_SUFFIX = ' (to confirm)';

const URL_RE = /https?:\/\/[^\s<>"'`()[\]{}⟦⟧]+/gi;

const normal = (url: string): string | null => {
  try {
    return new URL(url.replace(/[.,;:!?]+$/, '')).href;
  } catch {
    return null;
  }
};

/** The http(s) URLs in `text`, normalized, in order, without repeats. */
export function urlsIn(text: string): string[] {
  return [...new Set((text.match(URL_RE) ?? []).map(normal).filter((url): url is string => url !== null))];
}

/** URLs of `text` that `known` (the page's source URLs and current body) does not hold. */
export function newUrls(text: string, known: readonly string[]): string[] {
  const seen = new Set(known.flatMap((entry) => urlsIn(entry)));
  return urlsIn(text).filter((url) => !seen.has(url));
}

/** The title of the page that holds unconfirmed additions to `title`, within the title cap. */
export const pendingTitle = (title: string) =>
  `${title.trim().slice(0, MEMORY_LIMITS.title_chars - PENDING_SUFFIX.length).trimEnd()}${PENDING_SUFFIX}`;

/** The source label of a URL: its host. */
export const hostOf = (url: string) => {
  try {
    return new URL(url).host || 'A web page';
  } catch {
    return 'A web page';
  }
};
