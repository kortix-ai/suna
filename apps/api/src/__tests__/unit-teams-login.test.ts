import { describe, expect, mock, test } from 'bun:test';

mock.module('../config', () => ({
  config: {
    MICROSOFT_APP_PASSWORD: 'teams-secret',
    KORTIX_URL: '',
    FRONTEND_URL: 'https://app.kortix.com',
  },
}));

const { signTeamsLoginState, verifyTeamsLoginState, buildTeamsLoginUrl } = await import(
  '../channels/teams/login'
);

describe('teams login token', () => {
  test('round-trips tenant + user + pendingId', () => {
    const token = signTeamsLoginState({ tenantId: 'tenant-1', teamsUserId: 'user-9', pendingId: 'p-3' });
    const payload = verifyTeamsLoginState(token);
    expect(payload?.tenantId).toBe('tenant-1');
    expect(payload?.teamsUserId).toBe('user-9');
    expect(payload?.pendingId).toBe('p-3');
  });

  test('rejects a tampered token', () => {
    const token = signTeamsLoginState({ tenantId: 'tenant-1', teamsUserId: 'user-9' });
    const [body, mac] = token.split('.');
    const forged = `${body}x.${mac}`;
    expect(verifyTeamsLoginState(forged)).toBeNull();
  });

  test('rejects a malformed token', () => {
    expect(verifyTeamsLoginState('not-a-token')).toBeNull();
    expect(verifyTeamsLoginState('')).toBeNull();
  });

  test('builds a web login url with the signed token', () => {
    const url = buildTeamsLoginUrl({ tenantId: 't', teamsUserId: 'u' });
    expect(url.startsWith('https://app.kortix.com/teams/login/')).toBe(true);
    const token = url.split('/teams/login/')[1]!;
    expect(verifyTeamsLoginState(token)?.tenantId).toBe('t');
  });
});
