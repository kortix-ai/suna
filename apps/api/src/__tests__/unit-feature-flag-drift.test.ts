/**
 * Cross-package drift gate for the per-project feature-flag list.
 *
 * The same list is declared THREE times, on purpose:
 *   1. `@kortix/api-contract` — `FEATURE_FLAG_KEYS` (zod, the wire contract).
 *   2. `@kortix/sdk` — `FEATURE_FLAG_KEYS` (hand-written; the SDK is
 *      framework-free and dependency-light, so it must not pull zod into every
 *      consumer's bundle to re-derive the contract's list).
 *   3. `apps/api/src/feature-flags/registry.ts` — the registry that owns each
 *      flag's name, description, stability, availability, and enforcement.
 *
 * Nothing at the type level can force those three to agree: (2) is a hand-typed
 * union in a separate published package. This test is the structural guarantee
 * — add a flag to one list and not the others and it fails here.
 *
 * It lives in apps/api because apps/api is the only package that already
 * depends on BOTH `@kortix/api-contract` (runtime dep) and `@kortix/sdk`
 * (devDependency, test-only — see e2e-connector-faces.test.ts) AND owns the
 * registry. Putting it in packages/sdk is not an option: `packages/sdk/AGENTS.md`
 * keeps the core framework-free and import-graph-checked, and it has no
 * dependency on the API's registry at all.
 */
import { describe, expect, test } from 'bun:test';
import {
  FEATURE_FLAG_KEYS as CONTRACT_FEATURE_FLAG_KEYS,
  FeatureFlagStabilitySchema,
} from '@kortix/api-contract';
import { FEATURE_FLAG_KEYS as SDK_FEATURE_FLAG_KEYS } from '@kortix/sdk';

import { REGISTERED_FEATURE_FLAGS, buildFeatureFlagCatalog } from '../feature-flags/registry';

const contractKeys = [...CONTRACT_FEATURE_FLAG_KEYS].sort();
const sdkKeys = [...SDK_FEATURE_FLAG_KEYS].sort();
const registryKeys = REGISTERED_FEATURE_FLAGS.map((flag) => flag.key).sort();
const catalogKeys = buildFeatureFlagCatalog({})
  .map((flag) => flag.key)
  .sort();

describe('feature-flag key lists — contract ↔ SDK ↔ API registry', () => {
  test('the SDK key list matches the contract key list exactly', () => {
    expect(sdkKeys).toEqual(contractKeys);
  });

  test('the API registry matches the contract key list exactly', () => {
    expect(registryKeys).toEqual(contractKeys);
  });

  test('the catalog the clients render matches the SDK key list exactly', () => {
    // The catalog is what Settings → Feature flags actually draws, and the SDK
    // list is what a host uses to name and gate a flag. A flag present in one
    // and not the other is a row nobody can act on, or a gate with no row.
    expect(catalogKeys).toEqual(sdkKeys);
  });

  test('no list carries a duplicate key', () => {
    expect(new Set(contractKeys).size).toBe(contractKeys.length);
    expect(new Set(sdkKeys).size).toBe(sdkKeys.length);
    expect(new Set(registryKeys).size).toBe(registryKeys.length);
  });

  test('all three lists are non-empty', () => {
    // Guards the assertions above against the degenerate case where an import
    // resolves to an empty array and every equality passes vacuously.
    expect(contractKeys.length).toBeGreaterThan(0);
    expect(sdkKeys.length).toBe(contractKeys.length);
    expect(registryKeys.length).toBe(contractKeys.length);
  });
});

describe('feature-flag stability — registry ↔ contract enum', () => {
  test('every registered flag declares a stability the contract accepts', () => {
    for (const flag of REGISTERED_FEATURE_FLAGS) {
      expect(FeatureFlagStabilitySchema.options).toContain(flag.stability);
      expect(FeatureFlagStabilitySchema.safeParse(flag.stability).success).toBe(true);
    }
  });

  test('every catalog entry serializes a stability the contract accepts', () => {
    // The catalog is the serialized wire shape, so this is the value a client
    // actually receives and renders as a badge.
    for (const flag of buildFeatureFlagCatalog({})) {
      expect(FeatureFlagStabilitySchema.options).toContain(flag.stability);
    }
  });
});
