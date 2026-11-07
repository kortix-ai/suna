import { describe, expect, test } from 'bun:test';
import { NEW_BOT, actsAsInput, actsAsOptions, keyRowAction, keyStatus, sortKeys } from './workspace-key-acts-as';

const NOW = Date.parse('2026-11-07T00:00:00.000Z');
const key = (over: Record<string, unknown> = {}) => ({
  acts_as: { type: 'me' as const, name: null, service_account_id: null },
  credential: 'token' as const,
  status: 'active',
  revoked_at: null,
  expires_at: '2027-01-01T00:00:00.000Z',
  created_at: '2026-11-01T00:00:00.000Z',
  ...over,
});

describe('Acts as options', () => {
  test('a member picks only You; agent and bot say they need the permission', () => {
    expect(actsAsOptions({ can_manage_principals: false, agents: [{ name: 'a' }] })).toEqual([
      { value: 'me', block: null },
      { value: 'agent', block: 'needs_permission' },
      { value: 'bot', block: 'needs_permission' },
    ]);
  });

  test('a manager with no kortix.yaml agent can pick a bot but no agent', () => {
    expect(actsAsOptions({ can_manage_principals: true, agents: [] }).map((o) => o.block)).toEqual([null, 'no_agents', null]);
  });

  test('a manager with agents picks any of the three; no list yet offers only You', () => {
    expect(actsAsOptions({ can_manage_principals: true, agents: [{ name: 'a' }] }).every((o) => o.block === null)).toBe(true);
    expect(actsAsOptions(undefined).map((o) => o.block)).toEqual([null, 'needs_permission', 'needs_permission']);
  });
});

describe('the request a draft sends', () => {
  const base = { actsAs: 'me' as const, agent: '', bot: '', newBotName: '' };
  test('me, an agent, an existing bot, a new bot', () => {
    expect(actsAsInput(base)).toEqual({ type: 'me' });
    expect(actsAsInput({ ...base, actsAs: 'agent', agent: ' reporter ' })).toEqual({ type: 'agent', agent: 'reporter' });
    expect(actsAsInput({ ...base, actsAs: 'bot', bot: 'bot-1' })).toEqual({ type: 'bot', bot: 'bot-1' });
    expect(actsAsInput({ ...base, actsAs: 'bot', bot: NEW_BOT, newBotName: 'github-actions' })).toEqual({ type: 'bot', bot: 'github-actions' });
  });
  test('an incomplete draft sends nothing', () => {
    expect(actsAsInput({ ...base, actsAs: 'agent' })).toBeNull();
    expect(actsAsInput({ ...base, actsAs: 'bot' })).toBeNull();
    expect(actsAsInput({ ...base, actsAs: 'bot', bot: NEW_BOT, newBotName: '  ' })).toBeNull();
  });
});

describe('a row', () => {
  test('state: revoked wins over expired', () => {
    expect(keyStatus(key(), NOW)).toBe('active');
    expect(keyStatus(key({ expires_at: '2026-10-01T00:00:00.000Z' }), NOW)).toBe('expired');
    expect(keyStatus(key({ status: 'revoked', expires_at: '2026-10-01T00:00:00.000Z' }), NOW)).toBe('revoked');
  });

  test('your own key: revoke, then delete; an agent key: revoke for a manager only; an older bot bearer: delete once revoked', () => {
    expect(keyRowAction(key(), false, NOW)).toBe('revoke');
    expect(keyRowAction(key({ status: 'revoked' }), false, NOW)).toBe('delete');
    const agent = { acts_as: { type: 'agent' as const, name: 'reporter', service_account_id: 'sa' } };
    expect(keyRowAction(key(agent), false, NOW)).toBeNull();
    expect(keyRowAction(key(agent), true, NOW)).toBe('revoke');
    expect(keyRowAction(key({ ...agent, status: 'revoked' }), true, NOW)).toBeNull();
    const bearer = { acts_as: { type: 'bot' as const, name: 'ci', service_account_id: 'sa' }, credential: 'service_account_bearer' as const, status: 'revoked' };
    expect(keyRowAction(key(bearer), true, NOW)).toBe('delete');
  });

  test('active keys first, newest first', () => {
    const rows = [
      key({ created_at: '2026-11-01T00:00:00.000Z', status: 'revoked' }),
      key({ created_at: '2026-10-01T00:00:00.000Z' }),
      key({ created_at: '2026-11-02T00:00:00.000Z' }),
    ];
    expect(sortKeys(rows, NOW).map((r) => r.created_at)).toEqual([
      '2026-11-02T00:00:00.000Z',
      '2026-10-01T00:00:00.000Z',
      '2026-11-01T00:00:00.000Z',
    ]);
  });
});
