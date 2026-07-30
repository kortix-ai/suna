export function providerLabel(provider: string | null | undefined): string {
  if (provider === 'github') return 'GitHub';
  if (provider === 'code-storage' || provider === 'code_storage') return 'Kortix Code Storage';
  if (provider === 'gitlab') return 'GitLab';
  return provider ? provider.replaceAll('_', ' ') : 'Git';
}

export function repositoryWebUrl(
  provider: string | null | undefined,
  repoUrl: string,
): string | null {
  if (provider !== 'github' && provider !== 'gitlab') return null;
  return repoUrl.replace(/\.git$/i, '');
}
