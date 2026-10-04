import { SnapshotInUseError } from './providers/errors';

export async function runProviderActions<TProvider extends string, TResult>(
  providers: readonly TProvider[],
  action: (provider: TProvider) => Promise<TResult>,
): Promise<{
  started: Array<{ provider: TProvider; result: TResult }>;
  failed: Array<{ provider: TProvider; error: unknown }>;
}> {
  const attempts = await Promise.all(
    providers.map(async (provider) => {
      try {
        return { provider, result: await action(provider), status: 'fulfilled' as const };
      } catch (error) {
        return { provider, error, status: 'rejected' as const };
      }
    }),
  );
  return {
    started: attempts.flatMap((attempt) =>
      attempt.status === 'fulfilled'
        ? [{ provider: attempt.provider, result: attempt.result }]
        : [],
    ),
    failed: attempts.flatMap((attempt) =>
      attempt.status === 'rejected' ? [{ provider: attempt.provider, error: attempt.error }] : [],
    ),
  };
}

/**
 * The HTTP answer for a rebuild that started on no provider.
 *
 * When every provider refused because running sandboxes still use the image
 * (Platinum `template_in_use`), the caller gets `409 SNAPSHOT_IN_USE` with the
 * sandbox count: an expected state the user resolves by stopping sessions. Any
 * other failure stays `503`. Both name the failed providers.
 */
export function rebuildFailureResponse(
  failed: ReadonlyArray<{ provider: string; error: unknown }>,
): { status: 409 | 503; body: Record<string, unknown> & { error: string } } {
  const failedProviders = failed.map((item) => item.provider);
  const inUse = failed.every((item) => item.error instanceof SnapshotInUseError)
    ? failed.reduce((sum, item) => sum + (item.error as SnapshotInUseError).inUse, 0)
    : 0;
  if (failed.length > 0 && inUse > 0) {
    return {
      status: 409,
      body: {
        error: `${inUse} running sandboxes still use this image. Stop their sessions, then rebuild.`,
        code: 'SNAPSHOT_IN_USE',
        in_use: inUse,
        failed_providers: failedProviders,
      },
    };
  }
  return {
    status: 503,
    body: {
      error: 'Could not start a rebuild on any sandbox provider',
      failed_providers: failedProviders,
    },
  };
}
