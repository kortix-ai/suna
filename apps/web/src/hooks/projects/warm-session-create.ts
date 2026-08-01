import type {
  ClaimWarmProjectSessionInput,
  PendingSessionPrompt,
  ProjectSession,
} from '@kortix/sdk';

interface WarmSessionCreateOverrides {
  agent_name?: string;
  sandbox_slug?: string;
  pending_prompt?: PendingSessionPrompt;
}

export async function resolveWarmSessionForSend(
  current: Pick<ProjectSession, 'session_id'> | undefined,
  resolve?: () => Promise<Pick<ProjectSession, 'session_id'> | undefined>,
): Promise<Pick<ProjectSession, 'session_id'> | undefined> {
  if (current || !resolve) return current;
  try {
    return await resolve();
  } catch {
    return undefined;
  }
}

export function buildWarmSessionClaimInput(
  session: Pick<ProjectSession, 'session_id'>,
  create?: WarmSessionCreateOverrides,
): ClaimWarmProjectSessionInput {
  return {
    session_id: session.session_id,
    ...(create?.agent_name ? { agent_name: create.agent_name } : {}),
    ...(create?.sandbox_slug ? { sandbox_slug: create.sandbox_slug } : {}),
    ...(create?.pending_prompt ? { pending_prompt: create.pending_prompt } : {}),
  };
}

export function shouldFallbackFromWarmClaim(error: unknown): boolean {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? (error as { code?: unknown }).code
      : null;
  return (
    code === 'WARM_SESSION_CONFIGURATION_MISMATCH' ||
    code === 'WARM_SESSION_ALREADY_CLAIMED'
  );
}
