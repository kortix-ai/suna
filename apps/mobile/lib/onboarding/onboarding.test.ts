import { describe, expect, test } from 'bun:test';

import type { KortixAccount } from '@/lib/projects/projects-client';
import { markComposerFocus, takeComposerFocus } from './composer-handoff';
import { onboardingAccountId, startDestination, welcomeOffer } from './onboarding';

function account(account_id: string, account_role: string): KortixAccount {
  return { account_id, account_role } as KortixAccount;
}

const owned = account('acc-owned', 'owner');
const admin = account('acc-admin', 'admin');
const member = account('acc-member', 'member');

describe('startDestination', () => {
  const project = { kind: 'project', projectId: 'p1', accountId: 'acc-owned' } as const;

  test('a user with a project opens it, whether or not the upgrade screen was seen', () => {
    expect(startDestination(project, false)).toEqual(project);
    expect(startDestination(project, true)).toEqual(project);
  });

  test('no project anywhere and the upgrade screen unseen: the upgrade screen', () => {
    expect(startDestination({ kind: 'empty' }, false)).toEqual({ kind: 'welcome' });
  });

  test('no project anywhere and the upgrade screen seen: /new, never an empty list', () => {
    expect(startDestination({ kind: 'empty' }, true)).toEqual({ kind: 'new' });
  });

  // KRTX-1731: a project invite stays pending until it is accepted (the
  // account list claims only workspace invites), so the door opens it first —
  // web `decideDoor` shows the selector for a pending invite.
  const invites = [{ invite_id: 'inv-1' }, { invite_id: 'inv-2' }];

  test('a pending invite opens before a project, the upgrade screen, or /new', () => {
    expect(startDestination(project, true, invites)).toEqual({ kind: 'invite', inviteId: 'inv-1' });
    expect(startDestination({ kind: 'empty' }, false, invites)).toEqual({ kind: 'invite', inviteId: 'inv-1' });
    expect(startDestination({ kind: 'empty' }, true, invites)).toEqual({ kind: 'invite', inviteId: 'inv-1' });
  });

  test('an invite put off with Not now is passed over', () => {
    expect(startDestination(project, true, invites, new Set(['inv-1']))).toEqual({
      kind: 'invite',
      inviteId: 'inv-2',
    });
    expect(startDestination(project, true, invites, new Set(['inv-1', 'inv-2']))).toEqual(project);
    expect(startDestination({ kind: 'empty' }, true, invites, new Set(['inv-1', 'inv-2']))).toEqual({
      kind: 'new',
    });
  });

  test('no pending invite: the destination is unchanged', () => {
    expect(startDestination(project, false, [])).toEqual(project);
    expect(startDestination({ kind: 'empty' }, false, [])).toEqual({ kind: 'welcome' });
  });
});

describe('onboardingAccountId', () => {
  const can = { 'acc-owned': true, 'acc-admin': true };
  test('keeps the selected account when a project can be created in it', () => {
    expect(onboardingAccountId([owned, admin], 'acc-admin', can)).toBe('acc-admin');
  });

  test('a member-only selection moves to the first owned or admin account', () => {
    expect(onboardingAccountId([member, admin, owned], 'acc-member', can)).toBe('acc-admin');
  });

  test('no selection: the first owned or admin account', () => {
    expect(onboardingAccountId([member, owned], null, can)).toBe('acc-owned');
  });

  test('member-only accounts: the selected one, else the first', () => {
    expect(onboardingAccountId([member, account('acc-m2', 'member')], 'acc-m2', {})).toBe('acc-m2');
    expect(onboardingAccountId([member], 'gone', {})).toBe('acc-member');
  });

  test('no verdict yet: no account counts as creatable', () => {
    expect(onboardingAccountId([owned, admin], 'gone', {})).toBe('acc-owned');
  });

  test('no account: null', () => {
    expect(onboardingAccountId([], 'gone', {})).toBeNull();
  });
});

describe('welcomeOffer', () => {
  const base = { family: 'free' as const, canManageBilling: true };

  test('iOS: benefits and Continue with Free only — no purchase action, no price', () => {
    const offer = welcomeOffer({ ...base, os: 'ios' });
    expect(offer.action).toBe('none');
    expect(offer.benefits.join(' ')).not.toContain('$');
  });

  test('iOS: no purchase action even for a user who cannot manage billing', () => {
    expect(welcomeOffer({ ...base, os: 'ios', canManageBilling: false }).action).toBe('none');
  });

  test('Android: Upgrade opens web billing, and the first benefit names the shared credit pool', () => {
    const offer = welcomeOffer({ ...base, os: 'android' });
    expect(offer.action).toBe('upgrade');
    expect(offer.benefits[0]).toBe('Unlimited members, one shared credit pool');
  });

  test('Android: a user who cannot manage billing is asked to go to an owner', () => {
    expect(welcomeOffer({ ...base, os: 'android', canManageBilling: false }).action).toBe('ask-owner');
  });

  test('four benefit lines, from the upgrade sheet list', () => {
    expect(welcomeOffer({ ...base, os: 'android' }).benefits).toHaveLength(4);
  });

  test('shown only on the Free plan', () => {
    expect(welcomeOffer({ ...base, os: 'android' }).show).toBe(true);
    expect(welcomeOffer({ ...base, os: 'android', family: 'credits' }).show).toBe(false);
    expect(welcomeOffer({ ...base, os: 'ios', family: 'enterprise' }).show).toBe(false);
  });
});

describe('composer focus hand-off', () => {
  test('true once after a mark, then false', () => {
    markComposerFocus('p1');
    expect(takeComposerFocus('p1')).toBe(true);
    expect(takeComposerFocus('p1')).toBe(false);
  });

  test('a project that was never marked is not focused', () => {
    markComposerFocus('p1');
    expect(takeComposerFocus('p2')).toBe(false);
    expect(takeComposerFocus('p1')).toBe(true);
  });
});
