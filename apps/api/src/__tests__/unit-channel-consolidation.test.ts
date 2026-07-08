/**
 * Slack-as-a-first-class-channel consolidation:
 *   - the parser reserves the platform-owned `kortix_slack` slug (channel only)
 *   - listings hide a superseded user-defined `slack` connector once the channel exists
 *   - kortix.yaml gains/loses the channel declaration on connect/disconnect,
 *     converting a legacy on-the-wrong-slug channel entry to the reserved slug
 */
import { describe, expect, test } from 'bun:test';
import {
  EMAIL_RESERVED_SLUG,
  extractConnectors,
  SLACK_RESERVED_SLUG,
  RESERVED_CONNECTOR_SLUGS,
} from '../projects/connectors';
import { KNOWN_SCHEMA_VERSION, parseManifestString } from '../projects/triggers';
import {
  hideSupersededSlack,
  withChannelDeclaration,
  withoutChannelDeclaration,
} from '../executor/channel-rules';

function parse(body: string) {
  const src = [`kortix_version: ${KNOWN_SCHEMA_VERSION}`, 'project:\n  name: t', body].join('\n');
  return extractConnectors(parseManifestString(src, 'yaml', 'kortix.yaml'));
}

/* ─── parser: reserved slug ─────────────────────────────────────────────────── */

describe('reserved kortix_slack slug', () => {
  test('the reserved set + canonical slug are what the rest of the code keys on', () => {
    expect(SLACK_RESERVED_SLUG).toBe('kortix_slack');
    expect(EMAIL_RESERVED_SLUG).toBe('kortix_email');
    expect(RESERVED_CONNECTOR_SLUGS.has('slack')).toBe(true);
    expect(RESERVED_CONNECTOR_SLUGS.has('email')).toBe(true);
    expect(RESERVED_CONNECTOR_SLUGS.has('kortix_slack')).toBe(true);
    expect(RESERVED_CONNECTOR_SLUGS.has('kortix_email')).toBe(true);
  });

  test('a non-channel connector may NOT claim kortix_slack', () => {
    const { specs, errors } = parse(`
connectors:
  - slug: kortix_slack
    provider: pipedream
    app: slack
`);
    expect(specs.find((s) => s.slug === 'kortix_slack')).toBeUndefined();
    expect(errors[0]?.error).toMatch(/reserved/i);
  });

  test('the channel connector itself CAN use kortix_slack', () => {
    const { specs, errors } = parse(`
connectors:
  - slug: kortix_slack
    provider: channel
    platform: slack
`);
    expect(errors).toEqual([]);
    expect(specs[0]).toMatchObject({ slug: 'kortix_slack', provider: 'channel', platform: 'slack' });
  });

  test('the email channel connector itself CAN use kortix_email', () => {
    const { specs, errors } = parse(`
connectors:
  - slug: kortix_email
    provider: channel
    platform: email
`);
    expect(errors).toEqual([]);
    expect(specs[0]).toMatchObject({ slug: 'kortix_email', provider: 'channel', platform: 'email' });
  });

  test('a non-channel connector may NOT claim kortix_email', () => {
    const { specs, errors } = parse(`
connectors:
  - slug: kortix_email
    provider: http
    base_url: https://example.com
`);
    expect(specs.find((s) => s.slug === 'kortix_email')).toBeUndefined();
    expect(errors[0]?.error).toMatch(/reserved/i);
  });

  test('a user `slack` connector still parses (kept working, just hidden from the list)', () => {
    const { specs, errors } = parse(`
connectors:
  - slug: slack
    provider: pipedream
    app: slack
`);
    expect(errors).toEqual([]);
    expect(specs[0]).toMatchObject({ slug: 'slack', provider: 'pipedream' });
  });

  test('the `computer` slug is reserved the same way (the Agent Computer Tunnel)', () => {
    expect(RESERVED_CONNECTOR_SLUGS.has('computer')).toBe(true);

    // A user app cannot claim `computer` — without the reserve this would parse
    // as a normal Pipedream/MCP connector named "computer" and SHADOW the tunnel
    // connector (the exact bug class that hit Slack before #3670).
    const shadow = parse(`
connectors:
  - slug: computer
    provider: mcp
    url: https://example.com/mcp
`);
    expect(shadow.specs.find((s) => s.slug === 'computer')).toBeUndefined();
    expect(shadow.errors[0]?.error).toMatch(/reserved/i);

    // The computer connector is synth-only (auto-materialized from a connected
    // machine), so even a declared provider="computer" is rejected — `computer`
    // is never a hand-declared kortix.yaml connector.
    const declared = parse(`
connectors:
  - slug: computer
    provider: computer
`);
    expect(declared.specs.find((s) => s.slug === 'computer')).toBeUndefined();
    expect(declared.errors[0]?.error).toMatch(/automatically|cannot be declared/i);
  });
});

/* ─── listings: hide the superseded duplicate ───────────────────────────────── */

describe('hideSupersededSlack', () => {
  const channel = { slug: 'kortix_slack', providerType: 'channel' };
  const pdSlack = { slug: 'slack', providerType: 'pipedream' };
  const gmail = { slug: 'gmail', providerType: 'pipedream' };

  test('hides a user `slack` once the channel connector is present', () => {
    const out = hideSupersededSlack([channel, pdSlack, gmail]);
    expect(out.map((c) => c.slug).sort()).toEqual(['gmail', 'kortix_slack']);
  });

  test('keeps the user `slack` when there is no channel connector yet', () => {
    const out = hideSupersededSlack([pdSlack, gmail]);
    expect(out.map((c) => c.slug).sort()).toEqual(['gmail', 'slack']);
  });

  test('never hides the channel connector itself or unrelated connectors', () => {
    const out = hideSupersededSlack([channel, gmail]);
    expect(out).toHaveLength(2);
  });
});

