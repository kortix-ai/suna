import { describe, expect, test } from 'bun:test';

import type { ModelsPageConnection } from '@kortix/sdk/react';

import {
  buildRuntimeRows,
  connectedHarnessesFromModelsPage,
  nextAgentBlockForRuntime,
  runtimeSelectOptions,
  savingBarStyle,
} from './runtime-view-model';

function modelsPageConnection(
  over: Partial<ModelsPageConnection> & Pick<ModelsPageConnection, 'kind'>,
): ModelsPageConnection {
  return {
    id: over.kind,
    name: over.kind,
    status: 'ready',
    usedBy: [],
    catalogState: 'available',
    modelCount: null,
    statusReason: null,
    ...over,
  };
}

describe('connectedHarnessesFromModelsPage', () => {
  test('keys ready connections by every harness the auth kind is compatible with', () => {
    const map = connectedHarnessesFromModelsPage([
      modelsPageConnection({ kind: 'claude_subscription', status: 'ready' }),
      modelsPageConnection({ kind: 'codex_subscription', status: 'needs-attention' }),
    ]);
    expect(map.claude?.kind).toBe('claude_subscription');
    // Not ready — must not count as connected.
    expect(map.codex).toBeUndefined();
    expect(map.opencode).toBeUndefined();
  });

  test('a managed_gateway connection is compatible with opencode and pi, not claude/codex', () => {
    const map = connectedHarnessesFromModelsPage([
      modelsPageConnection({ kind: 'managed_gateway', status: 'ready' }),
    ]);
    expect(map.opencode?.kind).toBe('managed_gateway');
    expect(map.pi?.kind).toBe('managed_gateway');
    expect(map.claude).toBeUndefined();
    expect(map.codex).toBeUndefined();
  });

  test('empty input yields an empty map', () => {
    expect(connectedHarnessesFromModelsPage([])).toEqual({});
  });

  test('a ready connection with zero routed agents still counts as connected — the fix for the '
    + 'agent-presence-gating bug (WS5-P2-a review): unlike `useModelsPage(...).runtimes`, which is '
    + 'derived from declared agents and omits any harness with none currently routed, `connections` '
    + 'carries no such gate', () => {
    // No `ModelsPageRuntime` entries exist for `claude` at all here (that
    // list is what the old, buggy derivation read) — only a bare ready
    // connection, which is all a harness needs to be genuinely connected.
    const map = connectedHarnessesFromModelsPage([
      modelsPageConnection({ kind: 'claude_subscription', status: 'ready' }),
    ]);
    expect(map.claude?.status).toBe('ready');
  });
});

