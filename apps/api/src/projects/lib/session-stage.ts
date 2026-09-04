import { SESSION_STAGES, type SessionStage, type SessionStageState } from '@kortix/api-contract';

export { SESSION_STAGES };
export type { SessionStage, SessionStageState };

export const SESSION_STAGE_NOTE_MAX = 500;

export function isSessionStage(value: unknown): value is SessionStage {
  return typeof value === 'string' && (SESSION_STAGES as readonly string[]).includes(value);
}

/** `metadata.stage` as written by PUT /sessions/:id/stage, or null for any other shape. */
export function readSessionStage(
  metadata: Record<string, unknown> | null | undefined,
): SessionStageState | null {
  const raw = metadata?.stage;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  if (!isSessionStage(s.value)) return null;
  return {
    value: s.value,
    needs_approval: s.needs_approval === true,
    note: typeof s.note === 'string' ? s.note : null,
    updated_at: typeof s.updated_at === 'string' ? s.updated_at : '',
    updated_by: typeof s.updated_by === 'string' ? s.updated_by : '',
  };
}
