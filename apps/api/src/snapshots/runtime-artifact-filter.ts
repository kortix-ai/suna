/**
 * Files/directories that do not affect sandbox runtime behavior and should not
 * participate in snapshot identity or provider build context.
 */
export const RUNTIME_ARTIFACT_EXCLUDE_NAMES = [
  'node_modules',
  '.bin',
  'dist',
  '.turbo',
  '.cache',
  'coverage',
  '__tests__',
  'test',
  'tests',
  'README.md',
  '.DS_Store',
] as const;

const RUNTIME_ARTIFACT_EXCLUDE_SET = new Set<string>(RUNTIME_ARTIFACT_EXCLUDE_NAMES);

export function isRuntimeArtifactExcludedName(name: string): boolean {
  return RUNTIME_ARTIFACT_EXCLUDE_SET.has(name);
}

export function shouldIncludeRuntimeArtifactPath(path: string): boolean {
  return !path.split(/[\\/]+/).some(isRuntimeArtifactExcludedName);
}
