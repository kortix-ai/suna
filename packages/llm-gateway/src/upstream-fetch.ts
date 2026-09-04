/**
 * The platform `fetch`, with Bun's hidden idle timeout switched off.
 *
 * Bun's `fetch` carries a default 300 s IDLE timeout on the socket that no
 * caller asked for and that the Fetch API does not describe. Measured on Bun
 * 1.3.14 (2026-08-25):
 *   - upstream sends headers, then nothing: throws at 300.0 s with
 *     `TimeoutError: The operation timed out.`;
 *   - upstream sends no headers at all: same, at 300.0 s;
 *   - upstream drips a byte every 60 s: lives past 420 s — the timer is idle
 *     time, not total time;
 *   - a caller-provided `signal` does NOT disable it;
 *   - `timeout: false` (or `0`) does.
 *
 * Incident: an Essentia turn on `codex/gpt-5.6-sol` at reasoning effort `max`
 * died after 273.8 s with `{"message":"The operation timed out.","code":
 * "upstream_timeout"}` — the provider was still thinking, silently, and the
 * gateway's fetch to it was killed by this timer. Nothing in this repo set a
 * 300 s timer; nothing in this repo could have logged one.
 *
 * The gateway owns every timeout on the provider hop explicitly: response
 * headers (`withUpstreamHeadersTimeout`, 90 s direct / 5 min synthetic
 * streaming) and body inactivity (`relayStream`, 90 min). A hidden third one
 * makes those two a lie, so every upstream call goes through here.
 *
 * `timeout` is a Bun-only `RequestInit` extension; Node's undici ignores an
 * unknown key, so this is safe under both runtimes.
 */
export type UpstreamFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface NoIdleTimeoutInit extends RequestInit {
  /** Bun: `false` disables the runtime's default 300 s idle timeout. */
  timeout: false;
}

export function withoutIdleTimeout(init?: RequestInit): NoIdleTimeoutInit {
  return { ...init, timeout: false };
}

export const upstreamFetch: UpstreamFetch = (input, init) =>
  globalThis.fetch(input, withoutIdleTimeout(init));
