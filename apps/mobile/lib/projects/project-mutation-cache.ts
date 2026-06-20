type QueryClientLike = {
  invalidateQueries: (filters: { queryKey: readonly unknown[] }) => unknown;
};

/**
 * Sandbox provisioning is attempted immediately after login. A brand-new user
 * has no project yet, so that first attempt can fail. Creating or importing a
 * project makes provisioning possible and must clear that cached failure.
 */
export function invalidateAfterProjectCreation(queryClient: QueryClientLike): void {
  void queryClient.invalidateQueries({ queryKey: ['projects'] });
  void queryClient.invalidateQueries({ queryKey: ['platform', 'sandbox'] });
}
