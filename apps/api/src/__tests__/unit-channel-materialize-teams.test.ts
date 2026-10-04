import { beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * The Teams channel connector is registered by the install, like Slack's. The
 * per-project `teams` feature flag graduated on 2026-10-01, so a value a
 * project stored while it existed changes nothing.
 */

let projectMetadata: unknown = {};
let hasTeamsInstall = true;

mock.module('../lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ metadata: projectMetadata }],
        }),
      }),
    }),
  },
}));

mock.module('../services/channels/install-store', () => ({
  loadSlackInstall: async () => null,
  loadTeamsInstall: async () => (hasTeamsInstall ? { tenantId: 'tenant-1' } : null),
  listAgentMailInstalls: async () => [],
}));

const { synthesizeChannelConnectors } = await import('../services/connectors/channel-materialize');

const teamsSpecs = async (declared: Parameters<typeof synthesizeChannelConnectors>[1] = []) =>
  (await synthesizeChannelConnectors('p-1', declared)).filter((s) => s.platform === 'teams');

beforeEach(() => {
  projectMetadata = {};
  hasTeamsInstall = true;
});

describe('synthesizeChannelConnectors — a Teams install is the registration', () => {
  test('a live Teams install materializes the connector', async () => {
    const specs = await teamsSpecs();
    expect(specs).toHaveLength(1);
    expect(specs[0]!.provider).toBe('channel');
    expect(specs[0]!.enabled).toBe(true);
  });

  test('a `teams: false` stored while Teams was a flag is inert', async () => {
    projectMetadata = { experimental: { teams: false } };
    expect(await teamsSpecs()).toHaveLength(1);
  });

  test('without an install there is no connector', async () => {
    hasTeamsInstall = false;
    expect(await teamsSpecs()).toEqual([]);
  });

  test('an explicit channel declaration is never shadowed', async () => {
    const declared = [{ slug: 'teams', provider: 'channel', platform: 'teams' }] as unknown as Parameters<
      typeof synthesizeChannelConnectors
    >[1];
    expect(await teamsSpecs(declared)).toEqual([]);
  });
});
