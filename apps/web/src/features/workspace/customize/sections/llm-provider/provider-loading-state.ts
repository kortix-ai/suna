export function isProviderStateLoading(input: {
  workspaceDetailLoading: boolean;
  secretsLoading: boolean;
}): boolean {
  return input.workspaceDetailLoading || input.secretsLoading;
}
