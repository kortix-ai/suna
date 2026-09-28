/**
 * Rule 5 (spec §3, the runtime-convergence contract (PR #7785)): "A turn that cannot run
 * because the box's model map lacks the requested model must fail with an
 * error that NAMES that cause and carries both fingerprints." Measured three
 * times with different refs: `500 {"name":"UnknownError","ref":"err_…"}` — a
 * bug, not a state.
 *
 * This does not fix the daemon (a parallel branch owns the turn-start
 * model-catalog refresh). It gives the SURFACE a name when the box this
 * request just hit is exactly the one Rule 1's diff already flags as behind
 * on its catalog — the same evidence the admission gate (Rule 4) and `GET
 * /config`'s `runtime` block already compute, read here instead of guessed at.
 *
 * Deliberately conservative: it only replaces the body when it has POSITIVE
 * evidence (the box reported a DIFFERENT fingerprint than the platform's
 * current one). A box that reports nothing (`unknown`) is not evidence either
 * way, and the original bytes reach the client unchanged — never a fabricated
 * cause.
 */

import { diffRuntime } from './diff';
import type { ActualRuntimeDocument } from './actual';
import type { DesiredRuntimeDocument } from './desired';

export interface NamedStaleCatalogError {
  error: string;
  code: 'SESSION_MODEL_CATALOG_STALE';
  desired_catalog_fingerprint: string | null;
  actual_catalog_fingerprint: string | null;
  /** The opaque body this replaced, kept for support/debugging. */
  upstream: unknown;
}

export interface NameStaleCatalogErrorDeps {
  desiredRuntime: () => Promise<DesiredRuntimeDocument>;
  actualRuntime: () => Promise<ActualRuntimeDocument>;
}

function isUnknownErrorBody(value: unknown): boolean {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).name === 'UnknownError';
}

/**
 * `bodyText` is the upstream 500's raw text (read once by the caller — this
 * function never re-reads the response). Returns `null` when this body/session
 * is not explainable as a stale catalog, so the caller passes the ORIGINAL
 * bytes through untouched.
 */
export async function nameStaleModelCatalogError(
  bodyText: string,
  deps: NameStaleCatalogErrorDeps,
): Promise<NamedStaleCatalogError | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (!isUnknownErrorBody(parsed)) return null;

  const [desired, actual] = await Promise.all([deps.desiredRuntime(), deps.actualRuntime()]);
  const diff = diffRuntime(desired, actual);
  const catalog = diff.components.find((c) => c.name === 'catalog_fingerprint');
  if (!catalog || catalog.actual === null || catalog.matches) return null;

  return {
    error:
      "This session's box cannot serve the requested model: its model catalog is stale relative to the platform's current lineup. A convergence pass will bring it forward.",
    code: 'SESSION_MODEL_CATALOG_STALE',
    desired_catalog_fingerprint: desired.catalog_fingerprint,
    actual_catalog_fingerprint: typeof catalog.actual === 'string' ? catalog.actual : String(catalog.actual),
    upstream: parsed,
  };
}
