/**
 * A password-grant principal's Supabase session, kept valid for the whole run.
 *
 * Supabase access tokens expire after `expires_in` seconds (3600 by default).
 * The runner used to mint each principal's JWT once at world setup and never
 * renew it. Preview runs 36067774228 and 36068206735 (2026-09-24) lasted ~61
 * minutes, and every flow that started after the 60-minute mark failed with
 * `401 Invalid or expired token`.
 *
 * This object IS the principal's `auth` (`{ mode: 'bearer', token }`), so flows
 * keep reading `P.OWNER.auth.token` unchanged. It renews the token through the
 * refresh-token grant in two ways:
 *
 * - `Client` awaits `ensureFresh()` before every request, so a request never
 *   leaves with a token that has less than the margin left.
 * - A background timer renews at the same point, so code that reads `.token`
 *   synchronously (a raw `fetch`, a CLI child process env) also stays valid.
 *
 * There is no "retry on 401" path. Many flows assert a 401 on purpose (revoked
 * or deprovisioned identities). Replaying those with a new token would hide
 * the result. The expiry the server reported is exact, so renewing ahead of it
 * is deterministic.
 */
import { log } from '../core/log';

export interface SupabaseGrant {
  accessToken: string;
  refreshToken: string;
  /** Access-token lifetime the server reported (`expires_in`), in ms. */
  expiresInMs: number;
}

export type RefreshGrant = (refreshToken: string) => Promise<SupabaseGrant>;

