/**
 * Which runtime harnesses this deployment will actually launch.
 *
 * A project's harness is DECLARED by its manifest (`runtimes.<name>.harness`,
 * compiled in ./compile-runtime-config) and RESOLVED here. The manifest is an
 * input, never an authority: a repo can declare `harness: pi` and this gate
 * still refuses to launch it unless the operator enabled that harness.
 *
 * The stable path is the set of harnesses `@kortix/shared/harnesses` marks
 * `stability: 'stable'` — today exactly `opencode`. Everything else
 * (`claude`, `codex`, `pi`) is experimental and reachable only when an operator
 * names it in `KORTIX_ENABLED_HARNESSES`. Promoting a harness to `stable` in
 * the shared descriptor table widens this default on its own, so the two never
 * drift.
 *
 * The gate REFUSES; it never silently substitutes `opencode`. A project whose
 * manifest asks for `claude` on a deployment that disabled `claude` gets a 409
 * naming the harness — running a different harness against `.claude/` config
 * would be a wrong answer dressed up as a working one.
 */
import { HARNESSES, HARNESS_IDS, type HarnessId, isHarnessId } from '@kortix/shared/harnesses';

import { config } from '../../config';

/** Harnesses the shared descriptor table declares production-ready. */
export function stableHarnessIds(): HarnessId[] {
  return HARNESS_IDS.filter((id) => HARNESSES[id].stability === 'stable');
}

/**
 * The effective allowlist: the stable set, plus every valid harness id the
 * operator named. `opencode` can never be removed — the allowlist only ADDS
 * experimental harnesses, so a typo cannot take the product down. Unknown
 * tokens are ignored rather than failing open. Output keeps the shared
 * presentation order.
 */
export function enabledHarnessIds(raw?: string | null): HarnessId[] {
  const source = raw === undefined ? config.KORTIX_ENABLED_HARNESSES : raw;
  const enabled = new Set<HarnessId>(stableHarnessIds());
  for (const token of (source ?? '').split(',')) {
    const candidate = token.trim().toLowerCase();
    if (isHarnessId(candidate)) enabled.add(candidate);
  }
  return HARNESS_IDS.filter((id) => enabled.has(id));
}

/** Will this deployment launch `harness`? */
export function isHarnessEnabled(harness: unknown, raw?: string | null): boolean {
  if (!isHarnessId(harness)) return false;
  return enabledHarnessIds(raw).includes(harness);
}

export interface HarnessNotEnabledError {
  status: 409;
  body: { error: string; code: 'HARNESS_NOT_ENABLED' };
}

/** The refusal a caller sees when a manifest declares a disabled harness. */
export function harnessNotEnabledError(harness: HarnessId): HarnessNotEnabledError {
  return {
    status: 409,
    body: {
      error: `The ${HARNESSES[harness].label} harness is not enabled on this deployment. An operator enables it by adding "${harness}" to KORTIX_ENABLED_HARNESSES.`,
      code: 'HARNESS_NOT_ENABLED',
    },
  };
}
