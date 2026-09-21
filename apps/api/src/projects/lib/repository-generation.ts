type Metadata = Record<string, unknown> | null | undefined;

export function repositoryGeneration(metadata: Metadata): string | null {
  const value = metadata?.repository_generation;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A repository replacement retires sessions pinned to every earlier upstream. */
export function sessionUsesCurrentRepository(project: Metadata, session: Metadata): boolean {
  const current = repositoryGeneration(project);
  return current === null || repositoryGeneration(session) === current;
}

export type SessionRepositoryStartDecision =
  | { ok: true; repository: 'current' | 'previous' }
  | {
      ok: false;
      code: 'session_repository_changed' | 'previous_repository_runtime_unavailable';
    };

/**
 * A previous-repository session can resume only its preserved runtime. The
 * decision never authorizes Git: the Git proxy independently rejects the old
 * repository generation.
 */
export function sessionRepositoryStartDecision(
  project: Metadata,
  session: Metadata,
  input: { repositoryMode: string | undefined; hasPreservedRuntime: boolean },
): SessionRepositoryStartDecision {
  if (sessionUsesCurrentRepository(project, session)) {
    return { ok: true, repository: 'current' };
  }
  if (input.repositoryMode !== 'previous') {
    return { ok: false, code: 'session_repository_changed' };
  }
  if (!input.hasPreservedRuntime) {
    return { ok: false, code: 'previous_repository_runtime_unavailable' };
  }
  return { ok: true, repository: 'previous' };
}
