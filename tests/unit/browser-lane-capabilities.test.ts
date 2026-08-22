import { describe, expect, it } from 'vitest';
import {
  assertBrowserLaneCapabilities,
  browserLaneRequirements,
  strictBrowserLane,
} from '../e2e/global-setup';

const emailUp = async () => ({ available: true, reason: 'agentmail' });
const emailDown = async () => ({ available: false, reason: 'AgentMail key rejected (HTTP 403)' });

const fullyConfigured: NodeJS.ProcessEnv = {
  E2E_REQUIRE_ALL_BROWSER: '1',
  KE2E_DATABASE_URL: 'postgres://staging',
  E2E_ENABLE_BILLING_JOURNEY: '1',
  E2E_ENABLE_SANDBOX_TEMPLATE_BUILD: '1',
  E2E_ENABLE_SDK_ONLY_SESSION: '1',
  E2E_OAUTH_PROVIDER_INITIATION: '1',
};

describe('strict browser lane detection', () => {
  it('is on only when local-runner sets E2E_REQUIRE_ALL_BROWSER=1', () => {
    expect(strictBrowserLane({ E2E_REQUIRE_ALL_BROWSER: '1' })).toBe(true);
    expect(strictBrowserLane({ E2E_REQUIRE_ALL_BROWSER: '0' })).toBe(false);
    expect(strictBrowserLane({})).toBe(false);
  });
});

describe('up-front browser capability assertion', () => {
  it('passes a fully configured deployed lane', async () => {
    await expect(
      assertBrowserLaneCapabilities(fullyConfigured, emailUp),
    ).resolves.toBeUndefined();
  });

  it('never blocks a non-strict run, however little is configured', async () => {
    // Local runs are allowed to skip an unavailable optional capability.
    await expect(assertBrowserLaneCapabilities({}, emailDown)).resolves.toBeUndefined();
  });

  it('fails on a rejected email provider and quotes the probe reason', async () => {
    // The exact blip that used to turn the whole lane red ~50 min in.
    await expect(
      assertBrowserLaneCapabilities(fullyConfigured, emailDown),
    ).rejects.toThrow('AgentMail key rejected (HTTP 403)');
  });

  it('fails on a missing database URL and names the specs it would skip', async () => {
    const { KE2E_DATABASE_URL: _drop, ...withoutDb } = fullyConfigured;
    await expect(assertBrowserLaneCapabilities(withoutDb, emailUp)).rejects.toThrow(
      'KE2E_DATABASE_URL',
    );
  });

  it('accepts E2E_DATABASE_URL as the alternate database source', async () => {
    const { KE2E_DATABASE_URL: _drop, ...rest } = fullyConfigured;
    await expect(
      assertBrowserLaneCapabilities({ ...rest, E2E_DATABASE_URL: 'postgres://x' }, emailUp),
    ).resolves.toBeUndefined();
  });

  it('lists every missing capability in one message instead of failing on the first', async () => {
    await expect(assertBrowserLaneCapabilities({ E2E_REQUIRE_ALL_BROWSER: '1' }, emailDown))
      .rejects.toThrow(/6 capability/);
  });

  it('excuses OAuth only where the strict reporter also excuses it', async () => {
    const { E2E_OAUTH_PROVIDER_INITIATION: _drop, ...withoutOauth } = fullyConfigured;
    // Preview: local-runner sets the toggle to 0 and authorises the exclusion.
    await expect(
      assertBrowserLaneCapabilities(
        { ...withoutOauth, E2E_ALLOW_PREVIEW_OAUTH_EXCLUSION: '1' },
        emailUp,
      ),
    ).resolves.toBeUndefined();
    // Staging: no such authorisation, so spec 17 must really run.
    await expect(
      assertBrowserLaneCapabilities(withoutOauth, emailUp),
    ).rejects.toThrow('E2E_OAUTH_PROVIDER_INITIATION=1');
  });

  it('covers every runtime-skipped capability the strict reporter would fail on', () => {
    const names = browserLaneRequirements(fullyConfigured, emailUp).map((r) => r.name);
    expect(names).toEqual([
      'KE2E_DATABASE_URL',
      'email provider',
      'E2E_ENABLE_BILLING_JOURNEY=1',
      'E2E_ENABLE_SANDBOX_TEMPLATE_BUILD=1',
      'E2E_ENABLE_SDK_ONLY_SESSION=1',
      'E2E_OAUTH_PROVIDER_INITIATION=1',
    ]);
  });
});
