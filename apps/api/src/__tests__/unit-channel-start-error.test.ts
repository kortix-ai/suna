import { describe, expect, test } from 'bun:test';

import {
  SLACK_START_ERROR_COMMANDS,
  TEAMS_START_ERROR_COMMANDS,
  startErrorMessage,
} from '../channels/start-error';
import { buildAgentPickerCard } from '../channels/teams/cards';

// Teams used to carry its own four-branch copy of this classifier (402 / 429 /
// 404 / generic). Every error CODE and every 400, 403, 409 and 5xx collapsed
// into "give it a moment and send your message again" — the wrong instruction
// for a dead sandbox template, a missing account link, or a permission gap,
// because retrying can never clear any of them. Slack's classifier is now the
// shared one; these assert Teams gets the same answers, in Teams' vocabulary.
//
// unit-slack-start-error.test.ts still covers the Slack binding end to end.
describe('startErrorMessage, bound to Teams', () => {
  const teams = (status: number | undefined, body: unknown) =>
    startErrorMessage(status, body, TEAMS_START_ERROR_COMMANDS);

  test('400 points at the Teams settings command, never Slack`s', () => {
    const m = teams(400, { error: 'Unknown or disabled sandbox provider: platinum' });
    expect(m).toContain('platinum');
    expect(m).toContain('/status');
    expect(m).not.toContain('/kortix');
  });

  test('404 points at /projects, and calls the surface a conversation', () => {
    const m = teams(404, {});
    expect(m).toContain('/projects');
    expect(m).toContain('conversation');
  });

  test('409 points at /login', () => {
    const m = teams(409, {});
    expect(m).toContain('/login');
  });

  test('403 asks for an admin instead of a retry', () => {
    const m = teams(403, {});
    expect(m.toLowerCase()).toContain('permission');
    expect(m.toLowerCase()).toContain('admin');
    expect(m).not.toContain('Give it a moment');
  });

  test('UNKNOWN_SANDBOX_TEMPLATE beats the 400 status and never says retry', () => {
    const m = teams(400, { code: 'UNKNOWN_SANDBOX_TEMPLATE', error: 'no such template' });
    expect(m.toLowerCase()).toContain('sandbox template');
    expect(m).not.toContain('Give it a moment');
  });

  test('WORKSPACE_MODE_UNAVAILABLE explains the config change, not a login', () => {
    const m = teams(409, { code: 'WORKSPACE_MODE_UNAVAILABLE', error: 'read mode' });
    expect(m).toContain('`runtime` or `branch`');
    expect(m).not.toContain('/login');
  });

  test('402 and 429 keep the copy Teams already shipped', () => {
    expect(teams(402, {}).toLowerCase()).toContain('out of credits');
    expect(teams(429, {}).toLowerCase()).toContain('concurrent-session limit');
  });

  test('5xx reads as temporary, and an unknown status still leaves a next step', () => {
    for (const s of [500, 502, 503, 504]) expect(teams(s, {}).toLowerCase()).toContain('temporary error');
    expect(teams(418, {}).toLowerCase()).toContain('send your message again');
  });

  test('a long internal detail is dropped rather than dumped into the chat', () => {
    const long = 'x'.repeat(400);
    expect(teams(400, { error: long })).not.toContain(long);
  });

  test('an absent status and body never throw', () => {
    expect(() => teams(undefined, undefined)).not.toThrow();
    expect(teams(undefined, undefined).length).toBeGreaterThan(0);
  });

  test('the two platform vocabularies stay distinct', () => {
    expect(SLACK_START_ERROR_COMMANDS.surface).toBe('channel');
    expect(TEAMS_START_ERROR_COMMANDS.surface).toBe('conversation');
    for (const value of Object.values(TEAMS_START_ERROR_COMMANDS)) {
      expect(value).not.toContain('/kortix');
    }
  });
});

// The recovery picker is what makes `AGENT_NOT_DECLARED` escapable: without it
// the conversation's dead agent is re-sent on every retry, forever.
describe('buildAgentPickerCard', () => {
  const agents = [
    { name: 'reviewer', description: 'Reviews pull requests.' },
    { name: 'writer', description: null },
  ];
  const actionsOf = (card: Record<string, unknown>): Array<Record<string, any>> => {
    const found: Array<Record<string, any>> = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      const o = node as Record<string, unknown>;
      if (o.type === 'Action.Execute') found.push(o as Record<string, any>);
      Object.values(o).forEach(walk);
    };
    walk(card);
    return found;
  };

  test('the neutral card marks the conversation`s current agent as in use', () => {
    const card = buildAgentPickerCard({ agents, current: 'reviewer' });
    expect(JSON.stringify(card)).toContain('Currently reviewer');
    const titles = actionsOf(card).map((a) => a.title);
    expect(titles).toContain('✓ In use');
  });

  test('the recovery card names the dead agent and offers only live ones', () => {
    const card = buildAgentPickerCard({
      agents,
      current: 'deleted-agent',
      lead: { title: "Couldn't start — pick an agent", subtitle: 'The agent (deleted-agent) no longer exists.' },
    });
    const json = JSON.stringify(card);
    expect(json).toContain('deleted-agent');
    expect(json).toContain('Pick one, then send your message again.');
    // Nothing is "in use": the current pick is exactly what is broken, so
    // offering it back as the settled choice would be a dead end.
    expect(actionsOf(card).map((a) => a.title)).not.toContain('✓ In use');
    // Every live agent, plus the project default, stays one tap away.
    expect(actionsOf(card).map((a) => a.data.agent).sort()).toEqual(['', 'reviewer', 'writer']);
  });

  test('both moods post the verb interactivity.ts already handles', () => {
    for (const card of [
      buildAgentPickerCard({ agents, current: null }),
      buildAgentPickerCard({ agents, current: null, lead: { title: 't', subtitle: 's' } }),
    ]) {
      const actions = actionsOf(card);
      expect(actions.length).toBeGreaterThan(0);
      for (const a of actions) expect(a.verb).toBe('teams_set_agent');
    }
  });

  test('a project with no declared agents still offers the default', () => {
    const card = buildAgentPickerCard({ agents: [], current: null });
    expect(actionsOf(card).map((a) => a.data.agent)).toEqual(['']);
  });
});
