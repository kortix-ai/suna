/**
 * Audit attribution for an agent-session credential — spec
 * docs/specs/2026-09-22-agents-as-principals.md §2: every row names the agent,
 * the human it acted on behalf of, and the initiator (human | trigger |
 * channel | system).
 */
import { describe, expect, test } from 'bun:test';
import { agentAuditInitiator, agentAuditActorUserId } from './agent-audit-attribution';

const HUMAN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LAUNCHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const session = (overrides: Partial<Parameters<typeof agentAuditInitiator>[0]['session'] & object> = {}) => ({
  origin: 'user' as string | null,
  metadata: {} as Record<string, unknown>,
  createdBy: HUMAN as string | null,
  createdByIsServiceAccount: false,
  ...overrides,
});

describe('agentAuditInitiator', () => {
  test('a human-initiated session: initiator human = on_behalf_of', () => {
    expect(agentAuditInitiator({ onBehalfOfUserId: HUMAN, session: session() })).toEqual({
      type: 'human',
      id: HUMAN,
    });
  });

  test('a trigger run: initiator trigger, named by its slug, never a human', () => {
    const run = session({
      createdBy: SA,
      createdByIsServiceAccount: true,
      metadata: { trigger_kind: 'git', trigger_source: 'manual', trigger_slug: 'nightly' },
    });
    expect(agentAuditInitiator({ onBehalfOfUserId: null, session: run })).toEqual({ type: 'trigger', id: 'nightly' });
    expect(
      agentAuditInitiator({ onBehalfOfUserId: null, session: session({ origin: 'schedule', createdBy: LAUNCHER }) }),
    ).toEqual({ type: 'trigger', id: null });
  });

  test('a channel run: initiator channel, named by the platform', () => {
    expect(
      agentAuditInitiator({ onBehalfOfUserId: null, session: session({ metadata: { source: 'email' }, createdBy: LAUNCHER }) }),
    ).toEqual({ type: 'channel', id: 'email' });
  });

  test('a Slack run with a linked user acts on behalf of that human: initiator human', () => {
    expect(
      agentAuditInitiator({ onBehalfOfUserId: HUMAN, session: session({ metadata: { source: 'slack' } }) }),
    ).toEqual({ type: 'human', id: HUMAN });
  });

  test('a cleared private session keeps its human initiator (the creator)', () => {
    expect(agentAuditInitiator({ onBehalfOfUserId: null, session: session() })).toEqual({ type: 'human', id: HUMAN });
  });

  test('a backend service-account session and an unknown session: system', () => {
    expect(
      agentAuditInitiator({ onBehalfOfUserId: null, session: session({ createdBy: SA, createdByIsServiceAccount: true }) }),
    ).toEqual({ type: 'system', id: SA });
    expect(agentAuditInitiator({ onBehalfOfUserId: null, session: null })).toEqual({ type: 'system', id: null });
  });
});

describe('agentAuditActorUserId', () => {
  test('legacy agent session: the token user, unchanged', () => {
    expect(agentAuditActorUserId({ agentPrincipal: false, tokenUserId: LAUNCHER, onBehalfOfUserId: HUMAN })).toBe(LAUNCHER);
  });
  test('agent principal: the on-behalf-of human, or nobody for an unattended run', () => {
    expect(agentAuditActorUserId({ agentPrincipal: true, tokenUserId: LAUNCHER, onBehalfOfUserId: HUMAN })).toBe(HUMAN);
    expect(agentAuditActorUserId({ agentPrincipal: true, tokenUserId: LAUNCHER, onBehalfOfUserId: null })).toBeNull();
  });
});
