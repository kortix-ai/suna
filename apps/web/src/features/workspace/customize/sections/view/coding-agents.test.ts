import type { RuntimeProfile } from '@kortix/sdk/projects-client';
import { describe, expect, test } from 'bun:test';

import {
  buildCodingAgentRows,
  disableCodingAgent,
  enableCodingAgent,
  removalLosesCustomSetup,
  toggleBlockedReason,
} from './coding-agents';

const rowFor = (rows: ReturnType<typeof buildCodingAgentRows>, harness: string) =>
  rows.find((r) => r.harness === harness)!;

describe('buildCodingAgentRows', () => {
  test('always returns all four harnesses so a turned-off one is still reachable', () => {
    const rows = buildCodingAgentRows({ runtimes: {}, agents: [], defaultAgentName: null });
    expect(rows.map((r) => r.harness)).toEqual(['claude', 'codex', 'opencode', 'pi']);
    expect(rows.every((r) => !r.enabled && r.profileName === null)).toBe(true);
  });

  test('a declared profile turns its row on and exposes the name agents must point at', () => {
    const rows = buildCodingAgentRows({
      runtimes: { claude: { harness: 'claude' } },
      agents: [],
      defaultAgentName: null,
    });
    expect(rowFor(rows, 'claude').enabled).toBe(true);
    expect(rowFor(rows, 'claude').profileName).toBe('claude');
    expect(rowFor(rows, 'codex').enabled).toBe(false);
  });

  test('a legacy slug name still reads as its brand row, with the slug kept for writes', () => {
    // Projects created before this UI have names like `runtime-1` — the row is
    // still "OpenCode", but an agent's `runtime` must be set to `runtime-1`.
    const rows = buildCodingAgentRows({
      runtimes: { 'runtime-1': { harness: 'opencode' } },
      agents: [],
      defaultAgentName: null,
    });
    expect(rowFor(rows, 'opencode').enabled).toBe(true);
    expect(rowFor(rows, 'opencode').profileName).toBe('runtime-1');
  });

  test('two profiles on one harness collapse to one row, extras listed for Advanced', () => {
    const rows = buildCodingAgentRows({
      runtimes: {
        opencode: { harness: 'opencode' },
        'opencode-alt': { harness: 'opencode', config_dir: '.alt' },
      },
      agents: [],
      defaultAgentName: null,
    });
    const row = rowFor(rows, 'opencode');
    expect(row.profileName).toBe('opencode');
    expect(row.extraProfileNames).toEqual(['opencode-alt']);
  });

  test('usedBy resolves through the profile name, not the harness label', () => {
    const rows = buildCodingAgentRows({
      runtimes: { 'runtime-1': { harness: 'opencode' }, claude: { harness: 'claude' } },
      agents: [
        { name: 'kortix', runtime: 'runtime-1', harness: 'opencode' },
        { name: 'reviewer', runtime: 'claude', harness: 'claude' },
      ],
      defaultAgentName: null,
    });
    expect(rowFor(rows, 'opencode').usedBy).toEqual(['kortix']);
    expect(rowFor(rows, 'claude').usedBy).toEqual(['reviewer']);
  });

  test('an agent with no declared profile still counts against its resolved harness', () => {
    // Runtime-discovered agents aren't in `agents:` so nothing would 400 on
    // removal — but they'd stop working, so they must still lock the toggle.
    const rows = buildCodingAgentRows({
      runtimes: { opencode: { harness: 'opencode' } },
      agents: [{ name: 'legacy', harness: 'opencode' }],
      defaultAgentName: null,
    });
    expect(rowFor(rows, 'opencode').usedBy).toEqual(['legacy']);
  });

  test('isDefault marks the harness the project default agent runs on', () => {
    const rows = buildCodingAgentRows({
      runtimes: { claude: { harness: 'claude' }, opencode: { harness: 'opencode' } },
      agents: [
        { name: 'kortix', runtime: 'opencode', harness: 'opencode' },
        { name: 'reviewer', runtime: 'claude', harness: 'claude' },
      ],
      defaultAgentName: 'reviewer',
    });
    expect(rowFor(rows, 'claude').isDefault).toBe(true);
    expect(rowFor(rows, 'opencode').isDefault).toBe(false);
  });

  test('an unknown default agent name marks nothing as default', () => {
    const rows = buildCodingAgentRows({
      runtimes: { claude: { harness: 'claude' } },
      agents: [{ name: 'reviewer', runtime: 'claude', harness: 'claude' }],
      defaultAgentName: 'deleted-agent',
    });
    expect(rows.some((r) => r.isDefault)).toBe(false);
  });
});

