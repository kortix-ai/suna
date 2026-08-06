import { beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * The Teams channel connector is gated on the per-project `teams` experimental
 * feature — the same shape as email/voice, and NOT an operator env var. These
 * assert the gate behaviourally: a project with a live Teams install still gets
 * no `teams` connector until it opts in.
 */

let projectMetadata: unknown = {};
let hasTeamsInstall = true;

mock.module('../shared/db', () => ({
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

mock.module('../channels/install-store', () => ({
  loadSlackInstall: async () => null,
  loadTeamsInstall: async () => (hasTeamsInstall ? { tenantId: 'tenant-1' } : null),
  listAgentMailInstalls: async () => [],
}));

const { synthesizeChannelConnectors } = await import('../connectors/channel-materialize');

const teamsSpecs = async () =>
  (await synthesizeChannelConnectors('p-1', [])).filter((s) => s.platform === 'teams');

beforeEach(() => {
  projectMetadata = {};
  hasTeamsInstall = true;
});

describe('synthesizeChannelConnectors — Teams is gated on the `teams` experiment', () => {
  test('a live Teams install alone does NOT materialize the connector', async () => {
    expect(await teamsSpecs()).toEqual([]);
  });

  test('opting into `teams` materializes the connector for a project with an install', async () => {
    projectMetadata = { experimental: { teams: true } };
    const specs = await teamsSpecs();
    expect(specs).toHaveLength(1);
    expect(specs[0]!.provider).toBe('channel');
    expect(specs[0]!.enabled).toBe(true);
  });

  test('an explicit `teams: false` keeps the connector off', async () => {
    projectMetadata = { experimental: { teams: false } };
    expect(await teamsSpecs()).toEqual([]);
  });

  test('the flag alone is not enough — the install is still required', async () => {
    projectMetadata = { experimental: { teams: true } };
    hasTeamsInstall = false;
    expect(await teamsSpecs()).toEqual([]);
  });
});
