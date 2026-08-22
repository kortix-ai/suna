export function isProviderStateLoading(input: {
  projectDetailLoading: boolean;
  secretsLoading: boolean;
}): boolean {
  return input.projectDetailLoading || input.secretsLoading;
}