describe('enableCodingAgent', () => {
  test('names the profile after the harness and seeds its default config folder', () => {
    expect(enableCodingAgent({}, 'codex')).toEqual({
      codex: { harness: 'codex', config_dir: '.codex' },
    });
  });

  test('is a no-op when the harness is already available under any name', () => {
    const runtimes: Record<string, RuntimeProfile> = { 'runtime-1': { harness: 'opencode' } };
    expect(enableCodingAgent(runtimes, 'opencode')).toBe(runtimes);
  });

  test('suffixes around a name already taken by a different harness', () => {
    const runtimes: Record<string, RuntimeProfile> = { codex: { harness: 'opencode' } };
    expect(enableCodingAgent(runtimes, 'codex')).toEqual({
      codex: { harness: 'opencode' },
      'codex-2': { harness: 'codex', config_dir: '.codex' },
    });
  });
});

describe('disableCodingAgent', () => {
  test('drops every profile on that harness and leaves the rest untouched', () => {
    expect(
      disableCodingAgent(
        {
          opencode: { harness: 'opencode' },
          'opencode-alt': { harness: 'opencode' },
          claude: { harness: 'claude' },
        },
        'opencode',
      ),
    ).toEqual({ claude: { harness: 'claude' } });
  });
});

describe('toggleBlockedReason', () => {
  const rows = (runtimes: Record<string, RuntimeProfile>, agents: any[] = []) =>
    buildCodingAgentRows({ runtimes, agents, defaultAgentName: null });

  test('an off row is never blocked — turning one on is always allowed', () => {
    const r = rows({ claude: { harness: 'claude' } });
    expect(toggleBlockedReason(rowFor(r, 'codex'), r)).toBeNull();
  });

  test('one agent in use names it and reads in the singular', () => {
    const r = rows({ claude: { harness: 'claude' }, codex: { harness: 'codex' } }, [
      { name: 'reviewer', runtime: 'claude', harness: 'claude' },
    ]);
    expect(toggleBlockedReason(rowFor(r, 'claude'), r)).toBe(
      'reviewer runs on Claude Code. Move it to another coding agent first.',
    );
  });

  test('several agents in use collapse to a count and read in the plural', () => {
    const r = rows({ claude: { harness: 'claude' }, codex: { harness: 'codex' } }, [
      { name: 'reviewer', runtime: 'claude', harness: 'claude' },
      { name: 'writer', runtime: 'claude', harness: 'claude' },
      { name: 'fixer', runtime: 'claude', harness: 'claude' },
    ]);
    expect(toggleBlockedReason(rowFor(r, 'claude'), r)).toBe(
      'reviewer and 2 more run on Claude Code. Move them to another coding agent first.',
    );
  });

  test('the last remaining coding agent cannot be turned off', () => {
    const r = rows({ claude: { harness: 'claude' } });
    expect(toggleBlockedReason(rowFor(r, 'claude'), r)).toBe(
      'This is the only coding agent left. Turn another one on first.',
    );
  });

  test('an unused row with a sibling available is free to turn off', () => {
    const r = rows({ claude: { harness: 'claude' }, codex: { harness: 'codex' } });
    expect(toggleBlockedReason(rowFor(r, 'codex'), r)).toBeNull();
  });
});

describe('removalLosesCustomSetup', () => {
  test('a plain harness-named profile is disposable — no confirm needed', () => {
    expect(removalLosesCustomSetup({ claude: { harness: 'claude' } }, 'claude')).toBe(false);
  });

  test('the default config folder written out explicitly still counts as plain', () => {
    expect(
      removalLosesCustomSetup({ claude: { harness: 'claude', config_dir: '.claude' } }, 'claude'),
    ).toBe(false);
  });

  test('a hand-edited config folder is real work — worth confirming before dropping', () => {
    expect(
      removalLosesCustomSetup({ claude: { harness: 'claude', config_dir: '.custom' } }, 'claude'),
    ).toBe(true);
  });

  test('a renamed profile is real work too', () => {
    expect(removalLosesCustomSetup({ 'my-claude': { harness: 'claude' } }, 'claude')).toBe(true);
  });
});
