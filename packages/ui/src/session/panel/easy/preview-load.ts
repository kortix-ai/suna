import type { PreviewPortProbe } from '@kortix/sdk';

/**
 * Whether `AppPreview`'s port watch should be armed — the fix for the false
 * positive where a healthy app got declared dead. The iframe has no `src` (and
 * therefore no way to ever fire `onLoad`/`onError`) until the auth-token fetch
 * resolves; arming the clock before then just counts down the fetch itself, so
 * a slow token (not a slow app) trips the error. Requiring `hasPreview` —
 * `previewUrl` gone non-null — means the watch starts only once the iframe
 * actually has something to load.
 */
export function shouldArmLoadTimeout(input: {
  isLoading: boolean;
  noApp: boolean;
  hasPreview: boolean;
}): boolean {
  return input.isLoading && !input.noApp && input.hasPreview;
}

/**
 * `AppPreview`'s load/error state after an iframe `onLoad` fires — the fix
 * for a late success leaving the "Couldn't load" card over a working app.
 *
 * The `shouldArmLoadTimeout` deadline reaches its "couldn't load" verdict on
 * SILENCE: no `onLoad`/`onError` within 5s. That verdict is a guess, not
 * proof, and the error card it sets is `absolute inset-0 z-10` — sitting on
 * top of the iframe. An `onLoad` that fires after the guess was made is
 * positive evidence the guess was wrong, so it must retract `hasError` too,
 * not just clear the spinner — otherwise the card keeps covering a loaded,
 * working app until a manual Retry. `onError` is untouched by this: a real
 * error event is its own positive evidence of failure, so it still sets
 * `hasError` on its own.
 */
export function previewLoadSuccessState(): { isLoading: boolean; hasError: boolean } {
  return { isLoading: false, hasError: false };
}

/**
 * What the runtime poll currently knows about the session's sandbox — three
 * values, because "not alive" and "dead" are different states and only one of
 * them is evidence.
 *
 * `useRuntimeConnectionStore` starts every session at
 * `status: 'connecting', healthy: null`, so a boolean "alive" is FALSE for the
 * entire boot. `AppPreview` already computes that boolean and uses it to pick
 * the error wording; using the same boolean to decide whether an error
 * happened would fail every preview at mount.
 *
 * `unreachable` is the only value that means dead, and it is not a single
 * missed probe: `useRuntimeReconnect` only writes it after its own failure
 * threshold (`FAIL_THRESHOLD_RECONNECT` / `FAIL_THRESHOLD_FIRST`), or on an
 * HTTP status that says outright that nothing is home. By the time the store
 * says `unreachable`, the sandbox has already been probed and re-probed.
 *
 * `initialCheckDone` gates `dead` for a reason that is easy to miss: the store
 * is a process-wide singleton with no per-session key, so opening a preview
 * carries whatever verdict the PREVIOUSLY viewed session left behind until the
 * poll's first check lands. Without this gate a stale `unreachable` flashes the
 * error card at mount on a perfectly healthy sandbox. `alive` needs no such
 * gate: it can only be reached by a check that has already resolved.
 */
export type SandboxHealth = 'alive' | 'dead' | 'unknown';

export function runtimeSandboxHealth(runtime: {
  status: 'connecting' | 'connected' | 'unreachable';
  healthy: boolean | null;
  /** Whether the runtime poll has completed a check for THIS mount. */
  initialCheckDone: boolean;
}): SandboxHealth {
  if (runtime.status === 'unreachable') return runtime.initialCheckDone ? 'dead' : 'unknown';
  if (runtime.status === 'connected' && runtime.healthy === true) return 'alive';
  return 'unknown';
}

/** How often `AppPreview` re-probes the port while it waits, ms.
 *
 *  Sized against the port-BIND race, which is the only thing a faster or slower
 *  cadence changes: the agent starts a dev server and the preview opens before
 *  the process has bound its socket. Two seconds means the continuity window
 *  below rests on five samples rather than one, and the loop that spends them
 *  is short-lived — see {@link shouldKeepProbingPort}. */
export const PREVIEW_PROBE_INTERVAL_MS = 2_000;

