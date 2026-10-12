import { describe, expect, test } from 'bun:test';

import { inviteIdFromUrl, inviteLanding, rememberInviteLink, takeInviteLink } from './invite-landing';

const ID = '3f2b8c1e-9a4d-4e6f-8b2a-1c5d7e9f0a3b';

describe('inviteLanding — where an accepted invite lands', () => {
  test('a project invite opens the first project it granted', () => {
    expect(
      inviteLanding({ account_id: 'acc-b', bootstrap_grants_applied: [{ project_id: 'p1' }, { project_id: 'p2' }] })
    ).toEqual({ kind: 'project', projectId: 'p1', accountId: 'acc-b' });
  });

  test('no grant applied (an admin invite): the first project the invite names', () => {
    expect(
      inviteLanding(
        { account_id: 'acc-b', bootstrap_grants_applied: [] },
        { projects: [{ project_id: 'p9' }] }
      )
    ).toEqual({ kind: 'project', projectId: 'p9', accountId: 'acc-b' });
  });

  test('an invite accepted before: the project the description names', () => {
    expect(inviteLanding({ account_id: 'acc-b' }, { projects: [{ project_id: 'p9' }] })).toEqual({
      kind: 'project',
      projectId: 'p9',
      accountId: 'acc-b',
    });
  });

  test('a granted project wins over the described one', () => {
    expect(
      inviteLanding(
        { account_id: 'acc-b', bootstrap_grants_applied: [{ project_id: 'p1' }] },
        { projects: [{ project_id: 'p9' }] }
      )
    ).toEqual({ kind: 'project', projectId: 'p1', accountId: 'acc-b' });
  });

  test('a workspace invite opens the joined account', () => {
    expect(inviteLanding({ account_id: 'acc-b', bootstrap_grants_applied: [] }, { projects: [] })).toEqual({
      kind: 'account',
      accountId: 'acc-b',
    });
    expect(inviteLanding({ account_id: 'acc-b' })).toEqual({ kind: 'account', accountId: 'acc-b' });
  });
});

describe('inviteIdFromUrl — the invite links the app reads', () => {
  test('the web invite link on every Kortix host', () => {
    expect(inviteIdFromUrl(`https://kortix.com/invites/${ID}`)).toBe(ID);
    expect(inviteIdFromUrl(`https://www.kortix.com/invites/${ID}`)).toBe(ID);
    expect(inviteIdFromUrl(`https://staging.kortix.com/invites/${ID}`)).toBe(ID);
    expect(inviteIdFromUrl(`https://Kortix.com/invites/${ID}?utm=mail#top`)).toBe(ID);
  });

  test('both forms of the app scheme', () => {
    expect(inviteIdFromUrl(`kortix://invites/${ID}`)).toBe(ID);
    expect(inviteIdFromUrl(`kortix:///invites/${ID}`)).toBe(ID);
  });

  test('an upper-case id comes back in lower case', () => {
    expect(inviteIdFromUrl(`kortix://invites/${ID.toUpperCase()}`)).toBe(ID);
  });

  test('not an invite link: null', () => {
    expect(inviteIdFromUrl(`https://evil.com/invites/${ID}`)).toBeNull();
    expect(inviteIdFromUrl(`https://kortix.com.evil.com/invites/${ID}`)).toBeNull();
    expect(inviteIdFromUrl(`http://kortix.com/invites/${ID}`)).toBeNull();
    expect(inviteIdFromUrl(`exp://127.0.0.1:8081/--/invites/${ID}`)).toBeNull();
    expect(inviteIdFromUrl('https://kortix.com/invites/')).toBeNull();
    expect(inviteIdFromUrl('kortix://invites')).toBeNull();
    expect(inviteIdFromUrl('https://kortix.com/invites/not-a-uuid')).toBeNull();
    expect(inviteIdFromUrl(`https://kortix.com/invites/${ID}/x`)).toBeNull();
    expect(inviteIdFromUrl(`https://kortix.com/share/${ID}`)).toBeNull();
    expect(inviteIdFromUrl(`/invites/${ID}`)).toBeNull();
    expect(inviteIdFromUrl('')).toBeNull();
  });
});

describe('the remembered invite link', () => {
  test('is taken once', () => {
    rememberInviteLink(ID);
    expect(takeInviteLink()).toBe(ID);
    expect(takeInviteLink()).toBeNull();
  });

  test('the newest link wins', () => {
    rememberInviteLink('a');
    rememberInviteLink(ID);
    expect(takeInviteLink()).toBe(ID);
  });
});
