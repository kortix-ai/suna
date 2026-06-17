import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  buildSlackManifest,
  generateSlackManifest,
  CANONICAL_DEV,
  CANONICAL_PROD,
  SLACK_BOT_SCOPES,
} from '../channels/slack-manifest';

// ONE manifest implementation. These tests lock in that:
//   1. the committed canonical JSON files are exactly what the builder emits
//      (so they can never drift — regenerate with scripts/gen-slack-manifest.ts);
//   2. canonical and BYO manifests are identical except URLs/names/command;
//   3. the BYO (per-project) manifest is at full feature parity.

const channelsDir = join(import.meta.dir, '..', 'channels');
function committed(file: string) {
  return JSON.parse(readFileSync(join(channelsDir, file), 'utf8'));
}

describe('committed canonical manifests are generated from the builder (drift guard)', () => {
  test('slack-app-manifest.json === buildSlackManifest(CANONICAL_DEV)', () => {
    expect(committed('slack-app-manifest.json')).toEqual(buildSlackManifest(CANONICAL_DEV));
  });
  test('slack-app-manifest.prod.json === buildSlackManifest(CANONICAL_PROD)', () => {
    expect(committed('slack-app-manifest.prod.json')).toEqual(buildSlackManifest(CANONICAL_PROD));
  });
});

describe('canonical and BYO share ONE implementation (only URLs/names/command differ)', () => {
  const canonical = buildSlackManifest(CANONICAL_PROD);
  const byo = generateSlackManifest({ baseUrl: 'https://api.example.com', projectId: 'proj-123' });

  test('identical bot scopes', () => {
    expect(byo.oauth_config.scopes.bot).toEqual(canonical.oauth_config.scopes.bot);
    expect(canonical.oauth_config.scopes.bot).toEqual([...SLACK_BOT_SCOPES]);
  });
  test('identical bot events', () => {
    expect(byo.settings.event_subscriptions.bot_events).toEqual(canonical.settings.event_subscriptions.bot_events);
  });
  test('identical shortcuts', () => {
    expect(byo.features.shortcuts).toEqual(canonical.features.shortcuts);
  });
  test('both enable interactivity + a slash command', () => {
    expect(byo.settings.interactivity.is_enabled).toBe(true);
    expect(canonical.settings.interactivity.is_enabled).toBe(true);
    expect(byo.features.slash_commands.length).toBe(1);
  });
});

describe('BYO per-project manifest endpoints', () => {
  const base = 'https://api.example.com/v1/webhooks/slack/proj-123';
  const m = generateSlackManifest({ baseUrl: 'https://api.example.com/', projectId: 'proj-123' });

  test('slash command at the per-project endpoint', () => {
    expect(m.features.slash_commands[0]!.url).toBe(`${base}/commands`);
    expect(m.features.slash_commands[0]!.usage_hint).toContain('agents');
    expect(m.features.slash_commands[0]!.usage_hint).toContain('models');
    expect(m.features.slash_commands[0]!.usage_hint).toContain('session');
  });
  test('interactivity + events + shortcut at the per-project endpoint', () => {
    expect(m.settings.interactivity.request_url).toBe(`${base}/interactivity`);
    expect(m.settings.event_subscriptions.request_url).toBe(base);
    expect(m.features.shortcuts[0]!.callback_id).toBe('open_session');
  });
  test('BYO is self-installed → no OAuth redirect; canonical → has one', () => {
    expect(m.oauth_config.redirect_urls).toBeUndefined();
    expect(buildSlackManifest(CANONICAL_PROD).oauth_config.redirect_urls).toEqual([
      'https://api.kortix.com/v1/webhooks/slack/oauth/callback',
    ]);
  });
  test('requests the commands scope', () => {
    expect(m.oauth_config.scopes.bot).toContain('commands');
  });
});
