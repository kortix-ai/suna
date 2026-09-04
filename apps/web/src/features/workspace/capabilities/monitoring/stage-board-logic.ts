import { SESSION_STAGES, type ProjectSession, type SessionStage } from '@kortix/sdk';

/** Column headers, in {@link SESSION_STAGES} order. */
export const STAGE_LABELS: Record<SessionStage, string> = {
  backlog: 'Backlog',
  planning: 'Planning',
  ready: 'Ready',
  in_progress: 'In progress',
  review: 'Review',
  done: 'Done',
};

/** The column a session sits in. No `stage` yet (or an unknown value) → Backlog. */
export function sessionStage(session: Pick<ProjectSession, 'stage'>): SessionStage {
  const value = session.stage?.value;
  return value && (SESSION_STAGES as readonly string[]).includes(value) ? value : 'backlog';
}

/** A card parked in Ready until a human approves the plan. */
export function needsApproval(session: Pick<ProjectSession, 'stage'>): boolean {
  return sessionStage(session) === 'ready' && session.stage?.needs_approval === true;
}

/** When the card last moved — the stage stamp, else the row's `updated_at`. */
export function stageMovedAt(session: Pick<ProjectSession, 'stage' | 'updated_at'>): string {
  return session.stage?.updated_at ?? session.updated_at;
}

function ms(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/** Every column, every session exactly once, newest move first inside a column. */
export function groupSessionsByStage(
  sessions: readonly ProjectSession[],
): Record<SessionStage, ProjectSession[]> {
  const groups = {} as Record<SessionStage, ProjectSession[]>;
  for (const stage of SESSION_STAGES) groups[stage] = [];
  for (const session of sessions) groups[sessionStage(session)].push(session);
  for (const stage of SESSION_STAGES) {
    groups[stage].sort((a, b) => ms(stageMovedAt(b)) - ms(stageMovedAt(a)));
  }
  return groups;
}
