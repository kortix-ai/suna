import { commitManifest, loadManifestForEdit } from '../projects/lib/triggers';

export type ManifestMutationResult =
  | { ok: true; commitMessage: string | null }
  | {
      ok: false;
      error: string;
      status: number;
      code?: string;
      remediation?: string;
      /** Replaces the default `{ error }` response envelope. */
      body?: Record<string, unknown>;
    };

export type ManifestCommitResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
      status: number;
      code?: string;
      remediation?: string;
      /** Replaces the default `{ error }` response envelope. */
      body?: Record<string, unknown>;
    };

type EditableManifest = Awaited<ReturnType<typeof loadManifestForEdit>>;
type ManifestProject = Parameters<typeof loadManifestForEdit>[0];

function isRevisionConflict(result: ManifestCommitResult): boolean {
  return (
    !result.ok &&
    result.status === 409 &&
    /^File ".+" changed since it was read$/.test(result.error)
  );
}

const MAX_ATTEMPTS = 4;

/** The wait between attempts. Tests replace `sleep`, so no test waits on the clock. */
export const manifestRetry = {
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Reload and retry a manifest compare-and-swap conflict: up to 4 attempts,
 * waiting 50–100 ms × the attempt number between them, so writers that
 * collided (the web saving two rules at once, a trigger and a user) spread out
 * instead of colliding again.
 */
export async function mutateManifestWithRetry(
  project: ManifestProject,
  operation: string,
  mutate: (manifest: EditableManifest) => ManifestMutationResult | Promise<ManifestMutationResult>,
): Promise<ManifestCommitResult> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await manifestRetry.sleep(Math.floor(50 * attempt * (1 + Math.random())));
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

    const change = await mutate(manifest);
    if (!change.ok) return change;
    if (change.commitMessage === null) return { ok: true };

    const committed = await commitManifest(project, manifest, change.commitMessage);
    const result: ManifestCommitResult =
      'error' in committed
        ? { ok: false, error: committed.error, status: committed.status }
        : { ok: true };
    if (!isRevisionConflict(result)) return result;
    if (attempt === MAX_ATTEMPTS - 1) {
      return {
        ok: false,
        error: `kortix.yaml changed ${MAX_ATTEMPTS} times while ${operation}. Retry the command.`,
        status: 409,
      };
    }
  }
  throw new Error('unreachable connector manifest retry state');
}
