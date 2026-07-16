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
