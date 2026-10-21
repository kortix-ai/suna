import type { ProjectSecret } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import { collidingIdentifiers, keyCollisionGroups } from '../../src/lib/secret-collisions';
import { secretScope, selectAllowlistableSecrets } from '../../src/lib/secret-scope';

const secret = (identifier: string, name: string, over: Record<string, unknown> = {}) =>
  ({
    identifier,
    name,
    project_id: 'P1',
    secret_id: 's1',
    created_by: null,
    created_at: null,
    updated_at: null,
    configured: true,
    mine: null,
    effective_source: 'shared',
    can_manage_shared: true,
    ...over,
  }) as ProjectSecret;

describe('selectAllowlistableSecrets', () => {
  test('offers ordinary runtime secrets', () => {
    const rows = selectAllowlistableSecrets([secret('STRIPE', 'STRIPE_KEY')]);
    expect(rows.map((r) => r.identifier)).toEqual(['STRIPE']);
  });

  test('never offers a channel-install row', () => {
    // Slack/Teams installs write these with scope 'connector'. Session create
    // resolves the allowlist against runtime rows only, so allowlisting one
    // fails 404 SECRET_IDENTIFIER_NOT_FOUND — pointing at a row the user can
    // see listed, which reads like a platform bug rather than a scope rule.
    const rows = selectAllowlistableSecrets([
      secret('SLACK_BOT_TOKEN', 'SLACK_BOT_TOKEN'),
      secret('MS_TEAMS_APP_PASSWORD', 'MS_TEAMS_APP_PASSWORD'),
      secret('STRIPE', 'STRIPE_KEY'),
    ]);
    expect(rows.map((r) => r.identifier)).toEqual(['STRIPE']);
  });

  test('an inbox-scoped channel key is recognised with its connection suffix', () => {
    expect(secretScope(secret('a', 'AGENTMAIL_API_KEY'))).toBe('channel_install');
    expect(secretScope(secret('a', 'AGENTMAIL_API_KEY_SUPPORT'))).toBe('channel_install');
  });

  test('a secret that merely starts like a channel key is still an ordinary secret', () => {
    // The scope column is not serialized, so the KEY is the only signal — which
    // makes an exact-name table the difference between a rule and a guess.
    expect(secretScope(secret('a', 'SLACK_WEBHOOK_URL'))).toBe('runtime');
    expect(secretScope(secret('a', 'TELEGRAM_CHAT_ID'))).toBe('runtime');
  });

  test('never offers a platform-managed row', () => {
    expect(selectAllowlistableSecrets([secret('KORTIX_TOKEN', 'KORTIX_TOKEN')])).toHaveLength(0);
    expect(
      selectAllowlistableSecrets([secret('LEGACY', 'LEGACY_KEY', { system: true })]),
    ).toHaveLength(0);
  });

  test('no secrets is empty, not a crash', () => {
    expect(selectAllowlistableSecrets(undefined)).toEqual([]);
  });
});

describe('keyCollisionGroups', () => {
  test('two identifiers on one KEY are reported against both', () => {
    const items = [
      secret('GMAPS-primary', 'GOOGLE_MAPS_API_KEY'),
      secret('GMAPS-backup', 'GOOGLE_MAPS_API_KEY'),
      secret('STRIPE', 'STRIPE_KEY'),
    ];
    expect([...keyCollisionGroups(items).entries()]).toEqual([
      ['GOOGLE_MAPS_API_KEY', ['GMAPS-backup', 'GMAPS-primary']],
    ]);
    expect(collidingIdentifiers(items, 'GMAPS-primary')).toEqual(['GMAPS-backup']);
    expect(collidingIdentifiers(items, 'GMAPS-backup')).toEqual(['GMAPS-primary']);
    expect(collidingIdentifiers(items, 'STRIPE')).toEqual([]);
  });

  test('a channel-install row sharing a KEY is not a collision the server can raise', () => {
    // Create resolves the allowlist against runtime rows only, so the
    // connector-scoped row is never one of the two claimants.
    const items = [
      secret('SLACK_BOT_TOKEN', 'SLACK_BOT_TOKEN'),
      secret('my-slack', 'SLACK_BOT_TOKEN'),
    ];
    expect(keyCollisionGroups(items).size).toBe(0);
    expect(collidingIdentifiers(items, 'my-slack')).toEqual([]);
  });

  test('an unknown identifier collides with nothing', () => {
    expect(collidingIdentifiers([secret('A', 'A_KEY')], 'missing')).toEqual([]);
  });
});