describe('buildRuntimeRows', () => {
  test('one row per declared runtime profile, keyed by profile name', () => {
    const rows = buildRuntimeRows(
      {
        claude: { harness: 'claude', config_dir: '.claude' },
        'runtime-2': { harness: 'opencode' },
      },
      {},
      true,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.profileName)).toEqual(['claude', 'runtime-2']);
  });

  test('label comes from the canonical harness descriptor, not the profile name', () => {
    const rows = buildRuntimeRows({ 'my-custom-slug': { harness: 'claude' } }, {}, true);
    expect(rows[0]!.label).toBe('Claude Code');
    expect(rows[0]!.label).not.toContain('my-custom-slug');
  });

  test('claude/codex/pi are experimental, opencode is stable', () => {
    const rows = buildRuntimeRows(
      {
        claude: { harness: 'claude' },
        codex: { harness: 'codex' },
        opencode: { harness: 'opencode' },
        pi: { harness: 'pi' },
      },
      {},
      true,
    );
    const experimentalByHarness = Object.fromEntries(rows.map((r) => [r.harness, r.experimental]));
    expect(experimentalByHarness).toEqual({
      claude: true,
      codex: true,
      opencode: false,
      pi: true,
    });
  });

  test('a ready connection produces a plain-words "Connected via …" meta line and connected: true', () => {
    const rows = buildRuntimeRows(
      { claude: { harness: 'claude' } },
      connectedHarnessesFromModelsPage([
        modelsPageConnection({ kind: 'claude_subscription', status: 'ready' }),
      ]),
      true,
    );
    expect(rows[0]!.connected).toBe(true);
    expect(rows[0]!.meta).toBe('Runs Claude Code · Connected via Claude subscription');
  });

  test('a missing/unready connection reads "Not connected" — no jargon connection-kind ids', () => {
    const rows = buildRuntimeRows(
      { claude: { harness: 'claude' } },
      connectedHarnessesFromModelsPage([
        modelsPageConnection({ kind: 'claude_subscription', status: 'needs-attention' }),
      ]),
      true,
    );
    expect(rows[0]!.connected).toBe(false);
    expect(rows[0]!.meta).toBe('Runs Claude Code · Not connected');
  });

  test('a harness with no entry in the connection map defaults to not connected', () => {
    const rows = buildRuntimeRows({ pi: { harness: 'pi' } }, {}, true);
    expect(rows[0]!.connected).toBe(false);
    expect(rows[0]!.meta).toBe('Runs Pi · Not connected');
  });

  test(
    'a harness with a ready compatible connection but zero routed agents still reads Connected — ' +
      'regression test for the WS5-P2-a review Important finding: the badge must not be gated on ' +
      'agent presence',
    () => {
      const rows = buildRuntimeRows(
        { claude: { harness: 'claude' } },
        connectedHarnessesFromModelsPage([
          // Simulates the real-world "just enabled harnesses, no agent
          // routed yet" state: a ready connection exists, no agent routing
          // data backs it.
          modelsPageConnection({ kind: 'claude_subscription', status: 'ready' }),
        ]),
        true,
      );
      expect(rows[0]!.connected).toBe(true);
      expect(rows[0]!.meta).toBe('Runs Claude Code · Connected via Claude subscription');
    },
  );

  test('no row ever contains manifest jargon (schema_version, kortix.yaml, config-dir paths)', () => {
    const rows = buildRuntimeRows(
      { claude: { harness: 'claude', config_dir: '.claude' } },
      connectedHarnessesFromModelsPage([
        modelsPageConnection({ kind: 'claude_subscription', status: 'ready' }),
      ]),
      true,
    );
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain('schema_version');
    expect(serialized).not.toContain('kortix.yaml');
    expect(serialized).not.toContain('kortix.toml');
    expect(serialized).not.toContain('.claude');
  });

  // ─── OpenCode-first: filter experimental rows when the flag is off ───────

  test('experimentalHarnessesEnabled=false filters out claude/codex/pi rows, keeps opencode', () => {
    const rows = buildRuntimeRows(
      {
        claude: { harness: 'claude' },
        codex: { harness: 'codex' },
        opencode: { harness: 'opencode' },
        pi: { harness: 'pi' },
      },
      {},
      false,
    );
    expect(rows.map((r) => r.harness)).toEqual(['opencode']);
  });

  test('experimentalHarnessesEnabled=true keeps every row, including experimental ones', () => {
    const rows = buildRuntimeRows(
      {
        claude: { harness: 'claude' },
        opencode: { harness: 'opencode' },
      },
      {},
      true,
    );
    expect(rows.map((r) => r.harness)).toEqual(['claude', 'opencode']);
    expect(rows.find((r) => r.harness === 'claude')!.experimental).toBe(true);
  });

  test('a runtimes map with only experimental harnesses and the flag off yields zero rows', () => {
    const rows = buildRuntimeRows(
      { claude: { harness: 'claude' }, codex: { harness: 'codex' } },
      {},
      false,
    );
    expect(rows).toEqual([]);
  });
});

describe('nextAgentBlockForRuntime', () => {
  // The Runtime section's harness Select writes through `PUT
  // /agents/:name/config`, which rebuilds the whole governance block from the
  // request body. These pin the two ways that can go wrong.

  test('carries the existing governance over — a bare { runtime } would strip the agent grants', () => {
    const next = nextAgentBlockForRuntime(
      {
        runtime: 'opencode',
        agent: 'kortix',
        connectors: 'all',
        secrets: 'all',
        kortix_cli: ['project.cr.open'],
        skills: 'all',
      },
      'opencode',
      'opencode',
    );
    expect(next).toEqual({
      runtime: 'opencode',
      agent: 'kortix',
      connectors: 'all',
      secrets: 'all',
      kortix_cli: ['project.cr.open'],
      skills: 'all',
    });
  });

  test('switching to a brand harness drops `agent` — only OpenCode has named sub-agents', () => {
    const next = nextAgentBlockForRuntime(
      { runtime: 'opencode', agent: 'kortix', connectors: 'all' },
      'claude',
      'claude',
    );
    expect(next.runtime).toBe('claude');
    expect('agent' in next).toBe(false);
    // Governance still survives the harness switch.
    expect(next.connectors).toBe('all');
  });

  test('switching back to OpenCode keeps whatever `agent` the block already had', () => {
    const next = nextAgentBlockForRuntime({ runtime: 'claude' }, 'opencode', 'opencode');
    expect(next).toEqual({ runtime: 'opencode' });
  });

  test('an unknown harness is treated as non-OpenCode rather than assumed safe', () => {
    const next = nextAgentBlockForRuntime({ agent: 'kortix' }, 'runtime-1', undefined);
    expect('agent' in next).toBe(false);
  });

  test('a null block still produces a valid write — runtime is required by the route', () => {
    expect(nextAgentBlockForRuntime(null, 'claude', 'claude')).toEqual({ runtime: 'claude' });
  });

  test('never mutates the block it was given', () => {
    const block = { runtime: 'opencode', agent: 'kortix' };
    nextAgentBlockForRuntime(block, 'claude', 'claude');
    expect(block).toEqual({ runtime: 'opencode', agent: 'kortix' });
  });
});

