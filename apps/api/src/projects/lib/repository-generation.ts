type Metadata = Record<string, unknown> | null | undefined;

export function repositoryGeneration(metadata: Metadata): string | null {
  const value = metadata?.repository_generation;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Classify whether a session started before the project's current repository generation. */
export function sessionUsesCurrentRepository(project: Metadata, session: Metadata): boolean {
  const current = repositoryGeneration(project);
  return current === null || repositoryGeneration(session) === current;
}