/** How long the port must be CONTINUOUSLY unreachable before that counts as a
 *  failure, ms.
 *
 *  A single 502 is the proxy saying "nothing answered right now", which is the
 *  normal state of a port for the first moments after the agent starts a
 *  server. Ten seconds is five consecutive misses at
 *  {@link PREVIEW_PROBE_INTERVAL_MS} — the same count `useRuntimeReconnect`
 *  requires (`FAIL_THRESHOLD_FIRST = 5`) before it will call a never-yet-seen
 *  endpoint unreachable, so the product has one answer to "how many misses
 *  mean it is really not there". Any answering probe resets it. */
export const PREVIEW_UNREACHABLE_WINDOW_MS = 10_000;

/** The hard ceiling on waiting, ms — reached only when NO probe ever produced
 *  a verdict (blocked by CORS, an expired preview cookie, an offline browser)
 *  and the frame never fired `onLoad`.
 *
 *  It has to clear the slowest legitimate cold start or it re-creates the exact
 *  bug this replaced, just at a bigger number: `CLAUDE.md` records 30-60s for a
 *  first hit on a cold Next.js route. 90s is that documented worst case plus a
 *  50% margin. It is a last resort, not the normal path — with a working probe
 *  a dead port resolves in ~{@link PREVIEW_UNREACHABLE_WINDOW_MS}. */
export const PREVIEW_MAX_WAIT_MS = 90_000;

/** How long the frame may load before the pane says it is slow, ms.
 *
 *  A frame whose request stalls (the app has not answered yet, or a
 *  single-threaded server is busy with another client) fires no `onLoad`, and
 *  the port probe cannot see that. The pane then showed a bare "Loading
 *  preview…" until {@link PREVIEW_MAX_WAIT_MS} (KRTX-3015). Past this point it
 *  keeps waiting but says so, and offers Reload. Fifteen seconds is past the
 *  probe's {@link PREVIEW_UNREACHABLE_WINDOW_MS}, so a dead port has already
 *  failed by then, and well inside a cold compile, which only earns a line. */
export const PREVIEW_SLOW_MS = 15_000;

/** The line under the loading spinner once the preview is slow. */
export function previewSlowReason(input: { port: number }): string {
  const app = input.port > 0 ? `The app on port ${input.port}` : 'The app';
  return `${app} is taking a while to answer. Reload to ask again.`;
}

/** One probe's verdict about the port. Aliased from the SDK's own type rather
 *  than restated, so the two can never drift apart. */
export type PreviewProbe = PreviewPortProbe;

/**
 * Whether `AppPreview` should keep waiting or show "Couldn't load".
 *
 * The bug this replaces: the verdict came from a stopwatch. Five seconds of
 * iframe silence WAS the failure, and iframe silence is not evidence of
 * anything — a cold dev-server compile is routinely 30-60s (`CLAUDE.md`), so
 * healthy apps were being declared dead mid-build. `sandboxAlive` was computed
 * right next to it and used only to pick the error's wording, never to decide
 * whether there was an error at all.
 *
 * Now the verdict needs evidence, in this order:
 *
 * 1. **The sandbox is known dead.** The runtime poll has already probed,
 *    re-probed and given up. Nothing behind this port can be reachable, and
 *    `AppPreview`'s copy has the stopped-workspace wording for exactly this.
 * 2. **The port has been continuously unreachable for the whole window.** The
 *    proxy answers `502/503/504` itself when it cannot open a connection, so
 *    this is the port saying nothing is listening — repeatedly, over
 *    {@link PREVIEW_UNREACHABLE_WINDOW_MS}, with any single answer resetting it.
 * 3. **The bound.** Everything else keeps waiting until
 *    {@link PREVIEW_MAX_WAIT_MS}, then fails anyway. "Wait forever when unsure"
 *    would trade a false error for a permanent spinner, and a permanent spinner
 *    has no Retry and no "Send to agent".
 *
 * Anything short of that waits. `unknown` — a CORS refusal, an expired preview
 * cookie, a probe that outran its own timeout — is explicitly not evidence and
 * can never, on its own, fail a preview. That is `browser-panel.tsx`'s
 * precedent: when readiness is unknown it keeps waiting rather than asserting
 * a failure it cannot support.
 */
