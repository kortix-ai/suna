import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  accountMembers,
  accounts,
  agentKnowledgeAssignments,
  agentKnowledgeChunks,
  agentKnowledgeSources,
  agentKnowledgeVersions,
  agentProfileDrafts,
  agentProfileTestSessions,
  changeRequests,
  executorConnectionProfiles,
  executorConnectorActions,
  executorConnectors,
  projectMembers,
  projectSessions,
  projectTriggerExecutions,
  projectTriggerRuntime,
  projects,
} from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { config } from '../config';
import { app } from '../index';
import {
  reconcilePublishedAgentKnowledge,
  retryPendingAgentProfileKnowledgeReconciliations,
} from '../projects/lib/agent-knowledge-assignments';
import { searchAgentKnowledgeForSession } from '../projects/lib/session-knowledge';
import { createAccountToken } from '../repositories/account-tokens';
import { db } from '../shared/db';

const run = promisify(execFile);
const ACCOUNT = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const CONNECTOR = crypto.randomUUID();
const CONNECTOR_PROFILE = crypto.randomUUID();
let token = '';
let tokenId = '';
let root = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'kortix-agent-profile-route-'));
  const repo = join(root, 'profile.git');
  const work = join(root, 'work');
  await run('git', ['init', '--bare', '--initial-branch=main', repo]);
  await run('git', ['init', '-b', 'main', work]);
  const files = {
    'kortix.yaml': `
kortix_version: 2
default_agent: support
agents:
  support:
    connectors: [github]
    knowledge: []
    skills: [ticket-triage]
  sales:
    knowledge: []
triggers:
  - slug: weekday-briefing
    name: Weekday briefing
    type: cron
    agent: support
    enabled: true
    cron: "0 0 9 * * 1-5"
    timezone: UTC
    prompt: Summarize approved support sources.
`,
    '.kortix/opencode/agents/support.md': `---
description: Support specialist
mode: primary
model: openai/gpt-4o
---

Resolve customer issues with cited evidence.
`,
    '.kortix/opencode/agents/sales.md': 'Qualify leads.',
  };
  for (const [path, content] of Object.entries(files)) {
    const full = join(work, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Kortix',
    GIT_AUTHOR_EMAIL: 'noreply@kortix.ai',
    GIT_COMMITTER_NAME: 'Kortix',
    GIT_COMMITTER_EMAIL: 'noreply@kortix.ai',
  };
  await run('git', ['add', '-A'], { cwd: work, env });
  await run('git', ['commit', '-m', 'chore: seed profile project'], {
    cwd: work,
    env,
  });
  await run('git', ['push', repo, 'main:refs/heads/main'], { cwd: work, env });

  await db.execute(
    sql`alter table kortix.account_tokens add column if not exists agent_grant jsonb`,
  );
  await db.execute(sql`alter table kortix.account_tokens add column if not exists session_id text`);
  await db.execute(
    sql`alter table kortix.account_tokens add column if not exists service_account_id uuid`,
  );
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'agent-profile-route-test' });
  await db.insert(accountMembers).values({
    accountId: ACCOUNT,
    userId: OWNER,
    accountRole: 'member',
    isSuperAdmin: false,
  });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'agent-profile-route-test',
    repoUrl: repo,
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    metadata: { experimental: { agent_profile: true } },
  });
  await db.insert(projectMembers).values({
    accountId: ACCOUNT,
    projectId: PROJECT,
    userId: OWNER,
    projectRole: 'editor',
  });
  await db.insert(executorConnectors).values({
    connectorId: CONNECTOR,
    accountId: ACCOUNT,
    projectId: PROJECT,
    slug: 'github',
    name: 'GitHub',
    providerType: 'pipedream',
    status: 'active',
  });
  await db.insert(executorConnectionProfiles).values({
    profileId: CONNECTOR_PROFILE,
    accountId: ACCOUNT,
    projectId: PROJECT,
    connectorId: CONNECTOR,
    ownerType: 'project',
    label: 'GitHub workspace',
    status: 'active',
    metadata: {
      scopes: ['contents:write'],
      agent_profile_draft_agent: 'support',
      agent_profile_draft_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    },
    createdBy: OWNER,
  });
  await db.insert(executorConnectorActions).values({
    connectorId: CONNECTOR,
    path: 'github.issues.create',
    name: 'Create issue',
    risk: 'write',
  });
  const created = await createAccountToken({
    accountId: ACCOUNT,
    userId: OWNER,
    projectId: PROJECT,
    name: 'agent-profile-route-token',
  });
  token = created.secretKey;
  tokenId = created.tokenId;
});

