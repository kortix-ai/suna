/**
 * Who an agent session acts ON BEHALF OF at mint (spec
 * docs/specs/2026-09-22-agents-as-principals.md §2.3): the launching human for
 * a human-initiated session, NULL for every unattended run.
 */
import { describe, expect, test } from 'bun:test';
import { decideSessionOnBehalfOf, promptClearsOnBehalfOf } from './on-behalf-of';

const HUMAN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const base = {
  userId: HUMAN,
  origin: 'user',
  metadata: {} as Record<string, unknown>,
  isAccountMember: true,
  parentOnBehalfOf: undefined as string | null | undefined,
  slackRequiresUserIdentity: true,
  teamsRequiresUserIdentity: true,
};

describe('decideSessionOnBehalfOf', () => {
  test('a human-initiated session acts on behalf of its launcher', () => {
    expect(decideSessionOnBehalfOf(base)).toBe(HUMAN);
  });

  test('trigger, schedule and system origins have no human', () => {
    for (const origin of ['trigger', 'schedule', 'system']) {
      expect(decideSessionOnBehalfOf({ ...base, origin })).toBeNull();
    }
  });

  test('a session stamped by a trigger fire (manual included) has no human', () => {
    expect(decideSessionOnBehalfOf({ ...base, metadata: { trigger_kind: 'git', trigger_source: 'manual' } })).toBeNull();
    expect(decideSessionOnBehalfOf({ ...base, metadata: { trigger_slug: 'nightly' } })).toBeNull();
  });

  test('email and Telegram sessions run as the account owner stand-in: no human', () => {
    expect(decideSessionOnBehalfOf({ ...base, metadata: { source: 'email' } })).toBeNull();
    expect(decideSessionOnBehalfOf({ ...base, metadata: { source: 'telegram' } })).toBeNull();
  });

  test('Slack and Teams: the linked human when identity is required, no human otherwise', () => {
    expect(decideSessionOnBehalfOf({ ...base, metadata: { source: 'slack' } })).toBe(HUMAN);
    expect(decideSessionOnBehalfOf({ ...base, metadata: { source: 'slack' }, slackRequiresUserIdentity: false })).toBeNull();
    expect(decideSessionOnBehalfOf({ ...base, metadata: { source: 'teams' } })).toBe(HUMAN);
    expect(decideSessionOnBehalfOf({ ...base, metadata: { source: 'teams' }, teamsRequiresUserIdentity: false })).toBeNull();
  });

  test('a principal that is not an account member (a service account) is never on behalf of', () => {
    expect(decideSessionOnBehalfOf({ ...base, origin: 'backend', isAccountMember: false })).toBeNull();
  });

  test('a human PAT (backend origin) still acts on behalf of that human', () => {
    expect(decideSessionOnBehalfOf({ ...base, origin: 'backend' })).toBe(HUMAN);
  });

  test('a child session inherits the parent session value, never the token user', () => {
    const child = { ...base, metadata: { spawned_by_session: 'parent' } };
    expect(decideSessionOnBehalfOf({ ...child, parentOnBehalfOf: null })).toBeNull();
    expect(decideSessionOnBehalfOf({ ...child, parentOnBehalfOf: HUMAN })).toBe(HUMAN);
    // Parent token missing → fail closed.
    expect(decideSessionOnBehalfOf({ ...child, parentOnBehalfOf: undefined })).toBeNull();
  });

  test('a value cleared by another human prompt is never restored by a re-mint', () => {
    expect(decideSessionOnBehalfOf({ ...base, metadata: { on_behalf_of_cleared_at: '2026-09-22T00:00:00Z' } })).toBeNull();
  });
});

describe('promptClearsOnBehalfOf', () => {
  test('a prompt from a human other than on_behalf_of clears it', () => {
    expect(promptClearsOnBehalfOf({ onBehalfOfUserId: HUMAN, prompterUserId: OTHER, prompterIsHuman: true })).toBe(true);
  });
  test('the same human, an unset value, or a non-human prompter does not', () => {
    expect(promptClearsOnBehalfOf({ onBehalfOfUserId: HUMAN, prompterUserId: HUMAN, prompterIsHuman: true })).toBe(false);
    expect(promptClearsOnBehalfOf({ onBehalfOfUserId: null, prompterUserId: OTHER, prompterIsHuman: true })).toBe(false);
    expect(promptClearsOnBehalfOf({ onBehalfOfUserId: HUMAN, prompterUserId: OTHER, prompterIsHuman: false })).toBe(false);
  });
});
