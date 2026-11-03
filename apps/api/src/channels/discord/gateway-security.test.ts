import { expect, test } from 'bun:test';
import { gatewayHeartbeatInterval, gatewayResumeUrl } from './gateway';

test('resume destinations stay on the configured Gateway origin', () => {
  const configured = 'wss://gateway.discord.gg';
  expect(gatewayResumeUrl('wss://gateway-us-east1-b.discord.gg', configured)).toBe('wss://gateway-us-east1-b.discord.gg');
  for (const destination of ['ws://127.0.0.1', 'wss://discord.gg.attacker.test', 'wss://gateway.discord.gg@attacker.test', 'wss://gateway.discord.gg:8443', 'not a URL']) {
    expect(gatewayResumeUrl(destination, configured)).toBe(configured);
  }
  expect(gatewayResumeUrl('ws://localhost:13108', 'ws://localhost:13108')).toBe('ws://localhost:13108');
  expect(gatewayResumeUrl('ws://localhost:13109', 'ws://localhost:13108')).toBe('ws://localhost:13108');
});

test('heartbeat intervals cannot overflow timers or create a busy loop', () => {
  expect(gatewayHeartbeatInterval(41_250)).toBe(41_250);
  expect(gatewayHeartbeatInterval(600_000)).toBe(600_000);
  for (const interval of [0, -1, 1, NaN, Infinity, 2 ** 32, '1000', null, undefined]) {
    expect(gatewayHeartbeatInterval(interval)).toBe(41_250);
  }
});

test('a persisted resume URL cannot redirect the bot token to another server', async () => {
  const { config } = await import('../../config');
  const { DiscordGateway } = await import('./gateway');
  const { mock } = await import('bun:test');
  const original = config.DISCORD_GATEWAY_URL;
  const originalToken = config.DISCORD_BOT_TOKEN;
  const originalApp = config.DISCORD_APPLICATION_ID;
  const originalKey = config.DISCORD_PUBLIC_KEY;
  const originalSecret = config.DISCORD_CLIENT_SECRET;
  const sockets: string[] = [];
  const socket = mock(() => { throw new Error('connection recorded'); });
  const OriginalWebSocket = globalThis.WebSocket;
  // Record only destinations; never send a credential or open a connection.
  class RecordingWebSocket extends OriginalWebSocket {
    constructor(url: string | URL) {
      sockets.push(String(url));
      socket();
      super(url);
    }
  }
  config.DISCORD_GATEWAY_URL = 'wss://gateway.discord.gg';
  config.DISCORD_BOT_TOKEN = 'synthetic-test-token';
  config.DISCORD_APPLICATION_ID = 'synthetic-app';
  config.DISCORD_PUBLIC_KEY = 'synthetic-key';
  config.DISCORD_CLIENT_SECRET = 'synthetic-secret';
  globalThis.WebSocket = RecordingWebSocket;
  const client = new DiscordGateway(async () => {}, {
    load: async () => ({ sessionId: 'synthetic-session', resumeUrl: 'ws://127.0.0.1:12345', seq: 1, botUserId: 'synthetic-bot', savedAt: Date.now() }),
    save: async () => {},
  });
  try {
    await client.start();
    expect(sockets).toEqual(['wss://gateway.discord.gg/?v=10&encoding=json']);
  } finally {
    await client.stop();
    config.DISCORD_GATEWAY_URL = original;
    config.DISCORD_BOT_TOKEN = originalToken;
    config.DISCORD_APPLICATION_ID = originalApp;
    config.DISCORD_PUBLIC_KEY = originalKey;
    config.DISCORD_CLIENT_SECRET = originalSecret;
    globalThis.WebSocket = OriginalWebSocket;
  }
});
