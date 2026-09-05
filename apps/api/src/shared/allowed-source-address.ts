/**
 * Source-address safety guard (LFI / SSRF) for caller-supplied addresses.
 *
 * A source address is user-supplied and global, so the hosted API must not read
 * the server's disk (`local`) or fetch internal URLs (`url` → cloud metadata,
 * localhost, RFC-1918). `local` is dev-only behind an opt-in flag.
 *
 * **Why this is its own leaf module.** It used to live in
 * `marketplace/catalog.ts` (2,200 lines) and was imported by four modules that
 * have nothing to do with a catalog — connector spec/MCP/GraphQL fetches
 * (`connectors/sync.ts`, `connectors/router.ts`), audit-webhook delivery
 * (`shared/audit-webhooks.ts`) and the account audit route
 * (`accounts/audit.ts`). That import dragged the catalog's whole config/db
 * graph into every suite touching those modules, which is the 2026-08-27
 * learning *"reach for a leaf, not the module that holds the helper"* — the
 * same reason `shared/github-fetch.ts` was extracted from that file. The
 * catalog is gone now; this guard outlives it because its consumers do.
 *
 * This is the ADDRESS-shape check only. It is not a substitute for
 * `safeEgressFetch` in `shared/ssrf-guard.ts`, which resolves DNS at fetch time
 * and re-validates every redirect hop — a public hostname that resolves to a
 * private IP passes the check here and is rejected there. Call sites use both:
 * this one to reject bad input with a 400, that one to make the fetch safe.
 */

import { parseRegistryAddress, type RegistryRef } from '@kortix/registry';

/**
 * Dev-only escape hatch for local-folder sources. No deployed environment sets
 * this, so it is `false` everywhere; it exists so a developer can point a
 * source at a checkout. Renamed from `KORTIX_MARKETPLACE_ALLOW_LOCAL` when the
 * marketplace was removed — nothing set either name, so the rename cannot
 * change behavior anywhere.
 */
const ALLOW_LOCAL_SOURCES = process.env.KORTIX_ALLOW_LOCAL_SOURCES === '1';

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '127.0.0.1' || h === '0.0.0.0' || h === '::1' || h.startsWith('127.')) return true;
  if (h.startsWith('169.254.')) return true; // link-local incl. 169.254.169.254 cloud metadata
  if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h.endsWith('.internal') || h.endsWith('.local')) return true;
  return false;
}

function isAllowedSourceRef(ref: RegistryRef): boolean {
  if (ref.kind === 'github' || ref.kind === 'namespace') return true;
  if (ref.kind === 'local') return ALLOW_LOCAL_SOURCES;
  if (ref.kind === 'url') {
    try {
      const u = new URL(ref.url);
      return u.protocol === 'https:' && !isPrivateHost(u.hostname);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Stable error code for the expected "user supplied a source address we refuse
 * to fetch / read" validation state (non-https URL, private host, local-folder
 * path). Surfaced on the typed {@link AllowedSourceValidationError} so the
 * connector route handlers can catch it and return a structured 400 instead of
 * letting the throw propagate to `app.onError` → `captureException` → Sentry
 * (Better Stack pattern `f5c0ce61…`). Mirrors the `feature_not_supported`
 * (#5240) + `RepoFileNotFoundError` (#5652) typed-error pattern: an EXPECTED
 * user-input validation state must NOT page like a server defect.
 */
export const INVALID_SOURCE_ADDRESS_CODE = 'invalid_source_address';

/**
 * Typed error thrown by {@link assertAllowedSourceAddress} when a source
 * address isn't a safe source to add (the LFI/SSRF guard). Carries a stable
 * `code` so route handlers branch on it (400) without swallowing genuine
 * server failures. Distinct from a bare `Error` so callers catch the expected
 * validation case and let real errors fall through.
 */
export class AllowedSourceValidationError extends Error {
  readonly code = INVALID_SOURCE_ADDRESS_CODE;
  constructor(message: string) {
    super(message);
    this.name = 'AllowedSourceValidationError';
  }
}

/** Narrow an unknown to {@link AllowedSourceValidationError} (the typed
 *  validation throw from {@link assertAllowedSourceAddress}). */
export function isAllowedSourceValidationError(
  err: unknown,
): err is AllowedSourceValidationError {
  return err instanceof AllowedSourceValidationError;
}

/** Throw with a clear reason if an address isn't a safe source to add (LFI/SSRF guard). */
export function assertAllowedSourceAddress(address: string): void {
  let ref: RegistryRef;
  try {
    ref = parseRegistryAddress(address);
  } catch (err) {
    throw new AllowedSourceValidationError(
      `Unrecognized source address: ${(err as Error).message}`,
    );
  }
  if (isAllowedSourceRef(ref)) return;
  if (ref.kind === 'local')
    throw new AllowedSourceValidationError('Local-folder sources are not allowed on this server.');
  if (ref.kind === 'url')
    throw new AllowedSourceValidationError('Only https registry URLs on public hosts are allowed.');
  throw new AllowedSourceValidationError('This source type is not allowed.');
}
