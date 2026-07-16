import { describe, expect, test } from 'bun:test';

import { HARNESS_IDS, HARNESSES } from '@kortix/shared/harnesses';
import type { HarnessAuthKind, HarnessId } from '@kortix/sdk/projects-client';

import { METHOD_COMPATIBLE_HARNESSES } from './connect-model-modal';

// Every auth kind the web UI knows about (ConnectMethod + the native-config /
// managed-gateway rows). This enumeration is the SDK's `HarnessAuthKind`
// surface, not harness identity, so it stays hand-written here — only the
// harness-id membership per kind is derived from the canonical descriptor.
const AUTH_KINDS: readonly HarnessAuthKind[] = [
  'managed_gateway',
  'claude_subscription',
  'codex_subscription',
  'anthropic_api_key',
  'openai_api_key',
  'openai_compatible',
  'anthropic_compatible',
  'native_config',
];

function deriveMethodCompatibleHarnesses(): Record<HarnessAuthKind, HarnessId[]> {
  return Object.fromEntries(
    AUTH_KINDS.map((kind) => [kind, HARNESS_IDS.filter((id) => HARNESSES[id].authKinds.includes(kind))]),
  ) as Record<HarnessAuthKind, HarnessId[]>;
}

describe('METHOD_COMPATIBLE_HARNESSES pins the @kortix/shared harness descriptor', () => {
  test('the auth-kind -> compatible-harnesses map matches the descriptor-derived inversion exactly', () => {
    // This is the load-bearing equivalence check for WS2-P0-b: the web
    // literal (hand-mirrored from apps/api's composer-capabilities.ts
    // CONNECTIONS table) must deep-equal what you get by inverting each
    // harness's `authKinds` from the canonical descriptor. If this ever
    // fails, it is a real web<->server drift bug, not a test bug.
    expect(METHOD_COMPATIBLE_HARNESSES).toEqual(deriveMethodCompatibleHarnesses());
  });

  test('every derived entry, checked individually, so a single-kind drift names the kind', () => {
    const derived = deriveMethodCompatibleHarnesses();
    for (const kind of AUTH_KINDS) {
      expect(METHOD_COMPATIBLE_HARNESSES[kind], `kind: ${kind}`).toEqual(derived[kind]);
    }
  });
});
