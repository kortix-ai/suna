/**
 * The `metadata.kortixUrl` stamp on `session_sandboxes`.
 *
 * A sandbox's OpenCode is configured at boot with `KORTIX_LLM_BASE_URL`
 * derived from THIS API's `config.KORTIX_URL` (see
 * `llm-gateway/sandbox-base-url.ts`). Nothing on the row said which origin
 * that was, so when the origin died (dev: cloudflared quick tunnels rotate and
 * the launcher respawns the API with a NEW `KORTIX_URL`) every running box kept
 * calling the dead URL until its next prompt's env sync rewrote it — and the
 * first prompt after a rotation failed inside OpenCode with
 * `Cannot connect to API` (2026-08-22, evening, repeatedly).
 *
 * `provisionSessionSandbox` stamps the origin next to the `instanceId` stamp;
 * `projects/lib/gateway-url-convergence.ts` reads it at API boot to find the
 * boxes whose gateway URL is stale and re-push the live one. Deployed
 * environments have one stable `KORTIX_URL`, so every row's stamp equals the
 * current value there and convergence selects nothing.
 *
 * Dependency-free on purpose (only `../config`): both `platform/services/
 * session-sandbox.ts` and the convergence module import it.
 */
import { config } from '../config';

export const SANDBOX_KORTIX_URL_METADATA_KEY = 'kortixUrl';

/** The current `KORTIX_URL`, trailing slashes trimmed, or undefined when unset. */
export function currentKortixUrl(): string | undefined {
  const raw = config.KORTIX_URL;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed === '' ? undefined : trimmed;
}

/** Metadata fragment to merge into a sandbox row at creation. `{}` when `KORTIX_URL` is unset. */
export function kortixUrlStampMetadata(): Record<string, string> {
  const url = currentKortixUrl();
  return url ? { [SANDBOX_KORTIX_URL_METADATA_KEY]: url } : {};
}

/** The `kortixUrl` stamped on a sandbox row (trailing slashes trimmed), or null when absent. */
export function sandboxKortixUrl(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>)[SANDBOX_KORTIX_URL_METADATA_KEY];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed === '' ? null : trimmed;
}
