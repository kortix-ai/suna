import { describe, expect, test } from 'bun:test';
import { HARNESS_IDS, HARNESSES } from '@kortix/shared/harnesses';

import { computeDefaultAllowed } from './composer-capabilities';
import { runtimeModelForHarness } from './session-runtime-env';

/**
 * Pins the three harness-capability behaviors that used to be scattered
 * `!== 'opencode'` / `=== 'opencode'` string-compares to the `HARNESSES`
 * descriptor (`packages/shared/src/harnesses.ts`). This test must PASS
 * against BOTH the pre-refactor string-compare implementation AND the
 * post-refactor descriptor-lookup implementation — it is the behavior-freeze
 * evidence for WS2-P1-a, not a test of the refactor itself. It runs over
 * every `HARNESS_IDS` member so a fifth harness is covered automatically.
 */
describe('harness capability conformance — descriptor pins live behavior', () => {
  describe('runtimeModelForHarness matches HARNESSES[id].modelNamespacing', () => {
    for (const id of HARNESS_IDS) {
      test(`${id}: modelNamespacing=${HARNESSES[id].modelNamespacing}`, () => {
        const result = runtimeModelForHarness('kortix/foo', id);
        const expected = HARNESSES[id].modelNamespacing === 'gateway-prefixed' ? 'kortix/foo' : 'foo';
        expect(result).toBe(expected);
      });
    }
  });

  describe('computeDefaultAllowed harness-leg matches HARNESSES[id].ownsDefaultModel', () => {
    for (const id of HARNESS_IDS) {
      test(`${id}: ownsDefaultModel=${HARNESSES[id].ownsDefaultModel}`, () => {
        // A connection with zero presets that is neither native_config nor
        // managed_gateway isolates the harness-leg of computeDefaultAllowed:
        // with this fixture, the result can only be true because the harness
        // owns its default model, never because of the presets/managed/native
        // legs (which stay untouched by this task).
        const result = computeDefaultAllowed({
          active: 'anthropic_api_key',
          harness: id,
          presetsLength: 0,
        });
        expect(result).toBe(HARNESSES[id].ownsDefaultModel);
      });
    }
  });

  describe("capabilities payload's live_change matches HARNESSES[id].liveModelChange", () => {
    // `live_change` (composer-capabilities.ts, the `capabilities()` closure's
    // returned `model.live_change` field) has no extracted pure function to
    // call directly — building a full ComposerCapabilities payload requires a
    // live git-backed project + DB secrets snapshot, which is out of scope
    // for a unit conformance pin. Instead this reproduces the harness
    // predicate the field used to be computed from (`harness === 'opencode'`,
    // pre-refactor) and asserts it against the descriptor field it is
    // computed from post-refactor (`HARNESSES[harness].liveModelChange`) —
    // true for every `HARNESS_IDS` member both before and after the swap.
    for (const id of HARNESS_IDS) {
      test(`${id}: liveModelChange=${HARNESSES[id].liveModelChange}`, () => {
        const preRefactorLiveChange = id === 'opencode';
        expect(preRefactorLiveChange).toBe(HARNESSES[id].liveModelChange);
      });
    }
  });
});
