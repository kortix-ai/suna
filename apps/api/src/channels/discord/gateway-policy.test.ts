import { expect, test } from 'bun:test';
import { discordHeartbeatInterval, discordResumeUrl } from './gateway-policy';

test('resume connects only to Discord secure gateway hosts', () => {
  expect(discordResumeUrl('wss://gateway-us-east1-b.discord.gg')).toBe('wss://gateway-us-east1-b.discord.gg');
  for (const value of ['ws://gateway.discord.gg', 'wss://discord.gg.evil.test', 'wss://127.0.0.1', 'wss://evil.test', 'wss://user:pass@gateway.discord.gg', 'wss://gateway.discord.gg:8080', 'not a URL']) {
    expect(discordResumeUrl(value)).toBeNull();
  }
});

test('heartbeat intervals are finite and bounded before scheduling', () => {
  expect(discordHeartbeatInterval(41250)).toBe(41250);
  for (const value of [0, -1, NaN, Infinity, 2147483648, '41250', null, 1]) {
    expect(discordHeartbeatInterval(value)).toBe(41250);
  }
  expect(discordHeartbeatInterval(1000)).toBe(1000);
  expect(discordHeartbeatInterval(120000)).toBe(120000);
});
