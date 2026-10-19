import { describe, expect, test } from 'bun:test';
import { SESSION_CREATE, SESSION_ONE, blockedReason, localAnswer } from '../../src/server/proxy-policy';

const P = 'projects/0b8c9d3e-1111-4222-8333-944455556666';
const S = `${P}/sessions/7a1b2c3d-1111-4222-8333-944455556666`;
const member = { userId: 'lumen_user_1' };

describe('proxy policy: what a member token may do', () => {
  test('session writes and runtime calls pass', () => {
    for (const [method, path] of [
      ['POST', `${S}/start`],
      ['POST', `${S}/prompts`],
      ['PATCH', S],
      ['POST', `${P}/attachments`],
      ['POST', `${P}/turn-permission`],
      ['POST', 'p/sbx-1/8000/kortix/runtime/session/abort'],
    ]) {
      expect([method, path, blockedReason(method, path)]).toEqual([method, path, null]);
    }
  });

  test('the reads the session UI makes pass', () => {
    for (const path of [
      P,
      `${P}/detail`,
      `${P}/sessions`,
      `${S}/prompts`,
      `${S}/audit`,
      `${P}/change-requests`,
      `${P}/model-picker`,
      `${P}/connections`,
      `${P}/secrets`,
      'p/sbx-1/8000/kortix/health',
      'p/config',
    ]) {
      expect([path, blockedReason('GET', path)]).toEqual([path, null]);
    }
  });

  test("credentials, the operator's identity and other surfaces are refused on read", () => {
    for (const path of [
      `${P}/cli-token`,
      `${P}/git-token`,
      `${P}/git-credential`,
      `${P}/access`,
      `${P}/members`,
      `${P}/triggers`,
      'accounts',
      'accounts/me',
      'accounts/tokens',
      'accounts/88ff5524-1111-4222-8333-944455556666/iam/members',
      'billing/account-state',
      'user/me',
      'projects',
    ]) {
      expect([path, blockedReason('GET', path)]).not.toEqual([path, null]);
    }
  });

  test('a new session is allowed (the route tags it and records the thread)', () => {
    expect(blockedReason('POST', `${P}/sessions`)).toBeNull();
    expect(SESSION_CREATE.test(`${P}/sessions`)).toBe(true);
    expect(SESSION_CREATE.test(`${S}/start`)).toBe(false);
  });

  test('a session update is routed through the tag filter (patchSession)', () => {
    expect(SESSION_ONE.test(S)).toBe(true);
    expect(SESSION_ONE.test(`${S}/start`)).toBe(false);
  });

  test('warm sessions are refused: they skip the Lumen tags and are shared by every member', () => {
    expect(blockedReason('POST', `${P}/sessions/warm`)).not.toBeNull();
    expect(blockedReason('POST', `${P}/sessions/warm/claim`)).not.toBeNull();
    expect(blockedReason('GET', `${P}/sessions/warm`)).not.toBeNull();
  });

  test('project configuration and deletion are refused', () => {
    for (const [method, path] of [
      ['DELETE', P],
      ['POST', `${P}/cli-token`],
      ['PUT', `${P}/agents/finance-analyst/config`],
      ['PUT', `${P}/default-agent`],
      ['POST', `${P}/secrets`],
      ['POST', `${P}/access`],
      ['POST', `${P}/triggers`],
      ['POST', 'accounts/tokens'],
      ['POST', 'projects/provision'],
    ]) {
      expect(blockedReason(method, path)).not.toBeNull();
    }
  });
});

describe('proxy policy: account reads Lumen answers itself', () => {
  const none = new URLSearchParams();

  test('accounts/me is the Lumen member, not the operator', async () => {
    const res = localAnswer('GET', 'accounts/me', none, null, member);
    expect(await res?.json()).toEqual({ user_id: 'lumen_user_1', email: '', accounts: [] });
  });

  test('permission probes deny every configuration action without calling Kortix', async () => {
    const one = localAnswer(
      'GET',
      'accounts/a/iam/members/u/effective',
      new URLSearchParams({ action: 'project.secret.read', resourceType: 'project', resourceId: 'p1' }),
      null,
      member,
    );
    expect(await one?.json()).toEqual({
      action: 'project.secret.read',
      resource_type: 'project',
      resource_id: 'p1',
      allowed: false,
      reason: 'Managed by the Lumen operator',
    });

    const batch = localAnswer(
      'POST',
      'accounts/a/iam/members/u/effective:batch',
      none,
      { probes: [{ action: 'project.write', resourceType: 'project', resourceId: 'p1' }, { action: 'member.read' }] },
      member,
    );
    const body = (await batch?.json()) as { results: Array<{ action: string; allowed: boolean }> };
    expect(body.results.map((r) => [r.action, r.allowed])).toEqual([
      ['project.write', false],
      ['member.read', false],
    ]);
  });

  test('every other path is left to blockedReason', () => {
    expect(localAnswer('GET', 'accounts/tokens', none, null, member)).toBeNull();
    expect(localAnswer('POST', 'accounts/me', none, null, member)).toBeNull();
    expect(localAnswer('GET', `${S}/prompts`, none, null, member)).toBeNull();
  });
});
