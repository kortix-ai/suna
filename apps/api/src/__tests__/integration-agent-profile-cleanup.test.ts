import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  accounts,
  agentKnowledgeAssignments,
  agentKnowledgeSources,
  agentProfileDrafts,
  executorConnectionProfiles,
  executorConnectors,
  projects,
} from '@kortix/db';
import { eq } from 'drizzle-orm';
import { cleanupExpiredAgentProfileArtifacts } from '../projects/lib/agent-profile-cleanup';
import { db } from '../shared/db';

const accountId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const userId = crypto.randomUUID();

beforeAll(async () => {
  await db.insert(accounts).values({ accountId, name: 'agent-profile-cleanup-test' });
  await db.insert(projects).values({
    accountId,
    projectId,
    name: 'agent-profile-cleanup-test',
    repoUrl: 'https://example.test/cleanup.git',
  });
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.projectId, projectId));
  await db.delete(accounts).where(eq(accounts.accountId, accountId));
});

describe('agent profile artifact expiration', () => {
  test('deletes unused drafts and sources but preserves a published assignment', async () => {
    const unusedSourceId = crypto.randomUUID();
    const publishedSourceId = crypto.randomUUID();
    const connectorId = crypto.randomUUID();
    const unusedProfileId = crypto.randomUUID();
    const referencedProfileId = crypto.randomUUID();
    const expiredAt = new Date(Date.now() - 60_000);
    await db.insert(agentKnowledgeSources).values([
      {
        sourceId: unusedSourceId,
        accountId,
        projectId,
        agentName: 'support',
        slug: 'unused-source',
        sourceType: 'url',
        title: 'Unused source',
        url: 'https://docs.example.test/unused',
        expiresAt: expiredAt,
        createdBy: userId,
      },
      {
        sourceId: publishedSourceId,
        accountId,
        projectId,
        agentName: 'support',
        slug: 'published-source',
        sourceType: 'url',
        title: 'Published source',
        url: 'https://docs.example.test/published',
        expiresAt: expiredAt,
        createdBy: userId,
      },
    ]);
    await db.insert(agentKnowledgeAssignments).values({
      accountId,
      projectId,
      agentName: 'support',
      sourceId: publishedSourceId,
      manifestRevision: 'a'.repeat(40),
      active: true,
    });
    await db.insert(executorConnectors).values({
      connectorId,
      accountId,
      projectId,
      slug: 'cleanup-drive',
      name: 'Cleanup Drive',
      providerType: 'pipedream',
      config: { app: 'google_drive' },
    });
    await db.insert(executorConnectionProfiles).values([
      {
        profileId: unusedProfileId,
        accountId,
        projectId,
        connectorId,
        label: 'Unused draft connection',
        metadata: {
          agent_profile_draft_agent: 'support',
          agent_profile_draft_expires_at: expiredAt.toISOString(),
        },
        createdBy: userId,
      },
      {
        profileId: referencedProfileId,
        accountId,
        projectId,
        connectorId,
        label: 'Referenced draft connection',
        metadata: {
          agent_profile_draft_agent: 'support',
          agent_profile_draft_expires_at: expiredAt.toISOString(),
        },
        createdBy: userId,
      },
    ]);
    await db.insert(agentProfileDrafts).values({
      accountId,
      projectId,
      agentName: 'support',
      baseSections: {},
      sections: {
        integrations: [{ profile_id: referencedProfileId, slug: 'cleanup-drive' }],
      },
      updatedBy: userId,
      expiresAt: expiredAt,
    });

    const result = await cleanupExpiredAgentProfileArtifacts();
    expect(result.drafts).toBeGreaterThanOrEqual(1);
    expect(result.sources).toBeGreaterThanOrEqual(1);
    expect(result.connectionProfiles).toBeGreaterThanOrEqual(1);
    expect(
      await db
        .select({ sourceId: agentKnowledgeSources.sourceId })
        .from(agentKnowledgeSources)
        .where(eq(agentKnowledgeSources.sourceId, unusedSourceId)),
    ).toEqual([]);
    expect(
      await db
        .select({ sourceId: agentKnowledgeSources.sourceId })
        .from(agentKnowledgeSources)
        .where(eq(agentKnowledgeSources.sourceId, publishedSourceId)),
    ).toEqual([{ sourceId: publishedSourceId }]);
    expect(
      await db
        .select({ profileId: executorConnectionProfiles.profileId })
        .from(executorConnectionProfiles)
        .where(eq(executorConnectionProfiles.profileId, unusedProfileId)),
    ).toEqual([]);
    expect(
      await db
        .select({ profileId: executorConnectionProfiles.profileId })
        .from(executorConnectionProfiles)
        .where(eq(executorConnectionProfiles.profileId, referencedProfileId)),
    ).toEqual([{ profileId: referencedProfileId }]);
  });
});
