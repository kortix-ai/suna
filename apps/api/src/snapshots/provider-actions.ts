export async function runProviderActions<TProvider extends string, TResult>(
  providers: readonly TProvider[],
  action: (provider: TProvider) => Promise<TResult>,
): Promise<{
  started: Array<{ provider: TProvider; result: TResult }>;
  failed: Array<{ provider: TProvider; error: unknown }>;
}> {
  const attempts = await Promise.allSettled(
    providers.map(async (provider) => ({ provider, result: await action(provider) })),
  );
  return {
    started: attempts.flatMap((attempt) =>
      attempt.status === 'fulfilled' ? [attempt.value] : []),
    failed: attempts.flatMap((attempt, index) =>
      attempt.status === 'rejected'
        ? [{ provider: providers[index]!, error: attempt.reason }]
        : []),
  };
}
