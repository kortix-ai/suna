import { type ProjectSession, isPiWorkerRuntimeMetadata } from '@kortix/sdk';

type ProjectSessionCompactionSource = Pick<ProjectSession, 'metadata' | 'opencode_session_id'>;
type ProjectSessionRuntimeSource = Pick<ProjectSession, 'metadata'>;

export type ProjectSessionRuntimeIdentity = 'unknown' | 'pi-worker' | 'opencode';

export function resolveProjectSessionRuntimeIdentity(
  session: ProjectSessionRuntimeSource | null | undefined,
): ProjectSessionRuntimeIdentity {
  if (!session) return 'unknown';
  return isPiWorkerRuntimeMetadata(session.metadata) ? 'pi-worker' : 'opencode';
}

export function resolveProjectSessionCompactionId(
  session: ProjectSessionCompactionSource | null | undefined,
): string | null {
  if (!session || isPiWorkerRuntimeMetadata(session.metadata)) return null;
  const sessionId = session.opencode_session_id?.trim();
  return sessionId || null;
}
