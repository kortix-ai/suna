/**
 * Real-DB proof of where a sandbox template keeps `residential_proxy`:
 * `sandbox_templates.metadata.residentialProxy`, set and cleared without
 * touching the other metadata keys (`lastReady`) or the image identity.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { accounts, projects, sandboxTemplates } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';

import { db } from '../shared/db';
import { createTemplate, templateResidentialProxy, updateTemplate } from './templates';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'template-residential-proxy-test' });
  await db.insert(projects).values({ projectId: PROJECT, accountId: ACCOUNT, name: 'p', repoUrl: 'https://example.com/p.git' });
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT)); // cascades templates
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

const metadataOf = async (templateId: string) =>
  (await db.select({ metadata: sandboxTemplates.metadata }).from(sandboxTemplates).where(eq(sandboxTemplates.templateId, templateId)))[0]
    ?.metadata as Record<string, unknown>;

test('a template keeps residential_proxy in its metadata; set and clear keep lastReady and the image identity', async () => {
  const row = await createTemplate({
    projectId: PROJECT,
    accountId: ACCOUNT,
    slug: 'web',
    image: 'ubuntu:24.04',
    residentialProxy: { country: 'us' },
    source: 'ui',
  });
  expect(await templateResidentialProxy(PROJECT, 'web')).toEqual({ country: 'us' });

  // A build recorded its last ready image, and the row has an identity.
  const lastReady = { platinum: { snapshotName: 'kortix-tpl-abc', contentHash: 'h1' } };
  await db
    .update(sandboxTemplates)
    .set({ metadata: sql`${sandboxTemplates.metadata} || ${JSON.stringify({ lastReady })}::jsonb`, contentHash: 'h1', providerState: 'active' })
    .where(eq(sandboxTemplates.templateId, row.templateId));

  await updateTemplate(row.templateId, { residentialProxy: null }, PROJECT);
  expect(await templateResidentialProxy(PROJECT, 'web')).toBeNull();
  expect(await metadataOf(row.templateId)).toEqual({ lastReady });

  const updated = await updateTemplate(row.templateId, { residentialProxy: {} }, PROJECT);
  expect(await templateResidentialProxy(PROJECT, 'web')).toEqual({});
  expect(await metadataOf(row.templateId)).toEqual({ lastReady, residentialProxy: {} });
  // A boot setting: the image stays built.
  expect(updated?.contentHash).toBe('h1');
  expect(updated?.providerState).toBe('active');
});

test('the platform templates and an unknown slug never ask for one', async () => {
  expect(await templateResidentialProxy(PROJECT, 'default')).toBeNull();
  expect(await templateResidentialProxy(PROJECT, 'no-such-template')).toBeNull();
  expect(await templateResidentialProxy(PROJECT, '')).toBeNull();
});
