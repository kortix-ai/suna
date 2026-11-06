// The polling half of `kortix login --device` (RFC 8628 §3.4-3.5), as one
// explicit loop over injected I/O so a fake clock can drive every path.
//
// Outcomes per poll:
//   token                         → done
//   authorization_pending         → wait `interval`
//   slow_down, HTTP 429           → interval += 5 s
//   network error, HTTP 5xx / 408 → transient: retry with doubling wait,
//                                   give up after MAX_TRANSIENT in a row
//   access_denied, expired_token, invalid_grant, other 4xx → stop

import { DeviceRequestError } from '../api/sdk.ts';

export type DevicePollAnswer = { token?: string; error?: string };
export type DevicePollDeps = {
  poll(): Promise<DevicePollAnswer>;
  sleep(ms: number): Promise<void>;
  now(): number;
};

const MIN_INTERVAL_S = 5;
const DEFAULT_EXPIRES_S = 600;
const MAX_TRANSIENT = 5;
const MAX_WAIT_MS = 60_000;

const EXPIRED = 'Device login expired. Run kortix login --device again.';
const REFUSALS: Record<string, string> = {
  access_denied: 'Device login was denied in the browser.',
  expired_token: EXPIRED,
  invalid_grant: 'This device code was already used. Run kortix login --device again.',
};

type Outcome = { kind: 'token'; token: string } | { kind: 'pending' } | { kind: 'slow_down' } | { kind: 'transient'; error: Error } | { kind: 'fatal'; error: Error };

function classify(answer: DevicePollAnswer | Error): Outcome {
  if (answer instanceof DeviceRequestError) {
    if (answer.status === 429) return { kind: 'slow_down' };
    if (answer.status >= 500 || answer.status === 408) return { kind: 'transient', error: answer };
    return { kind: 'fatal', error: answer };
  }
  if (answer instanceof Error) {
    // The 600 s overall signal fired: the login is over, not flaky.
    if (answer.name === 'TimeoutError' || answer.name === 'AbortError') return { kind: 'fatal', error: new Error(EXPIRED) };
    return { kind: 'transient', error: answer };
  }
  if (answer.token) return { kind: 'token', token: answer.token };
  if (answer.error === 'authorization_pending') return { kind: 'pending' };
  if (answer.error === 'slow_down') return { kind: 'slow_down' };
  return { kind: 'fatal', error: new Error(REFUSALS[answer.error ?? ''] ?? (answer.error || 'Invalid device login response')) };
}

const positive = (n: unknown, fallback: number) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : fallback);

/** Polls until the grant yields a token. Throws with a user-facing message on refusal or expiry. */
export async function pollDeviceGrant(
  grant: { interval?: number; expires_in?: number },
  deps: DevicePollDeps,
  deadline = Number.POSITIVE_INFINITY,
): Promise<string> {
  let interval = Math.max(MIN_INTERVAL_S, positive(grant.interval, MIN_INTERVAL_S)) * 1000;
  const expires = Math.min(deadline, deps.now() + Math.min(DEFAULT_EXPIRES_S, positive(grant.expires_in, DEFAULT_EXPIRES_S)) * 1000);
  let transient = 0;
  for (;;) {
    const remaining = expires - deps.now();
    if (remaining <= 0) throw new Error(EXPIRED);
    const wait = Math.min(MAX_WAIT_MS, interval * 2 ** transient);
    await deps.sleep(Math.min(wait, remaining));
    const outcome = classify(await deps.poll().catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))));
    switch (outcome.kind) {
      case 'token': return outcome.token;
      case 'pending': transient = 0; break;
      case 'slow_down': transient = 0; interval += 5000; break;
      case 'transient':
        if (++transient >= MAX_TRANSIENT) throw outcome.error;
        break;
      case 'fatal': throw outcome.error;
    }
  }
}
