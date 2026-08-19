import { describe, expect, mock, test } from 'bun:test';
import { buildTeamsManifest } from '../channels/teams-manifest';

describe('buildTeamsManifest', () => {
  test('declares the bot with the app id and derives validDomains from the base url', () => {
    const m = buildTeamsManifest({ appId: 'app-123', baseUrl: 'https://api.kortix.com' });
    expect(m.id).toBe('app-123');
    expect(m.bots[0]!.botId).toBe('app-123');
    expect(m.bots[0]!.scopes).toEqual(['personal', 'team', 'groupchat']);
    expect(m.validDomains).toEqual(['api.kortix.com']);
    expect(m.manifestVersion).toBe('1.16');
  });
});

mock.module('../config', () => ({ config: { MICROSOFT_APP_ID: 'app-123', MICROSOFT_APP_PASSWORD: 'secret' } }));
const { teamsMode } = await import('../channels/teams-mode');

describe('teamsMode', () => {
  test('enabled + configured → exposes the messaging endpoint and admin-consent url', () => {
    const mode = teamsMode('https://api.kortix.com/', { enabled: true });
    expect(mode.enabled).toBe(true);
    expect(mode.available).toBe(true);
    expect(mode.appId).toBe('app-123');
    expect(mode.messagingEndpoint).toBe('https://api.kortix.com/v1/webhooks/teams/messages');
    expect(mode.adminConsentUrl).toContain('client_id=app-123');
  });

  test('project has the `teams` experiment off → nothing is exposed even though the server is configured', () => {
    const mode = teamsMode('https://api.kortix.com/', { enabled: false });
    expect(mode.enabled).toBe(false);
    expect(mode.available).toBe(false);
    expect(mode.appId).toBeNull();
    expect(mode.messagingEndpoint).toBeNull();
    expect(mode.adminConsentUrl).toBeNull();
  });

  test('bring-your-own bot routes the webhook at the project and needs no server credentials', () => {
    const mode = teamsMode('https://api.kortix.com/', {
      enabled: true,
      projectId: 'p-1',
      byoAppId: 'byo-app-9',
    });
    expect(mode.byo).toBe(true);
    expect(mode.available).toBe(true);
    expect(mode.appId).toBe('byo-app-9');
    expect(mode.messagingEndpoint).toBe('https://api.kortix.com/v1/webhooks/teams/p-1/messages');
  });
});
