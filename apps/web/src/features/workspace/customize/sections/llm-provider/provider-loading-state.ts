export function isProviderStateLoading(input: {
  projectDetailLoading: boolean;
  secretsLoading: boolean;
  /**
   * The secrets read has answered at least once, with data or an error. A later
   * refetch is background work: TanStack Query v5 resets a query without data
   * to `pending` on refetch, and a spinner here unmounts the provider list,
   * whose readers remount and refetch — an unbounded request loop.
   */
  secretsSettledOnce?: boolean;
}): boolean {
  return input.projectDetailLoading || (input.secretsLoading && !input.secretsSettledOnce);
}
