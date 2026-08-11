import { config } from '../config';

/**
 * The dosco FRONTEND base URL (no trailing slash) a sandbox is given as
 * `KORTIX_FRONTEND_URL`, set alongside `KORTIX_API_URL`.
 *
 * A sandbox only ever talks to the API host, so without this the agent (and the
 * baked `kortix` CLI) has no way to build a user-facing dashboard link except by
 * string-munging the API host — which silently produced
 * `api-prod.dosco.live/projects/…` links instead of `dosco.live/projects/…`.
 * This hands it the server's own `config.FRONTEND_URL`, verbatim, so it never
 * has to guess. It is a public URL, not a secret, so it does not weaken the
 * sandbox secret/routing contract in ./sandbox-env.ts.
 *
 * Kept in its own module (not in sandbox-env.ts) so that file's predicates stay
 * import-free of `config` and testable without booting the server.
 */
export function sandboxFrontendBaseUrl(): string {
  return (config.FRONTEND_URL || 'https://dosco.live').replace(/\/+$/, '');
}
