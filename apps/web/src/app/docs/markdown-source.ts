/**
 * The page's markdown, fetched at most once and remembered.
 *
 * "Copy Markdown" used to run its `fetch` INSIDE the click: press the button
 * and the first thing that happens is a network round-trip, so the copy is
 * never faster than the request — and on a cold dev server, where
 * `/markdown/[...path]` is compiled and rendered per request, that is seconds.
 * The text does not depend on the click, so it does not have to wait for it.
 *
 * Splitting the cache out of the component is what makes it testable: this
 * app has no DOM harness, so a `useRef` inside a client component is reachable
 * only by rendering one. Everything decided here — fetch once, share the
 * in-flight promise, forget a failure so the next press retries — is decided
 * in a plain function instead.
 */
export interface MarkdownSource {
  /** The text if it is already here, else `null`. Never triggers a fetch. */
  peek(): string | null;
  /** The text, fetching it if needed. Concurrent callers share one request. */
  load(): Promise<string>;
}

type FetchLike = (input: string) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

export function createMarkdownSource(path: string, fetchImpl: FetchLike): MarkdownSource {
  let text: string | null = null;
  let pending: Promise<string> | null = null;

  return {
    peek: () => text,
    load() {
      if (text !== null) return Promise.resolve(text);
      // `??=`, so a hover, a focus and a press that overlap issue ONE request
      // and all three resolve from it.
      pending ??= fetchImpl(path)
        .then(async (response) => {
          if (!response.ok) throw new Error(`Failed to fetch ${path}: ${response.status}`);
          text = await response.text();
          return text;
        })
        .catch((error: unknown) => {
          // Drop the failed promise rather than caching a rejection: a reader
          // whose first press hit a dead connection must be able to press
          // again, and `??=` would otherwise hand them the same failure
          // forever.
          pending = null;
          throw error;
        });
      return pending;
    },
  };
}