/* ─── kortix.yaml persistence transforms ────────────────────────────────────── */

describe('withChannelDeclaration', () => {
  test('adds the reserved channel entry when missing', () => {
    const { connectors, changed } = withChannelDeclaration([], 'slack', SLACK_RESERVED_SLUG);
    expect(changed).toBe(true);
    expect(connectors).toEqual([
      { slug: 'kortix_slack', provider: 'channel', platform: 'slack' },
    ]);
  });

  test('carries a display name so the dashboard shows "Slack", not the slug', () => {
    const { connectors } = withChannelDeclaration([], 'slack', SLACK_RESERVED_SLUG, 'Slack');
    expect(connectors).toEqual([
      { slug: 'kortix_slack', provider: 'channel', platform: 'slack', name: 'Slack' },
    ]);
  });

  test('is idempotent — declaring an already-declared channel makes no change', () => {
    const existing = [{ slug: 'kortix_slack', provider: 'channel', platform: 'slack' }];
    const { changed } = withChannelDeclaration(existing, 'slack', SLACK_RESERVED_SLUG);
    expect(changed).toBe(false);
  });

  test('converts a legacy channel entry on the public `slack` slug to the reserved slug', () => {
    const legacy = [{ slug: 'slack', provider: 'channel', platform: 'slack', enabled: true }];
    const { connectors, changed } = withChannelDeclaration(legacy, 'slack', SLACK_RESERVED_SLUG);
    expect(changed).toBe(true);
    expect(connectors).toEqual([
      { slug: 'kortix_slack', provider: 'channel', platform: 'slack', enabled: true },
    ]);
  });

  test('leaves a user-defined Pipedream `slack` untouched and adds the channel alongside it', () => {
    const mixed = [{ slug: 'slack', provider: 'pipedream', app: 'slack' }];
    const { connectors, changed } = withChannelDeclaration(mixed, 'slack', SLACK_RESERVED_SLUG);
    expect(changed).toBe(true);
    expect(connectors).toEqual([
      { slug: 'slack', provider: 'pipedream', app: 'slack' },
      { slug: 'kortix_slack', provider: 'channel', platform: 'slack' },
    ]);
  });

  test('adds the reserved email channel declaration with display name', () => {
    const { connectors, changed } = withChannelDeclaration([], 'email', EMAIL_RESERVED_SLUG, 'Email');
    expect(changed).toBe(true);
    expect(connectors).toEqual([
      { slug: 'kortix_email', provider: 'channel', platform: 'email', name: 'Email' },
    ]);
  });

  test('does not collapse named email inbox profiles onto the reserved slug', () => {
    const profiles = [
      { slug: 'email_support', provider: 'channel', platform: 'email', name: 'Support email' },
      { slug: 'email_sales', provider: 'channel', platform: 'email', name: 'Sales email' },
    ];
    const { connectors, changed } = withChannelDeclaration(profiles, 'email', EMAIL_RESERVED_SLUG, 'Email');
    expect(changed).toBe(true);
    expect(connectors).toEqual([
      { slug: 'email_support', provider: 'channel', platform: 'email', name: 'Support email' },
      { slug: 'email_sales', provider: 'channel', platform: 'email', name: 'Sales email' },
      { slug: 'kortix_email', provider: 'channel', platform: 'email', name: 'Email' },
    ]);
  });
});

describe('withoutChannelDeclaration', () => {
  test('removes the channel entry (reserved slug or legacy slug) and keeps the rest', () => {
    const list = [
      { slug: 'gmail', provider: 'pipedream' },
      { slug: 'kortix_slack', provider: 'channel', platform: 'slack' },
    ];
    const { connectors, changed } = withoutChannelDeclaration(list, 'slack', SLACK_RESERVED_SLUG);
    expect(changed).toBe(true);
    expect(connectors).toEqual([{ slug: 'gmail', provider: 'pipedream' }]);
  });

  test('no-op when nothing is declared', () => {
    const { changed } = withoutChannelDeclaration(
      [{ slug: 'gmail', provider: 'pipedream' }],
      'slack',
      SLACK_RESERVED_SLUG,
    );
    expect(changed).toBe(false);
  });

  test('removes the email channel declaration and keeps unrelated connectors', () => {
    const list = [
      { slug: 'gmail', provider: 'pipedream' },
      { slug: 'kortix_email', provider: 'channel', platform: 'email' },
    ];
    const { connectors, changed } = withoutChannelDeclaration(list, 'email', EMAIL_RESERVED_SLUG);
    expect(changed).toBe(true);
    expect(connectors).toEqual([{ slug: 'gmail', provider: 'pipedream' }]);
  });

  test('removes only the reserved email channel declaration and keeps named inbox profiles', () => {
    const list = [
      { slug: 'email_support', provider: 'channel', platform: 'email', name: 'Support email' },
      { slug: 'kortix_email', provider: 'channel', platform: 'email', name: 'Email' },
      { slug: 'email_sales', provider: 'channel', platform: 'email', name: 'Sales email' },
    ];
    const { connectors, changed } = withoutChannelDeclaration(list, 'email', EMAIL_RESERVED_SLUG);
    expect(changed).toBe(true);
    expect(connectors).toEqual([
      { slug: 'email_support', provider: 'channel', platform: 'email', name: 'Support email' },
      { slug: 'email_sales', provider: 'channel', platform: 'email', name: 'Sales email' },
    ]);
  });
});
