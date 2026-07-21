import { describe, expect, test } from 'bun:test';
import { HARNESSES, HARNESS_IDS } from '@kortix/shared/harnesses';

import { resolveHarnessModels } from '../../llm-gateway/resolution/harness-models';
import { runtimeModelForHarness } from './session-runtime-env';

/**
 * Pins the three harness-capability behaviors that used to be scattered
 * `!== 'opencode'` / `=== 'opencode'` string-compares to the `HARNESSES`
 * descriptor (`packages/shared/src/harnesses.ts`). This test must PASS
 * against BOTH the pre-refactor string-compare implementation AND the
 * post-refactor descriptor-lookup implementation — it is the behavior-freeze
 * evidence for WS2-P1-a, not a test of the refactor itself. It runs over
 * every `HARNESS_IDS` member so a fifth harness is covered automatically.
 *
 * CARRIED FIX (2026-07-21 model-resolution refactor, phase 1): the
 * `computeDefaultAllowed harness-leg` block used to import the now-DELETED
 * `computeDefaultAllowed` directly. That pure function is gone — its
 * harness-owns-its-default short-circuit survives inside
 * `resolveHarnessModels` (`llm-gateway/resolution/harness-models.ts`), so
 * this block now pins the SAME conformance fact (a harness's
 * `ownsDefaultModel` flag deterministically drives whether the resolution is
 * `ready` with an empty catalog) against the real resolver instead of the
 * deleted pure function.
 */
describe('harness capability conformance — descriptor pins live behavior', () => {
  describe('runtimeModelForHarness matches HARNESSES[id].modelNamespacing', () => {
    for (const id of HARNESS_IDS) {
      test(`${id}: modelNamespacing=${HARNESSES[id].modelNamespacing}`, () => {
        const result = runtimeModelForHarness('kortix/foo', id);
        const expected =
          HARNESSES[id].modelNamespacing === 'gateway-prefixed' ? 'kortix/foo' : 'foo';
        expect(result).toBe(expected);
      });
    }
  });

  describe('resolveHarnessModels.ownsDefaultModel matches HARNESSES[id].ownsDefaultModel, and drives the no-catalog ready shape', () => {
    for (const id of HARNESS_IDS) {
      test(`${id}: ownsDefaultModel=${HARNESSES[id].ownsDefaultModel}`, async () => {
        // The harness's OWN first-listed compatible auth kind, configured —
        // isolates the harness-leg: with this fixture, `ready` with an empty
        // `models` array can only happen because the harness owns its
        // default model, never because of the catalog-conditioning legs
        // (which stay untouched by this task).
        const firstKind = HARNESSES[id].authKinds[0]!;
        const env: Record<string, string> =
          firstKind === 'codex_subscription'
            ? { CODEX_AUTH_JSON: '{}' }
            : firstKind === 'claude_subscription'
              ? { CLAUDE_CODE_OAUTH_TOKEN: 'sub' }
              : { ANTHROPIC_API_KEY: 'test-key' };
        const result = await resolveHarnessModels({
          harness: id,
          projectId: 'proj-conformance',
          userId: 'user-conformance',
          env,
          gatewayEnabled: false,
          nativeConfigReady: false,
          resolveCodex: async () => ({ access: 'token', accountId: undefined }),
        });
        expect(result.ownsDefaultModel).toBe(HARNESSES[id].ownsDefaultModel);
        if (HARNESSES[id].ownsDefaultModel) {
          expect(result.state).toBe('ready');
          expect(result.models).toEqual([]);
        }
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