afterAll(async () => {
  await db.delete(executorConnectors).where(eq(executorConnectors.projectId, PROJECT));
  await db.delete(agentKnowledgeSources).where(eq(agentKnowledgeSources.projectId, PROJECT));
  await db.delete(agentProfileDrafts).where(eq(agentProfileDrafts.projectId, PROJECT));
  await db.delete(changeRequests).where(eq(changeRequests.projectId, PROJECT));
  await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  await db.delete(projectMembers).where(eq(projectMembers.projectId, PROJECT));
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db
    .delete(accountMembers)
    .where(and(eq(accountMembers.accountId, ACCOUNT), eq(accountMembers.userId, OWNER)));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  await rm(root, { recursive: true, force: true });
});

function request(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('agent profile HTTP route', () => {
  test('loads the merged profile and rejects stale shared-draft updates', async () => {
    const initial = await request('GET', `/v1/projects/${PROJECT}/agents/support/profile`);
    expect(initial.status).toBe(200);
    const initialBody = await initial.json();
    expect(initialBody.agent_name).toBe('support');
    expect(initialBody.is_default).toBe(true);
    expect(initialBody.sections.instructions.prompt).toContain('cited evidence');
    expect(initialBody.sections.integrations[0].slug).toBe('github');
    expect(initialBody.sections.skills[0].slug).toBe('ticket-triage');
    expect(initialBody.draft).toBeNull();

    const update = await request('PUT', `/v1/projects/${PROJECT}/agents/support/profile/draft`, {
      expectedRevision: 0,
      sections: {
        instructions: {
          ...initialBody.sections.instructions,
          prompt: 'Resolve customer issues and cite private knowledge.',
        },
      },
    });
    expect(update.status).toBe(200);
    const draft = await update.json();
    expect(draft.revision).toBe(1);
    expect(draft.changed_sections).toEqual(['instructions']);
    expect(draft.highest_risk).toBe('low');
    expect(draft.active_editors[0].user_id).toBe(OWNER);

    const stale = await request('PUT', `/v1/projects/${PROJECT}/agents/support/profile/draft`, {
      expectedRevision: 0,
      sections: { knowledge: ['runbook'] },
    });
    expect(stale.status).toBe(409);
    const conflict = await stale.json();
    expect(conflict.code).toBe('agent_profile_revision_conflict');
    expect(conflict.current_revision).toBe(1);
    expect(conflict.conflicting_sections).toEqual(['instructions']);
    expect(conflict.active_editors[0].user_id).toBe(OWNER);

    const preview = await request('POST', `/v1/projects/${PROJECT}/agents/support/profile/preview`);
    expect(preview.status).toBe(200);
    const previewBody = await preview.json();
    expect(previewBody.impact).toEqual({
      data_access: [],
      actions: [],
      schedule_changes: [],
      cost_sensitive_settings: [],
    });
    expect(previewBody.changes).toEqual([
      {
        section: 'instructions',
        risk: 'low',
        kind: 'update',
        summary: 'Update instructions',
      },
    ]);
    expect(previewBody.technical_diff.map((entry: { path: string }) => entry.path)).toEqual([
      '.kortix/opencode/agents/support.md',
    ]);

    const published = await request(
      'POST',
      `/v1/projects/${PROJECT}/agents/support/profile/publish`,
      { expectedRevision: 1 },
    );
    expect(published.status).toBe(201);
    const publishedBody = await published.json();
    expect(publishedBody.updated_existing_request).toBe(false);
    expect(publishedBody.branch).toMatch(/^kortix\/agents\/profile\/support-/);
    expect(publishedBody.commit_sha).toMatch(/^[a-f0-9]{40}$/);

    const defaultConfig = await request('GET', `/v1/projects/${PROJECT}/agents/support/config`);
    expect((await defaultConfig.json()).block.opencode.prompt).toContain('cited evidence');

    const secondUpdate = await request(
      'PUT',
      `/v1/projects/${PROJECT}/agents/support/profile/draft`,
      {
        expectedRevision: 1,
        sections: {
          instructions: {
            ...initialBody.sections.instructions,
            prompt: 'Second reviewed instruction revision.',
          },
        },
      },
    );
    expect(secondUpdate.status).toBe(200);
    expect((await secondUpdate.json()).revision).toBe(2);

    const republished = await request(
      'POST',
      `/v1/projects/${PROJECT}/agents/support/profile/publish`,
      { expectedRevision: 2 },
    );
    expect(republished.status).toBe(201);
    const republishedBody = await republished.json();
    expect(republishedBody.updated_existing_request).toBe(true);
    expect(republishedBody.change_request.cr_id).toBe(publishedBody.change_request.cr_id);
    expect(republishedBody.branch).toBe(publishedBody.branch);
  });

  test('keeps URL sources private to the canonical agent and revokes immediately', async () => {
    const created = await request(
      'POST',
      `/v1/projects/${PROJECT}/agents/support/knowledge/sources`,
      {
        type: 'url',
        title: 'Support runbook',
        url: 'https://docs.example.com/support',
        automaticSync: false,
      },
    );
    expect(created.status).toBe(201);
    const source = await created.json();
    expect(source.agent_name).toBe('support');
    expect(source.privacy).toBe('private');
    expect(source.status).toBe('pending');

    const salesList = await request('GET', `/v1/projects/${PROJECT}/agents/sales/knowledge`);
    expect(salesList.status).toBe(200);
    expect((await salesList.json()).sources).toEqual([]);

    const forgedSync = await request(
      'POST',
      `/v1/projects/${PROJECT}/agents/sales/knowledge/${source.source_id}/sync`,
    );
    expect(forgedSync.status).toBe(404);

    const revoked = await request(
      'DELETE',
      `/v1/projects/${PROJECT}/agents/support/knowledge/${source.source_id}`,
    );
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ ok: true });

    const supportList = await request('GET', `/v1/projects/${PROJECT}/agents/support/knowledge`);
    expect((await supportList.json()).sources).toEqual([]);

    const publishable = await request(
      'POST',
      `/v1/projects/${PROJECT}/agents/support/knowledge/sources`,
      {
        type: 'url',
        title: 'Published support handbook',
        url: 'https://docs.example.com/published-support',
        automaticSync: false,
      },
    );
    expect(publishable.status).toBe(201);
    const publishableSource = await publishable.json();
    const activeVersionId = crypto.randomUUID();
    await db.insert(agentKnowledgeVersions).values({
      versionId: activeVersionId,
      accountId: ACCOUNT,
      projectId: PROJECT,
      agentName: 'support',
      sourceId: publishableSource.source_id,
      status: 'active',
      chunkCount: 1,
      lexicalOnly: true,
      promotedAt: new Date(),
    });
    await db
      .update(agentKnowledgeSources)
      .set({ status: 'ready', activeVersionId })
      .where(eq(agentKnowledgeSources.sourceId, publishableSource.source_id));
    await db.insert(agentKnowledgeChunks).values({
      accountId: ACCOUNT,
      projectId: PROJECT,
      agentName: 'support',
      sourceId: publishableSource.source_id,
      versionId: activeVersionId,
      chunkIndex: 0,
      content: 'DRAFTONLY support handbook evidence.',
      tokenCount: 6,
      locator: { heading: 'Draft evidence' },
    });
    const beforeAssignments = await db
      .select()
      .from(agentKnowledgeAssignments)
      .where(eq(agentKnowledgeAssignments.sourceId, publishableSource.source_id));
    expect(beforeAssignments).toEqual([]);

    const profile = await request('GET', `/v1/projects/${PROJECT}/agents/support/profile`);
    let profileBody = await profile.json();
    const generatedSkill = await request(
      'POST',
      `/v1/projects/${PROJECT}/agents/support/profile/skills/generate`,
      {
        name: 'cited-support',
        brief: 'Answer support questions from approved evidence and include a citation.',
      },
    );
    expect(generatedSkill.status).toBe(201);
    const generatedSkillBody = await generatedSkill.json();
    expect(generatedSkillBody.skills[0]).toMatchObject({
      slug: 'cited-support',
      description: 'Answer support questions from approved evidence and include a citation.',
    });
    expect(generatedSkillBody.draft.sections.skills.at(-1)).toMatchObject({
      slug: 'cited-support',
      origin: 'generated',
      status: 'pending_publication',
    });
    const forgedIntegration = await request(
      'PUT',
      `/v1/projects/${PROJECT}/agents/support/profile/draft`,
      {
        expectedRevision: generatedSkillBody.draft.revision,
        sections: {
          integrations: [
            {
              profile_id: crypto.randomUUID(),
              slug: 'github',
              provider: 'github',
              display_name: 'GitHub',
              scopes: ['contents:write'],
              can_write: true,
              status: 'pending_publication',
              error: null,
            },
          ],
        },
      },
    );
    expect(forgedIntegration.status).toBe(400);
    expect((await forgedIntegration.json()).code).toBe('invalid_integration_profile');

    const integrationDraft = await request(
      'PUT',
      `/v1/projects/${PROJECT}/agents/support/profile/draft`,
      {
        expectedRevision: generatedSkillBody.draft.revision,
        sections: {
          integrations: [
            {
              profile_id: CONNECTOR_PROFILE,
              slug: 'forged-slug',
              provider: 'forged-provider',
              display_name: 'Forged name',
              scopes: [],
              can_write: false,
              status: 'available',
              error: 'forged error',
            },
          ],
        },
      },
    );
    expect(integrationDraft.status).toBe(200);
    const integrationDraftBody = await integrationDraft.json();
    expect(integrationDraftBody.sections.integrations).toEqual([
      {
        profile_id: CONNECTOR_PROFILE,
        slug: 'github',
        provider: 'pipedream',
        display_name: 'GitHub workspace',
        scopes: ['contents:write'],
        can_write: true,
        status: 'pending_publication',
        error: null,
      },
    ]);
    const originalKortixUrl = config.KORTIX_URL;
    config.KORTIX_URL = 'https://draft-test.example.test';
    let tested: Response;
    try {
      tested = await request('POST', `/v1/projects/${PROJECT}/agents/support/profile/test`, {
        expectedRevision: integrationDraftBody.revision,
      });
    } finally {
      config.KORTIX_URL = originalKortixUrl;
    }
    expect(tested.status).toBe(201);
    const testedBody = await tested.json();
    expect(testedBody.branch).toMatch(/^kortix\/agents\/profile\/support-test-/);
    expect(testedBody.excluded_integrations).toEqual(['github']);
    const [testGrant] = await db
      .select()
      .from(agentProfileTestSessions)
      .where(eq(agentProfileTestSessions.sessionId, testedBody.session_id));
    expect(testGrant).toMatchObject({
      agentName: 'support',
      draftRevision: integrationDraftBody.revision,
      sourceIds: [publishableSource.source_id],
      excludedIntegrations: ['github'],
    });

    const draftSearch = await searchAgentKnowledgeForSession({
      projectId: PROJECT,
      requestedSessionId: testedBody.session_id,
      authenticatedSessionId: testedBody.session_id,
      authenticatedAgentName: 'support',
      query: 'DRAFTONLY',
    });
    expect(draftSearch.results).toHaveLength(1);

    const normalSessionId = crypto.randomUUID();
    await db.insert(projectSessions).values({
      sessionId: normalSessionId,
      accountId: ACCOUNT,
      projectId: PROJECT,
      branchName: `session-${normalSessionId}`,
      agentName: 'support',
      createdBy: OWNER,
    });
    const preMergeSearch = await searchAgentKnowledgeForSession({
      projectId: PROJECT,
      requestedSessionId: normalSessionId,
      authenticatedSessionId: normalSessionId,
      authenticatedAgentName: 'support',
      query: 'DRAFTONLY',
    });
    expect(preMergeSearch.results).toEqual([]);

    profileBody = await (
      await request('GET', `/v1/projects/${PROJECT}/agents/support/profile`)
    ).json();
    const publish = await request(
      'POST',
      `/v1/projects/${PROJECT}/agents/support/profile/publish`,
      {
        expectedRevision: profileBody.draft.revision,
        acknowledgeHighRisk: true,
      },
    );
    expect(publish.status).toBe(201);
    const publishBody = await publish.json();

    const publishedDraftProfile = await (
      await request('GET', `/v1/projects/${PROJECT}/agents/support/profile`)
    ).json();
    const unpublishedEdit = await request(
      'PUT',
      `/v1/projects/${PROJECT}/agents/support/profile/draft`,
      {
        expectedRevision: publishBody.revision,
        sections: {
          instructions: {
            ...publishedDraftProfile.draft.sections.instructions,
            prompt: 'This edit must remain a draft after the published revision merges.',
          },
          integrations: [],
        },
      },
    );
    expect(unpublishedEdit.status).toBe(200);
    const unpublishedDraft = await unpublishedEdit.json();
    expect(unpublishedDraft.revision).toBe(publishBody.revision + 1);

    const merge = await request(
      'POST',
      `/v1/projects/${PROJECT}/change-requests/${publishBody.change_request.cr_id}/merge`,
      {},
    );
    expect(merge.status).toBe(200);
    const assignments = await db
      .select()
      .from(agentKnowledgeAssignments)
      .where(eq(agentKnowledgeAssignments.sourceId, publishableSource.source_id));
    expect(assignments).toHaveLength(1);
    expect(assignments[0]?.active).toBe(true);
    const [mergedChangeRequest] = await db
      .select({ metadata: changeRequests.metadata })
      .from(changeRequests)
      .where(eq(changeRequests.crId, publishBody.change_request.cr_id));
    const mergedProfileMetadata = (
      mergedChangeRequest?.metadata as Record<string, Record<string, unknown>>
    )?.agent_profile;
    expect(mergedProfileMetadata?.knowledge).toEqual([publishableSource.slug]);
    expect(mergedProfileMetadata?.connector_profile_ids).toEqual([CONNECTOR_PROFILE]);
    expect(mergedProfileMetadata?.knowledge_reconciled_at).toBeString();

    await db
      .update(agentKnowledgeAssignments)
      .set({ active: false })
      .where(eq(agentKnowledgeAssignments.sourceId, publishableSource.source_id));
    const retryMetadata = structuredClone(
      (mergedChangeRequest?.metadata as Record<string, unknown>) ?? {},
    );
    delete (retryMetadata.agent_profile as Record<string, unknown>).knowledge_reconciled_at;
    await db
      .update(changeRequests)
      .set({ metadata: retryMetadata })
      .where(eq(changeRequests.crId, publishBody.change_request.cr_id));
    expect(await retryPendingAgentProfileKnowledgeReconciliations()).toMatchObject({
      reconciled: 1,
      failed: 0,
    });
    const [retriedAssignment] = await db
      .select({ active: agentKnowledgeAssignments.active })
      .from(agentKnowledgeAssignments)
      .where(eq(agentKnowledgeAssignments.sourceId, publishableSource.source_id));
    expect(retriedAssignment?.active).toBe(true);
    const [publishedSourceRecord] = await db
      .select({ expiresAt: agentKnowledgeSources.expiresAt })
      .from(agentKnowledgeSources)
      .where(eq(agentKnowledgeSources.sourceId, publishableSource.source_id));
    expect(publishedSourceRecord?.expiresAt).toBeNull();
    const [publishedConnectorProfile] = await db
      .select({ metadata: executorConnectionProfiles.metadata })
      .from(executorConnectionProfiles)
      .where(eq(executorConnectionProfiles.profileId, CONNECTOR_PROFILE));
    expect(publishedConnectorProfile?.metadata.scopes).toEqual(['contents:write']);
    expect(publishedConnectorProfile?.metadata.agent_profile_draft_agent).toBeUndefined();
    expect(publishedConnectorProfile?.metadata.agent_profile_draft_expires_at).toBeUndefined();

    const mergedProfile = await request('GET', `/v1/projects/${PROJECT}/agents/support/profile`);
    const mergedBody = await mergedProfile.json();
    expect(mergedBody.sections.knowledge).toEqual([publishableSource.slug]);
    expect(mergedBody.sections.skills.map((skill: { slug: string }) => skill.slug)).toContain(
      'cited-support',
    );
    expect(mergedBody.draft.revision).toBe(unpublishedDraft.revision);
    expect(mergedBody.draft.sections.instructions.prompt).toContain('must remain a draft');
    expect(mergedBody.draft.sections.integrations).toEqual([]);
    const committedSkill = await run('git', [
      '--git-dir',
      join(root, 'profile.git'),
      'show',
      'main:.kortix/opencode/skills/cited-support/SKILL.md',
    ]);
    expect(committedSkill.stdout).toContain('include a citation');

    const newerChangeRequestId = crypto.randomUUID();
    const newerMergeCommit = 'b'.repeat(40);
    await db.insert(changeRequests).values({
      crId: newerChangeRequestId,
      accountId: ACCOUNT,
      projectId: PROJECT,
      number: 2_000_000_000,
      title: 'Newer support profile publication',
      baseRef: 'main',
      headRef: 'kortix/agents/profile/support-newer',
      status: 'merged',
      createdBy: OWNER,
      mergedAt: new Date(Date.now() + 10_000),
      mergedBy: OWNER,
      mergeCommitSha: newerMergeCommit,
      metadata: {
        agent_profile: {
          agent_name: 'support',
          draft_revision: unpublishedDraft.revision,
          paths: [],
          knowledge: [],
          knowledge_reconciled_at: new Date().toISOString(),
        },
      },
    });
    await db
      .update(agentKnowledgeAssignments)
      .set({ active: false })
      .where(eq(agentKnowledgeAssignments.sourceId, publishableSource.source_id));
    const staleReconcile = await reconcilePublishedAgentKnowledge({
      accountId: ACCOUNT,
      projectId: PROJECT,
      agentName: 'support',
      sourceSlugs: [publishableSource.slug],
      manifestRevision: publishBody.change_request.head_commit_sha,
      changeRequestId: publishBody.change_request.cr_id,
      draftRevision: publishBody.revision,
    });
    expect(staleReconcile.status).toBe('superseded');
    const [staleAssignment] = await db
      .select({ active: agentKnowledgeAssignments.active })
      .from(agentKnowledgeAssignments)
      .where(eq(agentKnowledgeAssignments.sourceId, publishableSource.source_id));
    expect(staleAssignment?.active).toBe(false);
    await db.delete(changeRequests).where(eq(changeRequests.crId, newerChangeRequestId));

    const discarded = await request(
      'POST',
      `/v1/projects/${PROJECT}/agents/support/profile/discard`,
      { expectedRevision: unpublishedDraft.revision },
    );
    expect(discarded.status).toBe(200);
    const cleanProfile = await request('GET', `/v1/projects/${PROJECT}/agents/support/profile`);
    expect((await cleanProfile.json()).draft).toBeNull();
  });

  test('pauses runtime immediately while leaving repository cleanup for the profile draft', async () => {
    const scheduleRevision = 'a'.repeat(64);
    await db
      .delete(projectTriggerRuntime)
      .where(
        and(
          eq(projectTriggerRuntime.projectId, PROJECT),
          eq(projectTriggerRuntime.slug, 'weekday-briefing'),
        ),
      );
    await db.insert(projectTriggerRuntime).values({
      projectId: PROJECT,
      slug: 'weekday-briefing',
      triggerType: 'cron',
      enabled: true,
      scheduleCron: '0 0 9 * * 1-5',
      scheduleTimezone: 'UTC',
      scheduleRevision,
      scheduleSpec: { slug: 'weekday-briefing', type: 'cron', enabled: true },
      nextFireAt: new Date(Date.now() + 60_000),
    });
    const [execution] = await db
      .insert(projectTriggerExecutions)
      .values({
        projectId: PROJECT,
        slug: 'weekday-briefing',
        scheduleRevision,
        scheduledFor: new Date(Date.now() + 60_000),
        status: 'queued',
        spec: { slug: 'weekday-briefing' },
        payload: {},
      })
      .returning();
    if (!execution) throw new Error('Queued schedule execution was not created.');

    const paused = await request(
      'POST',
      `/v1/projects/${PROJECT}/agents/support/profile/automations/weekday-briefing/pause`,
      {},
    );
    expect(paused.status).toBe(200);
    expect(await paused.json()).toMatchObject({
      ok: true,
      slug: 'weekday-briefing',
      cancelled_executions: 1,
    });

    const [runtime] = await db
      .select()
      .from(projectTriggerRuntime)
      .where(
        and(
          eq(projectTriggerRuntime.projectId, PROJECT),
          eq(projectTriggerRuntime.slug, 'weekday-briefing'),
        ),
      );
    expect(runtime).toMatchObject({ enabled: false, nextFireAt: null });
    const [cancelled] = await db
      .select()
      .from(projectTriggerExecutions)
      .where(eq(projectTriggerExecutions.executionId, execution.executionId));
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      lastError: 'Cancelled because the schedule was paused.',
    });

    const committedManifest = await run('git', [
      '--git-dir',
      join(root, 'profile.git'),
      'show',
      'main:kortix.yaml',
    ]);
    expect(committedManifest.stdout).toContain('enabled: true');
  });
});
