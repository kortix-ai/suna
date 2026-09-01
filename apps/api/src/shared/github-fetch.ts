/**
 * A `fetch` that authenticates GitHub calls, and only GitHub calls.
 *
 * Authenticating lifts the unauthenticated 60 req/hr ceiling to 5,000/hr, which
 * is what makes crawling many subproject repos usable.
 * Deliberately kept out of `@kortix/registry` (which stays pure) and injected as
 * a `fetchImpl` wrapper instead.
 *
 * **This module is a LEAF on purpose.** It imports only the SSRF guard. It used
 * to live inside `marketplace/catalog.ts`, and importing that 2,200-line module
 * for this one function pulled its whole config/db graph into every suite that
 * touched the projects app: 250 failures across billing, accounts and connectors
 * as hand-written `db` mocks lost the exports the real modules needed
 * (`db.update is not a function`). Measured: 6,062 tests / 250 fail with the
 * edge, 8,742 / 2 without it. That is the 2026-08-27 learning — *fix the import,
 * not the mocks* — so the shared concern lives here and both callers import a
 * leaf.
 */

import { safeEgressFetch } from './ssrf-guard';

/**
 * The two hosts a GitHub token may ever be sent to. Matched by EXACT hostname,
 * never a substring: `api.github.com.evil.com` and
 * `evil.com?x=api.github.com` must not receive the token.
 */
const GITHUB_HOSTS = new Set(['api.github.com', 'raw.githubusercontent.com']);

function resolveToken(): string {
  return process.env.GITHUB_TOKEN || process.env.MANAGED_GIT_GITHUB_TOKEN || '';
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}

/**
 * Build the wrapper. Exported (rather than only the singleton) so a test can
 * drive it with an explicit token instead of mutating `process.env`.
 */
export function createGithubFetch(token: string): typeof fetch {
  if (!token) return fetch;
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    let host = '';
    try {
      host = new URL(urlOf(input)).hostname;
    } catch {
      // Unparseable URL → no auth. Never guess.
    }
    if (GITHUB_HOSTS.has(host)) {
      const headers = new Headers(init?.headers);
      if (!headers.has('authorization')) headers.set('authorization', `Bearer ${token}`);
      return fetch(input, { ...init, headers });
    }
    // Any other host — a `url`-kind registry source, a redirect target — goes
    // through the DNS-resolving SSRF guard, so a public domain that resolves to
    // a private or cloud-metadata IP is blocked at fetch time.
    return safeEgressFetch(urlOf(input), init);
  }) as typeof fetch;
}

/** The process-wide authenticated fetch. */
export const githubFetch: typeof fetch = createGithubFetch(resolveToken());

/** Loader options for `@kortix/registry`, which takes an injectable `fetchImpl`. */
export const githubLoaderOptions: { fetchImpl: typeof fetch } = { fetchImpl: githubFetch };
