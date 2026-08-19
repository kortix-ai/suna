import { describe, expect, test } from 'bun:test';
import type { Agent } from '@kortix/sdk/react';

import {
  composerSelectableAgents,
  NO_AGENT_ACCESS_HINT,
  NO_AGENT_ACCESS_LABEL,
  resolveComposerAgent,
} from './composer-agent-access';

/**
 * Project agents are deny-by-default for a project `member`: the roster the API
 * returns only holds agents an `iam_resource_grant` names them on. Three states
 * follow from that, and the composer used to render the first two identically
 * to "everything is fine" — no agent in the picker, a live send button, and a
 * prompt that ran under the server's manifest `default_agent` (or 403'd).
 *
 * Asserted on the resolver rather than through a mounted composer: it is the
 * one place all three states are decided, and a pure function needs no DOM, no
 * query client and no network to pin.
 */

function agent(name: string, extra: Partial<Agent> = {}): Agent {
  return { name, mode: 'primary', ...extra } as unknown as Agent;
}

describe('resolveComposerAgent — zero accessible agents', () => {
  test('an empty roster disables the composer and selects nothing', () => {
    const resolved = resolveComposerAgent({ agents: [], defaultAgent: 'kortix' });

    expect(resolved).toEqual({ selected: null, disabled: true, reason: 'no_access' });
  });

  test('a project default that is not accessible does not sneak through as the value', () => {
    // The exact silent-fallback bug: the picker showed nothing, the send stayed
    // live, and the server ran `default_agent` nobody chose.
    const resolved = resolveComposerAgent({
      agents: [],
      defaultAgent: 'kortix',
      selectedAgent: 'kortix',
    });

    expect(resolved.selected).toBeNull();
    expect(resolved.disabled).toBe(true);
  });

  test('a roster of nothing but subagents is an empty roster', () => {
    // Subagents are dispatched BY an agent and never offered in the picker, so
    // holding one is not "you have an agent to run".
    const resolved = resolveComposerAgent({
      agents: [agent('reviewer', { mode: 'subagent' }), agent('ghost', { hidden: true })],
    });

    expect(resolved).toEqual({ selected: null, disabled: true, reason: 'no_access' });
  });

  test('the refusal copy is fixed, so the picker and the send button say the same thing', () => {
    expect(NO_AGENT_ACCESS_LABEL).toBe('No agents available to you');
    expect(NO_AGENT_ACCESS_HINT).toBe('Ask a manager for access');
  });
});

describe('resolveComposerAgent — the default is not accessible', () => {
  test('the single accessible agent is pre-selected and the composer stays live', () => {
    // A member granted ONE non-default agent: that agent is what runs, so that
    // agent is what the picker shows and what the send carries.
    const resolved = resolveComposerAgent({
      agents: [agent('support')],
      defaultAgent: 'kortix',
    });

    expect(resolved).toEqual({ selected: 'support', disabled: false, reason: 'first_accessible' });
  });

  test('a stale pick that is no longer accessible falls to the first grant, never to blank', () => {
    const resolved = resolveComposerAgent({
      agents: [agent('support'), agent('billing')],
      defaultAgent: 'kortix',
      selectedAgent: 'kortix',
    });

    expect(resolved.selected).toBe('support');
    expect(resolved.disabled).toBe(false);
  });

  test('the first grant skips hidden agents and subagents', () => {
    const resolved = resolveComposerAgent({
      agents: [
        agent('ghost', { hidden: true }),
        agent('reviewer', { mode: 'subagent' }),
        agent('support'),
      ],
      defaultAgent: 'kortix',
    });

    expect(resolved.selected).toBe('support');
  });
});

describe('resolveComposerAgent — the default is accessible', () => {
  test('the project default is the selected value', () => {
    const resolved = resolveComposerAgent({
      agents: [agent('support'), agent('kortix')],
      defaultAgent: 'kortix',
    });

    expect(resolved).toEqual({ selected: 'kortix', disabled: false, reason: 'default' });
  });

  test('whitespace around a declared default still matches', () => {
    const resolved = resolveComposerAgent({
      agents: [agent('kortix')],
      defaultAgent: '  kortix  ',
    });

    expect(resolved.selected).toBe('kortix');
  });

  test("an explicit pick outranks the default — switching agents still works", () => {
    const resolved = resolveComposerAgent({
      agents: [agent('kortix'), agent('support')],
      defaultAgent: 'kortix',
      selectedAgent: 'support',
    });

    expect(resolved).toEqual({ selected: 'support', disabled: false, reason: 'selected' });
  });
});

describe('resolveComposerAgent — the roster has not loaded', () => {
  test('a pending query refuses nothing', () => {
    // Disabling the composer on every cold mount reads as broken, and the
    // roster is `undefined` for exactly as long as the request is in flight.
    const resolved = resolveComposerAgent({ agents: undefined, defaultAgent: 'kortix' });

    expect(resolved.disabled).toBe(false);
    expect(resolved.reason).toBe('loading');
  });

  test('a pending query keeps whatever was already selected', () => {
    const resolved = resolveComposerAgent({ agents: undefined, selectedAgent: 'support' });

    expect(resolved.selected).toBe('support');
  });
});

describe('composerSelectableAgents', () => {
  test('keeps only visible primary agents', () => {
    const kept = composerSelectableAgents([
      agent('kortix'),
      agent('ghost', { hidden: true }),
      agent('reviewer', { mode: 'subagent' }),
    ]);

    expect(kept.map((a) => a.name)).toEqual(['kortix']);
  });

  test('a missing roster is not a crash', () => {
    expect(composerSelectableAgents(undefined)).toEqual([]);
  });
});
