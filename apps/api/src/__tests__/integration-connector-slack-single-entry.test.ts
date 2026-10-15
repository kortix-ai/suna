/**
 * KRTX-2353 — one Slack per project listing.
 *
 * A project can hold Slack two ways at once: the platform-owned channel
 * connector (`kortix_slack`, materialized from the Slack install) and a managed
 * Slack profile the user added through the catalogue (Composio/Pipedream, whose
 * add flow generates a `slack-<random>` slug). Both named "Slack", the
 * dashboard and the agent catalog showed the duplicate. `hideSupersededSlack`
 * must collapse them to the channel entry by APP identity (`config.app`), not
 * by connection slug, and the collapse must be conditional: with the channel
 * gone the managed profile is listed again, grants untouched.
 *
 * Real-Postgres contract: runs in the db-suites lane.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, connectors, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { dbConnectorRouterDeps } from '../connectors/db-deps';
import { db } from '../shared/db';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const CHANNEL = crypto.randomUUID();
const MANAGED = crypto.randomUUID();

const channelRow = {
  connectorId: CHANNEL,
  accountId: ACCOUNT,
  projectId: PROJECT,
  slug: 'kortix_slack',
  name: 'Slack',
  providerType: 'channel' as const,
  config: { platform: 'slack', baseUrl: 'https://api.example.test/v1' },
};

// The shape the managed add flow writes: a generated slug, the app identity on
// the row's config, no connection_credentials row (the grant lives in the
// connection metadata).
const managedRow = {
  connectorId: MANAGED,
  accountId: ACCOUNT,
  projectId: PROJECT,
  slug: 'slack-k8x2p1',
  name: 'Slack',
  providerType: 'composio' as const,
  config: { app: 'slack', account: null },
};

const listedSlugs = async () =>
  (await dbConnectorRouterDeps.listConnectors(PROJECT)).map((c) => c.slug);

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'slack-single-entry' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'slack-single-entry',
    repoUrl: 'https://example.test/slack-single-entry.git',
  });
  await db.insert(connectors).values([channelRow, managedRow]);
});

afterAll(async () => {
  await db.delete(connectors).where(eq(connectors.projectId, PROJECT));
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('a project with both the Slack channel and a managed Slack profile', () => {
  test('the listing shows exactly one Slack — the channel — and no managed duplicate', async () => {
    const slugs = await listedSlugs();
    expect(slugs.filter((slug) => slug === 'kortix_slack')).toHaveLength(1);
    expect(slugs.filter((slug) => slug.startsWith('slack-'))).toEqual([]);
  });

  test('the surviving entry is the channel connector with its own presentation', async () => {
    const listed = await dbConnectorRouterDeps.listConnectors(PROJECT);
    const slack = listed.find((c) => c.slug === 'kortix_slack');
    expect(slack).toBeDefined();
    expect(slack!.provider).toBe('channel');
  });
});

describe('the collapse is conditional, never destructive', () => {
  test('without the channel connector the managed profile is listed again', async () => {
    await db.delete(connectors).where(eq(connectors.connectorId, CHANNEL));
    const slugs = await listedSlugs();
    expect(slugs).toContain('slack-k8x2p1');
  });
});
