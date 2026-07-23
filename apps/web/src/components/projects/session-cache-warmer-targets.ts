import {
  projectSessionStartSeed,
  type ProjectSession,
  type SessionStartResult,
} from '@kortix/sdk/projects-client';

export interface RunningSessionWarmupTarget {
  sessionId: string;
  startSeed: SessionStartResult;
}

export function runningSessionWarmupTargets(
  sessions: ProjectSession[],
  activeSessionId: string | null,
): RunningSessionWarmupTarget[] {
  const targets: RunningSessionWarmupTarget[] = [];
  for (const session of sessions) {
    if (session.session_id === activeSessionId || session.can_access === false) {
      continue;
    }
    const startSeed = projectSessionStartSeed(session);
    if (!startSeed) continue;
    targets.push({
      sessionId: session.session_id,
      startSeed,
    });
  }
  return targets;
}
