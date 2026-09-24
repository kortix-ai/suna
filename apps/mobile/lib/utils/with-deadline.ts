/**
 * Deadlines for promises and fetches on the boot path.
 *
 * React Native's Android HTTP client has no connect/read timeout, so a stalled
 * request never settles. These helpers put an upper bound on the calls that
 * gate the first screen.
 */

/**
 * Resolves with `promise`'s value if it settles within `ms`, otherwise with
 * `fallback`. A rejection before the deadline is passed through unchanged.
 * The underlying promise is not cancelled.
 */
export function withDeadline<T, F>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  return new Promise<T | F>((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export type FetchFunction = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface DeadlineFetchOptions {
  timeoutMs: number;
  /** Only requests whose URL matches get the timeout. */
  shouldTimeout: (url: string) => boolean;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Wraps `fetchImpl` so matching requests abort after `timeoutMs`. A signal the
 * caller passes still aborts the request. Non-matching requests are forwarded
 * untouched (uploads and downloads can legitimately run longer).
 */
export function createDeadlineFetch(
  fetchImpl: FetchFunction,
  { timeoutMs, shouldTimeout }: DeadlineFetchOptions
): FetchFunction {
  return (input, init) => {
    if (!shouldTimeout(requestUrl(input))) return fetchImpl(input, init);

    const controller = new AbortController();
    const callerSignal = init?.signal;
    const forwardAbort = () => controller.abort();
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort();
      else callerSignal.addEventListener('abort', forwardAbort);
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    return fetchImpl(input, { ...init, signal: controller.signal }).finally(() => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', forwardAbort);
    });
  };
}
