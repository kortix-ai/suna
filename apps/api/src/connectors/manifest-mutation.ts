import { commitManifest, loadManifestForEdit } from '../projects/index';

export type ManifestMutationResult =
  | { ok: true; commitMessage: string | null }
  | { ok: false; error: string; status: number };

export type ManifestCommitResult =
  | { ok: true }
  | { ok: false; error: string; status: number };

type EditableManifest = Awaited<ReturnType<typeof loadManifestForEdit>>;
type ManifestProject = Parameters<typeof loadManifestForEdit>[0];

function isRevisionConflict(result: ManifestCommitResult): boolean {
  return (
    !result.ok &&
    result.status === 409 &&
    /^File ".+" changed since it was read$/.test(result.error)
  );
}

/** Reload and retry one manifest compare-and-swap conflict. */
export async function mutateManifestWithRetry(
  project: ManifestProject,
  operation: string,
  mutate: (manifest: EditableManifest) => ManifestMutationResult,
): Promise<ManifestCommitResult> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let manifest: EditableManifest;
    try {
      manifest = await loadManifestForEdit(project);
    } catch (error) {
      return {
        ok: false,
        error: (error as Error).message || 'failed to read manifest',
        status: 400,
      };
    }

    const change = mutate(manifest);
    if (!change.ok) return change;
    if (change.commitMessage === null) return { ok: true };

    const committed = await commitManifest(project, manifest, change.commitMessage);
    const result: ManifestCommitResult =
      'error' in committed
        ? { ok: false, error: committed.error, status: committed.status }
        : { ok: true };
    if (!isRevisionConflict(result)) return result;
    if (attempt === 1) {
      return {
        ok: false,
        error: `kortix.yaml changed twice while ${operation}. Retry the command.`,
        status: 409,
      };
    }
  }
  throw new Error('unreachable connector manifest retry state');
}
