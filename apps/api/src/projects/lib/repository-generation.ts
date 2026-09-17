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
