type QueryClientLike = {
  invalidateQueries: (filters: { queryKey: readonly unknown[] }) => unknown;
};

/**
 * Sandbox provisioning is attempted immediately after login. A brand-new user
 * has no Workspace yet, so that first attempt can fail. Creating or importing a
 * workspace makes provisioning possible and must clear that cached failure.
 */
export function invalidateAfterWorkspaceCreation(queryClient: QueryClientLike): void {
  void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
  void queryClient.invalidateQueries({ queryKey: ['platform', 'sandbox'] });
}