export function previewLoadVerdict(input: {
  /** What the runtime poll knows about the sandbox — see {@link runtimeSandboxHealth}. */
  sandbox: SandboxHealth;
  /** The most recent probe's verdict. */
  probe: PreviewProbe;
  /** How long the port has been CONTINUOUSLY unreachable, ms. Zero whenever the
   *  last probe was anything other than `unreachable`. */
  unreachableForMs: number;
  /** How long the iframe has had a `src` without firing `onLoad`/`onError`, ms. */
  waitedMs: number;
}): 'wait' | 'failed' {
  if (input.sandbox === 'dead') return 'failed';
  if (input.probe === 'unreachable' && input.unreachableForMs >= PREVIEW_UNREACHABLE_WINDOW_MS) {
    return 'failed';
  }
  if (input.waitedMs >= PREVIEW_MAX_WAIT_MS) return 'failed';
  return 'wait';
}

/**
 * The one sentence under "Couldn't load <app>".
 *
 * Reads the SAME three-state health {@link previewLoadVerdict} weighs, and for
 * the same reason: `unknown` is not evidence. Two of the three failure paths —
 * the continuously-unreachable streak and the {@link PREVIEW_MAX_WAIT_MS}
 * ceiling — fire while health is perfectly well `unknown` (the runtime store
 * still `connecting`, or `connected` with `healthy === null`). Deciding this
 * copy on `health !== 'alive'` therefore told those users their workspace had
 * stopped when nothing had established that. Only `dead` — a settled
 * `unreachable` verdict from the runtime poll — earns the stopped wording.
 */
export function previewErrorReason(input: { sandbox: SandboxHealth; port: number }): string {
  if (input.sandbox === 'dead') {
    return 'This workspace has stopped, so the app isn’t reachable anymore.';
  }
  if (input.port > 0) return `The app on port ${input.port} may not be running yet.`;
  return 'The app may not be running yet.';
}

/**
 * Whether the watch should probe the port again.
 *
 * Probing is not free: every probe is a real request against the user's own
 * app, and a cold dev server answers a request by COMPILING. Polling one for
 * the whole {@link PREVIEW_MAX_WAIT_MS} would queue dozens of compiles behind
 * the page the user is actually waiting for — this feature would become a
 * cause of the slowness it exists to tolerate.
 *
 * It also buys nothing. The probe's whole job is the fast negative: the proxy
 * answers `502/503/504` itself, without an upstream connection, when nothing is
 * listening. That answer arrives immediately or not at all. So:
 *
 * - a port that ANSWERED has settled the only question a probe can settle;
 * - a MISS must always be probed on from — the streak either reaches
 *   {@link PREVIEW_UNREACHABLE_WINDOW_MS} (a failure verdict) or is broken by
 *   an answer, and neither can happen without another sample. This outranks
 *   the elapsed check, which is why the loop is bounded at roughly twice the
 *   window rather than exactly once;
 * - past the window with nothing missing, the probe has had every chance to
 *   see a dead port and did not. It will not start now. The remaining wait
 *   belongs to the iframe and to {@link PREVIEW_MAX_WAIT_MS}.
 *
 * The miss test is the probe VERDICT, not `unreachableForMs`. Elapsed streak
 * time cannot stand in for it: the caller starts a streak and reads its
 * elapsed time in the same tick, so the sample that BEGINS a streak always
 * carries `unreachableForMs: 0`. Keying on time therefore failed to protect
 * the one sample the rule exists for — a first miss landing at or after the
 * window stopped the loop after a single sample, and the failure verdict it
 * was heading for was never reached. `unreachableForMs` stays in the signature
 * because it is what {@link previewLoadVerdict} weighs; it just is not what
 * decides whether to look again.
 */
export function shouldKeepProbingPort(input: {
  probe: PreviewProbe;
  /** How long the port has been continuously unreachable, ms. */
  unreachableForMs: number;
  /** How long the watch has been probing, ms. */
  watchedMs: number;
}): boolean {
  if (input.probe === 'reachable') return false;
  if (input.probe === 'unreachable') return true;
  return input.watchedMs < PREVIEW_UNREACHABLE_WINDOW_MS;
}
