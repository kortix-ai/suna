import {
  agentProfileDrafts,
  type AgentProfileDraftChange,
  type AgentProfileDraftEditor,
  type AgentProfileDraftImpact,
  type AgentProfileDraftSections,
} from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import {
  AGENT_PROFILE_SECTIONS,
  classifyAgentProfileChanges,
  type AgentProfileClassification,
  type AgentProfileSection,
  type AgentProfileSections,
} from './agent-profile-risk';

const EDITOR_ACTIVE_MS = 2 * 60 * 1000;
const DRAFT_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

export interface AgentProfileActiveEditor {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
  lastSeenAt: string;
}

export interface AgentProfileDraftRecord extends AgentProfileClassification {
  draftId: string;
  accountId: string;
  projectId: string;
  agentName: string;
  revision: number;
  baseRevision: string | null;
  baseSections: AgentProfileSections;
  sections: AgentProfileSections;
  sectionRevisions: Record<string, number>;
  activeEditors: AgentProfileActiveEditor[];
  branchName: string | null;
  changeRequestId: string | null;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

export class AgentProfileRevisionConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly currentRevision: number,
    readonly conflictingSections: AgentProfileSection[],
    readonly activeEditors: AgentProfileActiveEditor[],
  ) {
    super(`Agent profile draft revision ${expectedRevision} is stale; current revision is ${currentRevision}.`);
    this.name = 'AgentProfileRevisionConflictError';
  }
}

function normalizeEditors(
  stored: unknown,
  current?: { userId: string; displayName: string | null; avatarUrl: string | null },
  now = new Date(),
): AgentProfileActiveEditor[] {
  const cutoff = now.getTime() - EDITOR_ACTIVE_MS;
  const editors = Array.isArray(stored)
    ? stored.filter((entry): entry is AgentProfileActiveEditor => {
        if (!entry || typeof entry !== 'object') return false;
        const editor = entry as Partial<AgentProfileActiveEditor>;
        return (
          typeof editor.userId === 'string' &&
          typeof editor.lastSeenAt === 'string' &&
          new Date(editor.lastSeenAt).getTime() >= cutoff
        );
      })
    : [];
  const byUser = new Map(editors.map((editor) => [editor.userId, editor]));
  if (current) {
    byUser.set(current.userId, {
      ...current,
      lastSeenAt: now.toISOString(),
    });
  }
  return [...byUser.values()].sort((left, right) => left.userId.localeCompare(right.userId));
}

function sectionsFrom(value: unknown): AgentProfileSections {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as AgentProfileSections)
    : {};
}

function sectionRevisionsFrom(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === 'number' && Number.isInteger(entry[1]),
    ),
  );
}

function classificationFor(row: typeof agentProfileDrafts.$inferSelect): AgentProfileClassification {
  const stored = {
    changedSections: Array.isArray(row.changedSections)
      ? (row.changedSections as AgentProfileSection[])
      : [],
    changes: Array.isArray(row.changes)
      ? (row.changes as unknown as AgentProfileClassification['changes'])
      : [],
    highestRisk: row.highestRisk,
    impact: row.impact as unknown as AgentProfileClassification['impact'],
  };
  if (
    stored.impact &&
    Array.isArray(stored.impact.data_access) &&
    Array.isArray(stored.impact.actions) &&
    Array.isArray(stored.impact.schedule_changes) &&
    Array.isArray(stored.impact.cost_sensitive_settings)
  ) {
    return stored;
  }
  return classifyAgentProfileChanges(sectionsFrom(row.baseSections), sectionsFrom(row.sections));
}

function toRecord(row: typeof agentProfileDrafts.$inferSelect): AgentProfileDraftRecord {
  return {
    draftId: row.draftId,
    accountId: row.accountId,
    projectId: row.projectId,
    agentName: row.agentName,
    revision: row.revision,
    baseRevision: row.baseRevision,
    baseSections: sectionsFrom(row.baseSections),
    sections: sectionsFrom(row.sections),
    sectionRevisions: sectionRevisionsFrom(row.sectionRevisions),
    activeEditors: normalizeEditors(row.activeEditors),
    branchName: row.branchName,
    changeRequestId: row.changeRequestId,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
    ...classificationFor(row),
  };
}

function changedAfter(row: AgentProfileDraftRecord, expectedRevision: number): AgentProfileSection[] {
  return AGENT_PROFILE_SECTIONS.filter(
    (section) => (row.sectionRevisions[section] ?? 0) > expectedRevision,
  );
}

async function currentOrConflict(
  projectId: string,
  agentName: string,
  expectedRevision: number,
  editor?: { userId: string; displayName: string | null; avatarUrl: string | null },
): Promise<never> {
  const current = await getAgentProfileDraftRecord(projectId, agentName);
  const activeEditors = normalizeEditors(current?.activeEditors ?? [], editor);
  throw new AgentProfileRevisionConflictError(
    expectedRevision,
    current?.revision ?? 0,
    current ? changedAfter(current, expectedRevision) : [],
    activeEditors,
  );
}

