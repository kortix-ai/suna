import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, agentProfileDrafts, projects } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import {
  AgentProfileRevisionConflictError,
  discardAgentProfileDraftRecord,
  getAgentProfileDraftRecord,
  updateAgentProfileDraftRecord,
} from '../projects/lib/agent-profile-drafts';
import { db } from '../shared/db';

const accountId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const editorOne = crypto.randomUUID();
const editorTwo = crypto.randomUUID();

beforeAll(async () => {
  await db.insert(accounts).values({ accountId, name: 'agent-profile-draft-test' });
  await db.insert(projects).values({
    projectId,
    accountId,
    name: 'agent-profile-draft-test',
    repoUrl: 'https://example.test/repo.git',
  });
});

afterAll(async () => {
  await db.delete(agentProfileDrafts).where(eq(agentProfileDrafts.projectId, projectId));
  await db.delete(projects).where(eq(projects.projectId, projectId));
  await db.delete(accounts).where(eq(accounts.accountId, accountId));
});

describe('agent profile shared draft concurrency', () => {
  test('creates, updates, rejects stale writes, and rejects stale discard', async () => {
    const first = await updateAgentProfileDraftRecord({
      accountId,
      projectId,
      agentName: 'support',
      userId: editorOne,
      editor: { displayName: 'Ari', avatarUrl: null },
      expectedRevision: 0,
      baseRevision: 'base-sha',
      baseSections: {},
      sections: { instructions: { prompt: 'Use approved sources.' } },
    });
    expect(first.revision).toBe(1);
    expect(first.highestRisk).toBe('low');

    let conflict: AgentProfileRevisionConflictError | null = null;
    try {
      await updateAgentProfileDraftRecord({
        accountId,
        projectId,
        agentName: 'support',
        userId: editorTwo,
        editor: { displayName: 'Bea', avatarUrl: null },
        expectedRevision: 0,
        baseRevision: 'base-sha',
        baseSections: {},
        sections: { knowledge: ['support-handbook'] },
      });
    } catch (error) {
      conflict = error as AgentProfileRevisionConflictError;
    }
    expect(conflict).toBeInstanceOf(AgentProfileRevisionConflictError);
    expect(conflict?.currentRevision).toBe(1);
    expect(conflict?.conflictingSections).toEqual(['instructions']);
    expect(conflict?.activeEditors.map((editor) => editor.userId).sort()).toEqual(
      [editorOne, editorTwo].sort(),
    );

    const second = await updateAgentProfileDraftRecord({
      accountId,
      projectId,
      agentName: 'support',
      userId: editorTwo,
      editor: { displayName: 'Bea', avatarUrl: null },
      expectedRevision: 1,
      baseRevision: 'base-sha',
      baseSections: {},
      sections: { knowledge: ['support-handbook'] },
    });
    expect(second.revision).toBe(2);
    expect(second.highestRisk).toBe('medium');
    expect(second.changedSections).toEqual(['instructions', 'knowledge']);

    await expect(
      discardAgentProfileDraftRecord(projectId, 'support', 1, editorOne),
    ).rejects.toBeInstanceOf(AgentProfileRevisionConflictError);

    await discardAgentProfileDraftRecord(projectId, 'support', 2, editorTwo);
    expect(await getAgentProfileDraftRecord(projectId, 'support')).toBeNull();
  });

  test('keeps drafts isolated by canonical agent name', async () => {
    await updateAgentProfileDraftRecord({
      accountId,
      projectId,
      agentName: 'researcher',
      userId: editorOne,
      editor: { displayName: 'Ari', avatarUrl: null },
      expectedRevision: 0,
      baseRevision: 'base-sha',
      baseSections: {},
      sections: { knowledge: ['research-library'] },
    });

    expect(await getAgentProfileDraftRecord(projectId, 'support')).toBeNull();
    const researcher = await getAgentProfileDraftRecord(projectId, 'researcher');
    expect(researcher?.sections.knowledge).toEqual(['research-library']);

    await db
      .delete(agentProfileDrafts)
      .where(
        and(
          eq(agentProfileDrafts.projectId, projectId),
          eq(agentProfileDrafts.agentName, 'researcher'),
        ),
      );
  });
});
