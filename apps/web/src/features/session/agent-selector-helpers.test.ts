import { describe, expect, test } from 'bun:test';

import type { Agent } from '@/hooks/runtime/use-runtime-sessions';
import {
  agentRowLabel,
  brandLabelHarnesses,
  isHarnessDisconnected,
  withoutRedundantHarnessAgents,
} from './agent-selector-helpers';

function agent(name: string, harness: string, runtime?: string): Agent {
  return { name, harness, runtime: runtime ?? harness } as unknown as Agent;
}

describe('isHarnessDisconnected', () => {
  test('a ready runtime is connected — no dot', () => {
    expect(isHarnessDisconnected('ready')).toBe(false);
  });

  test('a checking runtime is still resolving — no dot yet', () => {
    expect(isHarnessDisconnected('checking')).toBe(false);
  });

  test('missing, ambiguous, needs-attention, and unavailable all count as not connected', () => {
    expect(isHarnessDisconnected('missing')).toBe(true);
    expect(isHarnessDisconnected('ambiguous')).toBe(true);
    expect(isHarnessDisconnected('needs-attention')).toBe(true);
    expect(isHarnessDisconnected('unavailable')).toBe(true);
  });

  test('no runtime entry for the harness (status unknown) never shows a dot', () => {
    expect(isHarnessDisconnected(undefined)).toBe(false);
  });
});

describe('brandLabelHarnesses — the brand label is earned, not assumed', () => {
  test('a harness backing exactly one agent keeps its brand row', () => {
    const brands = brandLabelHarnesses([
      agent('kortix', 'opencode'),
      agent('claude', 'claude'),
      agent('codex', 'codex'),
      agent('pi', 'pi'),
    ]);
    expect([...brands].sort()).toEqual(['claude', 'codex', 'pi']);
  });

  test('a second agent on the same harness revokes it — two rows must never both read "Claude Code"', () => {
    // The project default agent's coding agent switched to Claude Code, so
    // `kortix` and `claude` now share a harness.
    const brands = brandLabelHarnesses([
      agent('kortix', 'claude'),
      agent('claude', 'claude'),
      agent('codex', 'codex'),
      agent('pi', 'pi'),
    ]);
    expect(brands.has('claude')).toBe(false);
    // Untouched harnesses are unaffected.
    expect(brands.has('codex')).toBe(true);
    expect(brands.has('pi')).toBe(true);
  });

  test('opencode never brands — its agents always read as themselves', () => {
    const brands = brandLabelHarnesses([agent('kortix', 'opencode')]);
    expect(brands.has('opencode' as never)).toBe(false);
  });

  test('an agent with no resolvable harness is ignored, never counted', () => {
    const brands = brandLabelHarnesses([
      agent('legacy', 'something-else'),
      agent('claude', 'claude'),
    ]);
    expect(brands.has('claude')).toBe(true);
  });
});

describe('withoutRedundantHarnessAgents — the starter pass-through the default agent absorbed', () => {
  const names = (agents: readonly Agent[]) => agents.map((a) => a.name);

  // The starter manifest as shipped: `kortix` on OpenCode plus one bare
  // pass-through agent per brandable harness.
  const starter = (defaultHarness: string) => [
    agent('kortix', defaultHarness, defaultHarness),
    agent('claude', 'claude'),
    agent('codex', 'codex'),
    agent('pi', 'pi'),
    agent('memory-reflector', 'opencode', 'opencode'),
  ];

  test('the default agent on OpenCode collides with nothing — every row survives', () => {
    const agents = starter('opencode');
    expect(names(withoutRedundantHarnessAgents(agents, { defaultAgentName: 'kortix' }))).toEqual([
      'kortix',
      'claude',
      'codex',
      'pi',
      'memory-reflector',
    ]);
  });

  test('default coding agent switched to Codex drops the now-identical `codex` row', () => {
    const agents = starter('codex');
    expect(names(withoutRedundantHarnessAgents(agents, { defaultAgentName: 'kortix' }))).toEqual([
      'kortix',
      'claude',
      'pi',
      'memory-reflector',
    ]);
  });

  test('…and the surviving row then earns the Codex brand, so the picker reads "Codex" once', () => {
    const agents = withoutRedundantHarnessAgents(starter('codex'), { defaultAgentName: 'kortix' });
    const brands = brandLabelHarnesses(agents);
    const labels = agents.map((a) => agentRowLabel(a, brands).label);
    expect(labels).toEqual(['Codex', 'Claude Code', 'Pi', 'memory-reflector']);
    expect(new Set(labels).size).toBe(labels.length);
  });

  test('same for Claude Code', () => {
    const agents = starter('claude');
    expect(names(withoutRedundantHarnessAgents(agents, { defaultAgentName: 'kortix' }))).toEqual([
      'kortix',
      'codex',
      'pi',
      'memory-reflector',
    ]);
  });

  test('a project-authored agent on the same harness is NOT a pass-through and is kept', () => {
    const agents = [agent('kortix', 'codex', 'codex'), agent('reviewer', 'codex', 'codex')];
    expect(names(withoutRedundantHarnessAgents(agents, { defaultAgentName: 'kortix' }))).toEqual([
      'kortix',
      'reviewer',
    ]);
  });

  test('a pass-through the user is currently ON is never yanked out from under them', () => {
    const agents = starter('codex');
    expect(
      names(
        withoutRedundantHarnessAgents(agents, {
          defaultAgentName: 'kortix',
          keepAgentName: 'codex',
        }),
      ),
    ).toEqual(['kortix', 'claude', 'codex', 'pi', 'memory-reflector']);
  });

  test('a pass-through renamed off the harness id still collapses via its runtime profile', () => {
    const agents = [agent('kortix', 'codex', 'codex'), agent('codex-2', 'codex', 'codex-2')];
    expect(
      names(
        withoutRedundantHarnessAgents([agents[0], { ...agents[1], name: 'codex' } as Agent], {
          defaultAgentName: 'kortix',
        }),
      ),
    ).toEqual(['kortix']);
  });

  test('no default agent declared → nothing is hidden', () => {
    const agents = starter('codex');
    expect(withoutRedundantHarnessAgents(agents, { defaultAgentName: null })).toEqual(agents);
  });

  test('the default agent itself is never dropped, even when it IS the pass-through', () => {
    const agents = [agent('codex', 'codex'), agent('kortix', 'opencode', 'opencode')];
    expect(names(withoutRedundantHarnessAgents(agents, { defaultAgentName: 'codex' }))).toEqual([
      'codex',
      'kortix',
    ]);
  });
});

describe('agentRowLabel', () => {
  test('brands when the harness earned it, otherwise falls back to the agent name', () => {
    const brands = brandLabelHarnesses([agent('claude', 'claude'), agent('kortix', 'opencode')]);
    expect(agentRowLabel(agent('claude', 'claude'), brands)).toEqual({
      label: 'Claude Code',
      isBrand: true,
    });
    expect(agentRowLabel(agent('kortix', 'opencode'), brands)).toEqual({
      label: 'kortix',
      isBrand: false,
    });
  });

  test('two claude agents both read as their own names — the duplicate is gone', () => {
    const agents = [agent('kortix', 'claude'), agent('claude', 'claude')];
    const brands = brandLabelHarnesses(agents);
    const labels = agents.map((a) => agentRowLabel(a, brands).label);
    expect(labels).toEqual(['kortix', 'claude']);
    expect(new Set(labels).size).toBe(labels.length);
  });

  test('no agent at all still renders a stable placeholder', () => {
    expect(agentRowLabel(undefined, new Set())).toEqual({ label: 'Agent', isBrand: false });
  });
});
