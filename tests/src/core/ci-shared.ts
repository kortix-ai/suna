/**
 * Provider-neutral plumbing shared by the Daytona and Platinum CI runners
 * (KRTX-1432). The provider differences — the transient status sets,
 * Platinum's `500 operation was aborted` abort clause, the log prefixes and
 * the resource-name flavours — are call-site data. This module must not
 * import from daytona-ci or platinum-ci; the providers import from here.
 */

const CI_API_ATTEMPTS = 6;

/**
 * Whether a CI provider API failure is worth retrying. `http` carries the
 * provider HTTP error's status and message when `error` is one, plus the
 * provider's transient status set and its optional abort clause; every other
 * error classifies through the shared transient-message pattern.
 */
export function isRetryableCiError(
  error: unknown,
  http: {
    status?: number;
    message?: string;
    transientStatuses: ReadonlySet<number>;
    abort?: { status: number; pattern: RegExp };
  },
): boolean {
  if (http.status !== undefined) {
    return (
      http.transientStatuses.has(http.status) ||
      (http.abort !== undefined &&
        http.abort.status === http.status &&
        http.abort.pattern.test(http.message ?? ''))
    );
  }
  if (error instanceof SyntaxError) return true;
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /abort|connection reset|econnreset|fetch failed|network|socket|timed?\s*out/i.test(
    message,
  );
}

/** Retry a provider API operation with bounded exponential backoff. */
export async function retryCiOperation<T>(input: {
  label: string;
  operation: () => Promise<T>;
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
  isRetryableError: (error: unknown) => boolean;
  logPrefix: string;
}): Promise<T> {
  const attempts = input.attempts ?? CI_API_ATTEMPTS;
  const wait =
    input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await input.operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !input.isRetryableError(error)) throw error;
      const delayMs = Math.min(15_000, 1_000 * 2 ** (attempt - 1));
      console.warn(
        `[${input.logPrefix}] retry label=${input.label} attempt=${attempt + 1}/${attempts} delay_ms=${delayMs} error=${String(error)}`,
      );
      await wait(delayMs);
    }
  }
  throw lastError;
}

/**
 * The content-addressed resource name ceremony shared by the Platinum
 * template names and the Daytona snapshot names: reject anything that is not
 * a lockfile hash, then name the resource after its flavour and a hash prefix.
 */
export function ciResourceName(input: {
  /** The flavour between `kortix-ci` and the hash, e.g. `daytona-v4` or `v15`. */
  flavour: string;
  lockHash: string;
  /** A trailing discriminator, e.g. `-base`. */
  suffix?: string;
}): string {
  if (!/^[a-f0-9]{64}$/i.test(input.lockHash)) {
    throw new Error(`invalid lockfile hash: ${input.lockHash}`);
  }
  return `kortix-ci-${input.flavour}-${input.lockHash.slice(0, 16)}${input.suffix ?? ''}`;
}

/**
 * Whether a sandbox belongs to exactly one CI run: the canonical worker name
 * plus the provider's owner/run-id (and, when labelled, run-attempt) fields.
 */
export function isExactCiSandbox(input: {
  name: string | undefined;
  owner: unknown;
  runId: unknown;
  runAttempt?: unknown;
  expectedName: string;
  expectedOwner: string;
  expectedRunId: string;
  /** Checked only when the provider labels attempts. */
  expectedRunAttempt?: string;
}): boolean {
  return (
    input.name === input.expectedName &&
    input.owner === input.expectedOwner &&
    input.runId === input.expectedRunId &&
    (input.expectedRunAttempt === undefined || input.runAttempt === input.expectedRunAttempt)
  );
}

/**
 * The state-poll loop shared by the Platinum template/sandbox waits and the
 * Daytona snapshot/sandbox waits: judge the last known record, sleep,
 * refetch, and time out. With `initial` the record in hand is judged before
 * the first refetch; without it the first read happens before the first
 * judgment. A read failure propagates unless `onTransientError` tolerates it.
 */
export async function pollCiState<T extends { state?: string }>(input: {
  /** The record already in hand; judged before the first refetch. */
  initial?: T;
  /** Refetch the record; it receives the last known record, when one exists. */
  read: (previous: T | undefined) => Promise<T>;
  /** True when the record has reached the state the caller is waiting for. */
  ready: (state: string) => boolean;
  /** The error a terminal state must throw, or null when the state is not terminal. */
  terminal: (current: T, state: string) => Error | null;
  /** Announce a state change; called only when the state differs from the last one. */
  log: (current: T, state: string) => void;
  /** The timeout error; the polled resource's identity never changes across refetches. */
  timeoutError: () => Error;
  /** Milliseconds from `startAt` until the timeout error. */
  timeoutMs: number;
  /** Clock anchor for the deadline. */
  startAt: number;
  /** Milliseconds between refetches. */
  pollMs: number;
  now?: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Tolerate a transient observation failure; throw inside to propagate instead. */
  onTransientError?: (error: unknown) => void;
  /** Called after a successful read when earlier observations had failed. */
  onObservationRecovered?: () => void;
}): Promise<T> {
  const now = input.now ?? Date.now;
  const deadline = input.startAt + input.timeoutMs;
  let current: T | undefined = input.initial;
  let lastState = '';
  const observe = async (): Promise<T | undefined> => {
    try {
      const observed = await input.read(current);
      input.onObservationRecovered?.();
      return observed;
    } catch (error) {
      if (!input.onTransientError) throw error;
      input.onTransientError(error);
      return current;
    }
  };
  while (now() < deadline) {
    if (current === undefined) {
      current = await observe();
      if (current === undefined) {
        await input.sleep(input.pollMs);
        continue;
      }
    }
    const state = String(current.state ?? '').toLowerCase();
    if (state !== lastState) {
      input.log(current, state);
      lastState = state;
    }
    if (input.ready(state)) return current;
    const terminal = input.terminal(current, state);
    if (terminal) throw terminal;
    await input.sleep(input.pollMs);
    current = await observe();
  }
  throw input.timeoutError();
}