export async function getAgentProfileDraftRecord(
  projectId: string,
  agentName: string,
): Promise<AgentProfileDraftRecord | null> {
  const [row] = await db
    .select()
    .from(agentProfileDrafts)
    .where(
      and(
        eq(agentProfileDrafts.projectId, projectId),
        eq(agentProfileDrafts.agentName, agentName),
      ),
    )
    .limit(1);
  return row ? toRecord(row) : null;
}

export async function updateAgentProfileDraftRecord(input: {
  accountId: string;
  projectId: string;
  agentName: string;
  userId: string;
  editor: { displayName: string | null; avatarUrl: string | null };
  expectedRevision: number;
  baseRevision: string | null;
  baseSections: AgentProfileSections;
  sections: AgentProfileSections;
}): Promise<AgentProfileDraftRecord> {
  const now = new Date();
  const editor = { userId: input.userId, ...input.editor };
  const current = await getAgentProfileDraftRecord(input.projectId, input.agentName);

  if (!current) {
    if (input.expectedRevision !== 0) {
      return currentOrConflict(
        input.projectId,
        input.agentName,
        input.expectedRevision,
        editor,
      );
    }
    const revision = 1;
    const mergedSections = { ...input.baseSections, ...input.sections };
    const classification = classifyAgentProfileChanges(input.baseSections, mergedSections);
    const sectionRevisions = Object.fromEntries(
      Object.keys(input.sections).map((section) => [section, revision]),
    );
    const [inserted] = await db
      .insert(agentProfileDrafts)
      .values({
        accountId: input.accountId,
        projectId: input.projectId,
        agentName: input.agentName,
        revision,
        baseRevision: input.baseRevision,
        baseSections: input.baseSections as AgentProfileDraftSections,
        sections: mergedSections as AgentProfileDraftSections,
        sectionRevisions,
        changedSections: classification.changedSections,
        changes: classification.changes as AgentProfileDraftChange[],
        impact: classification.impact as AgentProfileDraftImpact,
        highestRisk: classification.highestRisk,
        activeEditors: normalizeEditors([], editor, now) as AgentProfileDraftEditor[],
        updatedBy: input.userId,
        expiresAt: new Date(now.getTime() + DRAFT_EXPIRY_MS),
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [agentProfileDrafts.projectId, agentProfileDrafts.agentName],
      })
      .returning();
    if (!inserted) {
      return currentOrConflict(input.projectId, input.agentName, input.expectedRevision, editor);
    }
    return toRecord(inserted);
  }

  if (current.revision !== input.expectedRevision) {
    return currentOrConflict(input.projectId, input.agentName, input.expectedRevision, editor);
  }

  const revision = current.revision + 1;
  const mergedSections = { ...current.sections, ...input.sections };
  const sectionRevisions = { ...current.sectionRevisions };
  for (const section of Object.keys(input.sections)) sectionRevisions[section] = revision;
  const classification = classifyAgentProfileChanges(current.baseSections, mergedSections);
  const [updated] = await db
    .update(agentProfileDrafts)
    .set({
      revision,
      sections: mergedSections as AgentProfileDraftSections,
      sectionRevisions,
      changedSections: classification.changedSections,
      changes: classification.changes as AgentProfileDraftChange[],
      impact: classification.impact as AgentProfileDraftImpact,
      highestRisk: classification.highestRisk,
      activeEditors: normalizeEditors(current.activeEditors, editor, now) as AgentProfileDraftEditor[],
      updatedBy: input.userId,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + DRAFT_EXPIRY_MS),
    })
    .where(
      and(
        eq(agentProfileDrafts.projectId, input.projectId),
        eq(agentProfileDrafts.agentName, input.agentName),
        eq(agentProfileDrafts.revision, input.expectedRevision),
      ),
    )
    .returning();
  if (!updated) {
    return currentOrConflict(input.projectId, input.agentName, input.expectedRevision, editor);
  }
  return toRecord(updated);
}

export async function discardAgentProfileDraftRecord(
  projectId: string,
  agentName: string,
  expectedRevision: number,
  userId: string,
): Promise<void> {
  const deleted = await db
    .delete(agentProfileDrafts)
    .where(
      and(
        eq(agentProfileDrafts.projectId, projectId),
        eq(agentProfileDrafts.agentName, agentName),
        eq(agentProfileDrafts.revision, expectedRevision),
      ),
    )
    .returning({ draftId: agentProfileDrafts.draftId });
  if (deleted.length === 0) {
    return currentOrConflict(projectId, agentName, expectedRevision, {
      userId,
      displayName: null,
      avatarUrl: null,
    });
  }
}

export async function markAgentProfileDraftPublication(input: {
  projectId: string;
  agentName: string;
  expectedRevision: number;
  branchName: string;
  changeRequestId: string;
}): Promise<AgentProfileDraftRecord> {
  const [updated] = await db
    .update(agentProfileDrafts)
    .set({
      branchName: input.branchName,
      changeRequestId: input.changeRequestId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentProfileDrafts.projectId, input.projectId),
        eq(agentProfileDrafts.agentName, input.agentName),
        eq(agentProfileDrafts.revision, input.expectedRevision),
      ),
    )
    .returning();
  if (!updated) {
    return currentOrConflict(input.projectId, input.agentName, input.expectedRevision);
  }
  return toRecord(updated);
}
