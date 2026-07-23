import { projectSessionStartSeed, type ProjectSession } from '@kortix/sdk/projects-client';

export interface RunningSessionWarmupTarget {
  projectSessionId: string;
  openCodeSessionId: string;
  runtimeUrl: string;
}

export function runningSessionWarmupTargets(
  sessions: ProjectSession[],
  activeSessionId: string | null,
): RunningSessionWarmupTarget[] {
  const targets: RunningSessionWarmupTarget[] = [];
  for (const session of sessions) {
    if (
      session.session_id === activeSessionId ||
      session.can_access === false ||
      !session.opencode_session_id
    ) {
      continue;
    }
    const runtimeUrl = projectSessionStartSeed(session)?.runtime_url;
    if (!runtimeUrl) continue;
    targets.push({
      projectSessionId: session.session_id,
      openCodeSessionId: session.opencode_session_id,
      runtimeUrl,
    });
  }
  return targets;
}
