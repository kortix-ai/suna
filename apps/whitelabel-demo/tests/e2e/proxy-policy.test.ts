import { describe, expect, test } from 'bun:test';
import { SESSION_CREATE, blockedReason } from '../../src/server/proxy-policy';

const P = 'projects/0b8c9d3e-1111-4222-8333-944455556666';
const S = `${P}/sessions/7a1b2c3d-1111-4222-8333-944455556666`;

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

  test('reads pass, except the ones that hand out a credential', () => {
    expect(blockedReason('GET', `${P}/sessions`)).toBeNull();
    expect(blockedReason('GET', `${P}/secrets`)).toBeNull();
    expect(blockedReason('GET', `${P}/cli-token`)).not.toBeNull();
    expect(blockedReason('GET', `${P}/git-token`)).not.toBeNull();
  });

  test('a new session is allowed (the route tags it and records the thread)', () => {
    expect(blockedReason('POST', `${P}/sessions`)).toBeNull();
    expect(SESSION_CREATE.test(`${P}/sessions`)).toBe(true);
    expect(SESSION_CREATE.test(`${S}/start`)).toBe(false);
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
