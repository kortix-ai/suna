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

mock.module('../config', () => ({ config: { MICROSOFT_APP_ID: 'app-123', MICROSOFT_APP_PASSWORD: 'secret', TEAMS_CHANNEL_ENABLED: true } }));
const { teamsMode } = await import('../channels/teams-mode');

describe('teamsMode', () => {
  test('available → exposes the messaging endpoint and admin-consent url', () => {
    const mode = teamsMode('https://api.kortix.com/');
    expect(mode.available).toBe(true);
    expect(mode.appId).toBe('app-123');
    expect(mode.messagingEndpoint).toBe('https://api.kortix.com/v1/webhooks/teams/messages');
    expect(mode.adminConsentUrl).toContain('client_id=app-123');
  });
});
