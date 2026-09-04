import { projectSessions, projects } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { db } from '../../shared/db';
import { readSessionStage, type SessionStageState } from './session-stage';

/**
 * Board backstops driven by what the agent DOES, for the moments the stage
 * protocol asks it to report and it forgets (docs/monitoring.md, "Runtime").
 *
 * An agent that asks the user a question through the platform's question
 * relay is, by definition, waiting for a person — so its card parks in
 * `ready` awaiting approval even if it never ran
 * `kortix sessions stage ready --needs-approval`. The user's answer is the
 * approval, so the card moves to `in_progress` when it lands.
 *
 * Both are no-ops when the project has Monitoring off, and neither overrides a
 * card the agent already placed further along (`review`, `done`).
 */

const NOTE_MAX = 200;

async function monitoringOn(projectId: string): Promise<boolean> {
  const [row] = await db
    .select({ metadata: projects.metadata })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  return row ? resolveFeatureFlag(row.metadata, 'monitoring') : false;
}

async function writeStage(
  projectId: string,
  sessionId: string,
  next: (current: SessionStageState | null) => SessionStageState | null,
): Promise<SessionStageState | null> {
  const [row] = await db
    .select({ metadata: projectSessions.metadata })
    .from(projectSessions)
    .where(and(eq(projectSessions.sessionId, sessionId), eq(projectSessions.projectId, projectId)))
    .limit(1);
  if (!row) return null;
  const stage = next(readSessionStage(row.metadata));
  if (!stage) return null;
  await db
    .update(projectSessions)
    .set({ metadata: { ...(row.metadata ?? {}), stage }, updatedAt: new Date() })
    .where(and(eq(projectSessions.sessionId, sessionId), eq(projectSessions.projectId, projectId)));
  return stage;
}

/** Pure: the stage to write when the agent asks a question, or null to leave it. */
export function stageAfterAgentQuestion(
  current: SessionStageState | null,
  questionText: string,
  now = new Date(),
): SessionStageState | null {
  if (current?.value === 'review' || current?.value === 'done') return null;
  if (current?.value === 'ready' && current.needs_approval) return null;
  const note = questionText.replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX) || null;
  return {
    value: 'ready',
    needs_approval: true,
    note,
    updated_at: now.toISOString(),
    updated_by: 'agent',
  };
}

/** Pure: the stage to write when a person answers, or null to leave it. */
export function stageAfterAnswer(
  current: SessionStageState | null,
  answeredBy: string,
  now = new Date(),
): SessionStageState | null {
  if (!(current?.value === 'ready' && current.needs_approval)) return null;
  return {
    value: 'in_progress',
    needs_approval: false,
    note: current.note,
    updated_at: now.toISOString(),
    updated_by: answeredBy,
  };
}

/** The agent asked the user something → park its card in Ready, awaiting approval. */
export async function parkSessionOnAgentQuestion(input: {
  projectId: string;
  sessionId: string;
  questionText: string;
}): Promise<SessionStageState | null> {
  if (!(await monitoringOn(input.projectId))) return null;
  return writeStage(input.projectId, input.sessionId, (current) =>
    stageAfterAgentQuestion(current, input.questionText),
  );
}

/** A person answered → the card leaves Ready for In progress. */
export async function resumeSessionOnAnswer(input: {
  projectId: string;
  sessionId: string;
  answeredBy: string;
}): Promise<SessionStageState | null> {
  if (!(await monitoringOn(input.projectId))) return null;
  return writeStage(input.projectId, input.sessionId, (current) =>
    stageAfterAnswer(current, input.answeredBy),
  );
}
