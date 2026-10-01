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

  test('requests RSC for channels AND group chats so thread replies reach the bot without a mention', () => {
    const m = buildTeamsManifest({ appId: 'app-123', baseUrl: 'https://api.kortix.com' });
    expect(m.webApplicationInfo).toEqual({ id: 'app-123', resource: 'https://RscBasedStoreApp' });
    expect(m.authorization.permissions.resourceSpecific).toEqual([
      { name: 'ChannelMessage.Read.Group', type: 'Application' },
      // Without this a group-chat reply needs an @-mention every time.
      { name: 'ChatMessage.Read.Chat', type: 'Application' },
    ]);
    // A manifest that changes shape must bump so the catalog takes the upgrade.
    expect(m.version).not.toBe('1.0.0');
    expect(m.version).not.toBe('1.2.0');
  });

  test('the command menu offers /policy', () => {
    const m = buildTeamsManifest({ appId: 'app-123', baseUrl: 'https://api.kortix.com' });
    const titles = m.bots[0]!.commandLists![0]!.commands.map((c) => c.title);
    expect(titles).toContain('/policy');
    // Teams' own command menu is where a user looks for the lever that ends a
    // run; the live card's Stop button is gone as soon as the card scrolls.
    expect(titles).toContain('/stop');
    // A chat is one conversation for life; the menu is where a user looks for
    // a clean slate.
    expect(titles).toContain('/new');
  });

  test('a new command in the menu ships under a new version, so the catalog takes it', () => {
    const m = buildTeamsManifest({ appId: 'app-123', baseUrl: 'https://api.kortix.com' });
    // 1.3.0 is the manifest without /new.
    expect(m.version).not.toBe('1.3.0');
    // 1.4.0 is the manifest without /sessions; 1.5.0 the one without "Open in Kortix".
    expect(m.version).not.toBe('1.4.0');
    expect(m.version).not.toBe('1.5.0');
  });

  test('a message\'s ⋯ menu offers "Open in Kortix", answered by the message-action handler', async () => {
    const { OPEN_IN_KORTIX_COMMAND } = await import('../channels/teams/message-action');
    const m = buildTeamsManifest({ appId: 'app-123', baseUrl: 'https://api.kortix.com' });
    expect(m.composeExtensions).toEqual([{
      botId: 'app-123',
      commands: [expect.objectContaining({ id: OPEN_IN_KORTIX_COMMAND, type: 'action', context: ['message'], fetchTask: true, title: 'Open in Kortix' })],
    }]);
  });

  test('the command menu offers /sessions, within Teams\' 10-command limit', () => {
    const m = buildTeamsManifest({ appId: 'app-123', baseUrl: 'https://api.kortix.com' });
    const commands = m.bots[0]!.commandLists![0]!.commands;
    expect(commands.map((c) => c.title)).toContain('/sessions');
    expect(commands.length).toBeLessThanOrEqual(10);
  });
});

mock.module('../config', () => ({ config: { MICROSOFT_APP_ID: 'app-123', MICROSOFT_APP_PASSWORD: 'secret' } }));
const { teamsMode } = await import('../channels/teams-mode');

describe('teamsMode', () => {
  test('configured → exposes the messaging endpoint and admin-consent url', () => {
    const mode = teamsMode('https://api.kortix.com/', {});
    expect(mode.enabled).toBe(true);
    expect(mode.available).toBe(true);
    expect(mode.appId).toBe('app-123');
    expect(mode.messagingEndpoint).toBe('https://api.kortix.com/v1/webhooks/teams/messages');
    expect(mode.adminConsentUrl).toContain('client_id=app-123');
  });

  test('every project has Teams: a stored `teams: false` from the flag era changes nothing', () => {
    // The `teams` feature flag graduated; teamsMode no longer takes a switch.
    const mode = teamsMode('https://api.kortix.com/', { projectId: 'p-1' });
    expect(mode.enabled).toBe(true);
    expect(mode.available).toBe(true);
  });

  test('bring-your-own bot routes the webhook at the project and needs no server credentials', () => {
    const mode = teamsMode('https://api.kortix.com/', {
      projectId: 'p-1',
      byoAppId: 'byo-app-9',
    });
    expect(mode.byo).toBe(true);
    expect(mode.available).toBe(true);
    expect(mode.appId).toBe('byo-app-9');
    expect(mode.messagingEndpoint).toBe('https://api.kortix.com/v1/webhooks/teams/p-1/messages');
  });
});
