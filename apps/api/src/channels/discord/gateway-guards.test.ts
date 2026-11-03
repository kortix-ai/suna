import { describe, expect, test } from 'bun:test';
import { config } from '../../config';
import { heartbeatIntervalMs, trustedResumeUrl } from './gateway';

describe('the Gateway resume URL a session reconnects to', () => {
  test('a Discord Gateway host is kept', () => {
    expect(trustedResumeUrl('wss://gateway-us-east1-b.discord.gg')).toBe('wss://gateway-us-east1-b.discord.gg');
    expect(trustedResumeUrl('wss://gateway.discord.gg/')).toBe('wss://gateway.discord.gg/');
  });

  test('any other host is dropped, so the bot token never goes there', () => {
    expect(trustedResumeUrl('wss://evil.example')).toBeNull();
    expect(trustedResumeUrl('wss://discord.gg.evil.example')).toBeNull();
    expect(trustedResumeUrl('ws://gateway.discord.gg')).toBeNull();
    expect(trustedResumeUrl('http://169.254.169.254/latest')).toBeNull();
    expect(trustedResumeUrl('not a url')).toBeNull();
    expect(trustedResumeUrl(null)).toBeNull();
  });

  test("the configured Gateway's own host is kept (a test double)", () => {
    const configured = new URL(config.DISCORD_GATEWAY_URL);
    expect(trustedResumeUrl(`${configured.protocol}//${configured.host}/resume`)).toBe(`${configured.protocol}//${configured.host}/resume`);
  });
});

describe("HELLO's heartbeat interval", () => {
  test('is bounded to 1 s – 2 min, and a missing or odd value is 41.25 s', () => {
    expect(heartbeatIntervalMs(41_250)).toBe(41_250);
    expect(heartbeatIntervalMs(5)).toBe(1_000);
    expect(heartbeatIntervalMs(9_999_999_999)).toBe(120_000);
    expect(heartbeatIntervalMs(undefined)).toBe(41_250);
    expect(heartbeatIntervalMs('41250')).toBe(41_250);
    expect(heartbeatIntervalMs(Number.NaN)).toBe(41_250);
  });
});
