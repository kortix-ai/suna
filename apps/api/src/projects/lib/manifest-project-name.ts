/**
 * kortix.yaml owns `project.name`. A rename commits it to the file first; a
 * manifest sync applies a CHANGED name back to the project row. The last
 * applied value lives in `metadata.manifest_project_name`, so a file that
 * still carries the name it was generated with never undoes a rename made
 * before this rule existed: the first sync only records the marker.
 */
import { mutateManifestWithRetry, type ManifestCommitResult } from '../../connectors/manifest-mutation';
import { withProjectGitAuth } from './git';

type ProjectRow = Parameters<typeof withProjectGitAuth>[0];
type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);

export const MANIFEST_PROJECT_NAME_KEY = 'manifest_project_name';

export async function commitProjectName(row: ProjectRow, name: string): Promise<ManifestCommitResult> {
  let project: Awaited<ReturnType<typeof withProjectGitAuth>>;
  try {
    project = await withProjectGitAuth(row);
  } catch (error) {
    return { ok: false, error: (error as Error).message || 'failed to read kortix.yaml', status: 409 };
  }
  return mutateManifestWithRetry(project, 'the project was being renamed', (manifest) => {
    const block: Row = isRow(manifest.raw.project) ? { ...manifest.raw.project } : {};
    if (block.name === name) return { ok: true, commitMessage: null };
    block.name = name;
    manifest.raw.project = block;
    return { ok: true, commitMessage: `chore: rename project to ${name}` };
  });
}

/**
 * What a sync does with the declared name: `apply` it to the row, only `mark`
 * it (first sight, or a row that already matches), or nothing.
 */
export function projectNameAction(declared: unknown, marker: unknown, current: string): 'apply' | 'mark' | 'none' {
  if (typeof declared !== 'string' || !declared.trim()) return 'none';
  const name = declared.trim();
  if (marker === name) return 'none';
  if (typeof marker !== 'string') return 'mark';
  return name === current ? 'mark' : 'apply';
}