/** Schedules the background renewal. Injected by unit tests. */
export interface RefreshTimer {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface SupabaseSessionOptions {
  /** Principal label, for error messages only. */
  label: string;
  grant: SupabaseGrant;
  refresh: RefreshGrant;
  now?: () => number;
  /** Renew when this much or less lifetime remains. See resolveRefreshMarginMs. */
  marginMs?: number;
  /** Background renewal. `null` disables it. Defaults to an unref'd setTimeout. */
  timer?: RefreshTimer | null;
}

const DEFAULT_MARGIN_MS = 20 * 60_000;
/** Below this remaining lifetime a token is treated as unusable. */
const USABLE_FLOOR_MS = 30_000;
/**
 * Wait after a failed refresh before the next attempt, while the token is
 * usable. Also the shortest background interval: a margin at or above the
 * token lifetime (a KE2E_TOKEN_REFRESH_MARGIN_MS override) would otherwise
 * schedule renewals back to back.
 */
const RETRY_AFTER_FAILURE_MS = 30_000;

/**
 * How early to renew.
 *
 * 20 minutes by default, not 5: flows read `.token` synchronously and hand it
 * to raw fetches and CLI processes, and the longest flows run ~16 minutes. A
 * token read at any moment therefore outlives the flow that read it. A token
 * with a lifetime under 40 minutes renews at half its lifetime instead.
 * `KE2E_TOKEN_REFRESH_MARGIN_MS` overrides both, as-is.
 */
export function resolveRefreshMarginMs(
  lifetimeMs: number,
  vars: Record<string, string | undefined> = process.env,
): number {
  const raw = vars.KE2E_TOKEN_REFRESH_MARGIN_MS;
  const configured = raw === undefined || raw === '' ? Number.NaN : Number(raw);
  if (Number.isFinite(configured) && configured >= 0) return Math.trunc(configured);
  return Math.min(DEFAULT_MARGIN_MS, Math.floor(lifetimeMs / 2));
}

/** Render a duration as `42s`, `59m` or `1h 1m`. */
function formatDuration(ms: number): string {
  const seconds = Math.round(Math.abs(ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)}h ${rest}m` : `${Math.floor(minutes / 60)}h`;
}

/**
 * The principal's session could not be renewed and its token is no longer
 * usable. Thrown BEFORE the request is sent, so the report shows the real
 * cause instead of a 401 on whatever route the flow happened to call next.
 */
export class SupabaseSessionRefreshError extends Error {
  readonly ke2eRetryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'SupabaseSessionRefreshError';
    this.ke2eRetryable = retryable;
  }
}

const liveSessions = new Set<SupabaseSessionAuth>();

/** Stop every background renewal. Called by world teardown. */
export function stopAllSessionRefresh(): void {
  for (const session of liveSessions) session.stop();
}

const defaultTimer: RefreshTimer = {
  set(fn, ms) {
    const handle = setTimeout(fn, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export class SupabaseSessionAuth {
  readonly mode = 'bearer' as const;
  // Private fields: JSON.stringify and report capture never see the tokens.
  readonly #label: string;
  readonly #refresh: RefreshGrant;
  readonly #now: () => number;
  readonly #marginMs: number | undefined;
  readonly #timer: RefreshTimer | null;
  #accessToken = '';
  #refreshToken = '';
  #issuedAt = 0;
  #expiresAt = 0;
  #inflight: Promise<void> | null = null;
  #retryNotBefore = 0;
  #handle: unknown = null;
  #stopped = false;

  constructor(opts: SupabaseSessionOptions) {
    this.#label = opts.label;
    this.#refresh = opts.refresh;
    this.#now = opts.now ?? Date.now;
    this.#marginMs = opts.marginMs;
    this.#timer = opts.timer === undefined ? defaultTimer : opts.timer;
    this.#accept(opts.grant);
    if (this.#timer) liveSessions.add(this);
  }

  /** The current access token. Always the newest one this session holds. */
  get token(): string {
    return this.#accessToken;
  }

  /** Epoch ms at which the current access token expires. */
  get expiresAt(): number {
    return this.#expiresAt;
  }

  #margin(): number {
    return this.#marginMs ?? resolveRefreshMarginMs(this.#expiresAt - this.#issuedAt);
  }

  #accept(grant: SupabaseGrant): void {
    const now = this.#now();
    this.#accessToken = grant.accessToken;
    this.#refreshToken = grant.refreshToken;
    this.#issuedAt = now;
    this.#expiresAt = now + grant.expiresInMs;
    this.#retryNotBefore = 0;
    this.#schedule(this.#expiresAt - this.#margin() - now);
  }

  #schedule(delayMs: number): void {
    if (!this.#timer || this.#stopped) return;
    if (this.#handle !== null) this.#timer.clear(this.#handle);
    this.#handle = this.#timer.set(() => {
      this.#handle = null;
      // Success and a survivable failure both reschedule inside #renewOnce.
      // An unusable token stops the timer; the next request retries and fails
      // with the full error.
      this.#renew().catch((err: unknown) => {
        log.warn(`ke2e ${(err as Error)?.message ?? err}`);
      });
    }, Math.max(RETRY_AFTER_FAILURE_MS, delayMs));
  }

  /**
   * Renew the token when the margin is reached. Resolves with the old token
   * still in place when a refresh fails but the token remains usable; rejects
   * with SupabaseSessionRefreshError when it does not.
   */
  async ensureFresh(): Promise<void> {
    const remaining = this.#expiresAt - this.#now();
    if (remaining > this.#margin()) return;
    const usable = remaining > USABLE_FLOOR_MS;
    if (usable && this.#now() < this.#retryNotBefore) return;
    await this.#renew();
  }

  /** One refresh at a time per principal: the refresh token is single-use. */
  #renew(): Promise<void> {
    if (!this.#inflight) {
      this.#inflight = this.#renewOnce().finally(() => {
        this.#inflight = null;
      });
    }
    return this.#inflight;
  }

  async #renewOnce(): Promise<void> {
    let grant: SupabaseGrant;
    try {
      grant = await this.#refresh(this.#refreshToken);
    } catch (err) {
      const now = this.#now();
      const remaining = this.#expiresAt - now;
      const cause = (err as Error)?.message ?? String(err);
      this.#retryNotBefore = now + RETRY_AFTER_FAILURE_MS;
      if (remaining > USABLE_FLOOR_MS) {
        log.warn(
          `ke2e ${this.#label} session refresh failed; the current token remains valid for ` +
            `${formatDuration(remaining)}: ${cause}`,
        );
        if (this.#handle === null) this.#schedule(RETRY_AFTER_FAILURE_MS);
        return;
      }
      const expiry =
        remaining > 0 ? `expires in ${formatDuration(remaining)}` : `expired ${formatDuration(remaining)} ago`;
      const retryable =
        typeof err === 'object' && err !== null && (err as { ke2eRetryable?: unknown }).ke2eRetryable === true;
      throw new SupabaseSessionRefreshError(
        `principal ${this.#label}: Supabase session refresh failed and its access token ${expiry} ` +
          `(issued ${formatDuration(now - this.#issuedAt)} ago). The request was not sent. Cause: ${cause}`,
        retryable,
      );
    }
    this.#accept(grant);
  }

  /** Cancel the background renewal. The token stays readable. */
  stop(): void {
    this.#stopped = true;
    if (this.#timer && this.#handle !== null) this.#timer.clear(this.#handle);
    this.#handle = null;
    liveSessions.delete(this);
  }

  toJSON(): { mode: 'bearer' } {
    return { mode: this.mode };
  }
}
