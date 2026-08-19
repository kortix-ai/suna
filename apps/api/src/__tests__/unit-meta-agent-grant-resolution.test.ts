// The reserved coordinator's grant is PLATFORM-owned, and every path that
// resolves a grant has to agree on that — not just the mint.
//
// `remintGrantForAgentSwitch` re-resolves the running agent's grant on every
// prompt and writes the result onto the session's token row, and
// `reconcileStoredSessionAgentGrant` does the same before a connector call.
// Both go through `grantFromLoadedAgents`, which reads the PROJECT MANIFEST —
// and `meta` is never declared in one. So the coordinator's token was minted
// with `kortixCli: 'all'` and then rewritten on its first turn:
//
//   governed project (declares agents:)  -> unlisted -> default-DENY, and the
//     re-mint WROTE `kortixCli: []` over the real grant. Every later `kortix`
//     call 403'd with `agent_scope_insufficient`.
//   ungoverned project (declares none)   -> UNRESTRICTED null, and the re-mint
//     refuses rather than widen, failing the prompt outright.
//
// These tests pin the resolution for all three manifest shapes, pin that the
// re-mint is now a no-op for meta, and pin that nothing else moved.
import { describe, expect, test } from 'bun:test';

import { grantFromLoadedAgents, type LoadedAgents } from '../projects/agents';
import { platformMetaAgentGrant } from '../projects/lib/platform-meta-agent';
import { remintDecisionFor } from '../projects/lib/session-token-grant';
import { agentGrantDiffers } from '../projects/lib/secret-grant';

const UNGOVERNED: LoadedAgents = { specs: [], errors: [], defaultAgent: null };

const GOVERNED: LoadedAgents = {
  specs: [
    {
      name: 'kortix',
      enabled: true,
      kortixCli: 'all',
      connectors: 'all',
      env: 'all',
    },
    {
      name: 'worker',
      enabled: true,
      kortixCli: ['project.session.read'],
      connectors: [],
      env: [],
    },
  ] as unknown as LoadedAgents['specs'],
  errors: [],
  defaultAgent: 'kortix',
};

const UNREADABLE: LoadedAgents = {
  specs: [],
  errors: [{ name: '(manifest)', path: 'kortix.yaml', error: 'Failed to read manifest' }],
  defaultAgent: null,
};

describe('grantFromLoadedAgents — the reserved meta coordinator', () => {
  test('resolves to the platform grant on a GOVERNED project', () => {
    // Was: { agent: 'meta', kortixCli: [], connectors: [], env: [] } — the
    // unlisted-agent default-deny, which the per-prompt re-mint then wrote onto
    // the session token.
    expect(grantFromLoadedAgents('meta', GOVERNED)).toEqual(platformMetaAgentGrant());
  });

  test('resolves to the platform grant on an UNGOVERNED project', () => {
    // Was: null (UNRESTRICTED), which made the re-mint refuse the prompt.
    expect(grantFromLoadedAgents('meta', UNGOVERNED)).toEqual(platformMetaAgentGrant());
  });

  test('resolves to the platform grant even when the manifest is unreadable', () => {
    // Fail-closed still holds: the platform grant is a fixed, known value that
    // never depends on repository content, so an unreadable manifest cannot
    // widen it.
    expect(grantFromLoadedAgents('meta', UNREADABLE)).toEqual(platformMetaAgentGrant());
  });

  test('carries no connectors and no secrets, on every manifest shape', () => {
    for (const loaded of [UNGOVERNED, GOVERNED, UNREADABLE]) {
      const grant = grantFromLoadedAgents('meta', loaded);
      expect(grant?.connectors).toEqual([]);
      expect(grant?.env).toEqual([]);
    }
  });

  test('the per-prompt re-mint is now a no-op for a meta session', () => {
    // What the token holds at mint vs. what a prompt now resolves.
    const stored = platformMetaAgentGrant();
    const running = grantFromLoadedAgents('meta', GOVERNED);
    expect(agentGrantDiffers(stored, running)).toBe(false);
    expect(remintDecisionFor(stored, running)).toEqual({ action: 'skip' });
  });

  test('BEFORE the fix the same re-mint destroyed the grant (regression guard)', () => {
    // The exact decision the old resolution produced. Kept as an explicit
    // statement of what must never happen again.
    const stored = platformMetaAgentGrant();
    const oldResolution = { agent: 'meta', kortixCli: [], connectors: [], env: [] };
    expect(remintDecisionFor(stored, oldResolution)).toEqual({
      action: 'write',
      grant: oldResolution,
    });
  });
});

describe('grantFromLoadedAgents — no other principal is widened', () => {
  test('a declared narrow agent keeps exactly its declared kortix_cli', () => {
    expect(grantFromLoadedAgents('worker', GOVERNED)).toEqual({
      agent: 'worker',
      kortixCli: ['project.session.read'],
      connectors: [],
      env: [],
    });
  });

  test('an UNDECLARED non-meta agent still default-denies on a governed project', () => {
    expect(grantFromLoadedAgents('not-declared', GOVERNED)).toEqual({
      agent: 'not-declared',
      kortixCli: [],
      connectors: [],
      env: [],
    });
  });

  test('an agent named meta-something is NOT the reserved coordinator', () => {
    // The reserved name is exact (`isMetaAgentName`). A near-miss must fall
    // through to ordinary manifest resolution.
    expect(grantFromLoadedAgents('meta-worker', GOVERNED)).toEqual({
      agent: 'meta-worker',
      kortixCli: [],
      connectors: [],
      env: [],
    });
    expect(grantFromLoadedAgents('Meta', GOVERNED)).toEqual({
      agent: 'Meta',
      kortixCli: [],
      connectors: [],
      env: [],
    });
  });

  test('an ungoverned project still resolves every ordinary agent to unrestricted', () => {
    expect(grantFromLoadedAgents('kortix', UNGOVERNED)).toBeNull();
    expect(grantFromLoadedAgents('anything', UNGOVERNED)).toBeNull();
  });
});