describe('runtimeSelectOptions', () => {
  test('labels by harness — a profile slug is jargon this section keeps behind Advanced', () => {
    expect(runtimeSelectOptions({ 'my-slug': { harness: 'claude' } })).toEqual([
      { value: 'my-slug', label: 'Claude Code' },
    ]);
  });

  test('appends the profile key only when two profiles share one harness', () => {
    expect(
      runtimeSelectOptions({
        work: { harness: 'claude' },
        personal: { harness: 'claude' },
        opencode: { harness: 'opencode' },
      }),
    ).toEqual([
      { value: 'work', label: 'Claude Code · work' },
      { value: 'personal', label: 'Claude Code · personal' },
      // Unambiguous, so it stays quiet even though its siblings didn't.
      { value: 'opencode', label: 'OpenCode' },
    ]);
  });

  test('the option value stays the manifest key — that is what the PUT writes', () => {
    const [option] = runtimeSelectOptions({ 'runtime-1': { harness: 'pi' } });
    expect(option!.value).toBe('runtime-1');
    expect(option!.label).toBe('Pi');
  });

  test('an empty runtimes map yields no options', () => {
    expect(runtimeSelectOptions({})).toEqual([]);
  });
});

describe('savingBarStyle', () => {
  // The saving bar replaced a spinner sitting beside the Select. It is pinned
  // to the trigger's width and travels left to right.

  test('idle is collapsed and invisible', () => {
    const style = savingBarStyle('idle', false);
    expect(style.transform).toBe('scaleX(0)');
    expect(style.opacity).toBe(0);
  });

  test('saving holds at 90%, never 100% — the write has no knowable duration', () => {
    const style = savingBarStyle('saving', false);
    // Completing on a timer would claim the save finished before it did.
    expect(style.transform).toBe('scaleX(0.9)');
    expect(style.opacity).toBe(1);
  });

  test('done completes to full width', () => {
    expect(savingBarStyle('done', false).transform).toBe('scaleX(1)');
  });

  test('travel is long and strongly eased; completion is fast — slow to decide, fast to respond', () => {
    expect(savingBarStyle('saving', false).transition).toContain('transform 900ms');
    expect(savingBarStyle('done', false).transition).toContain('transform 180ms');
  });

  test('never ease-in, and never the weak built-ins, on the travelling property', () => {
    for (const phase of ['saving', 'done'] as const) {
      const { transition } = savingBarStyle(phase, false);
      expect(transition).toContain('cubic-bezier(0.23, 1, 0.32, 1)');
      expect(transition).not.toMatch(/transform [0-9]+ms ease-in/);
    }
  });

  test('the fade trails the completion so 100% is actually seen', () => {
    // 140ms delay on opacity vs a 180ms transform — the bar reaches full width
    // while still fully opaque.
    expect(savingBarStyle('done', false).transition).toContain('opacity 200ms ease 140ms');
  });

  test('scales, never widths — width would reflow every frame', () => {
    for (const phase of ['idle', 'saving', 'done'] as const) {
      expect(savingBarStyle(phase, false).transition).not.toContain('width');
    }
  });

  test('reduced motion drops the travel but keeps the appear/disappear signal', () => {
    const saving = savingBarStyle('saving', true);
    expect(saving.transform).toBe('none');
    expect(saving.opacity).toBe(1);
    expect(saving.transition).toBe('opacity 200ms ease');
    // Still legible as "not busy" when idle.
    expect(savingBarStyle('idle', true).opacity).toBe(0);
  });

  test('reduced motion never animates a transform at all', () => {
    for (const phase of ['idle', 'saving', 'done'] as const) {
      expect(savingBarStyle(phase, true).transition).not.toContain('transform');
    }
  });
});
