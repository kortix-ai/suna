import type { AdminConnectorView } from './router';

export interface AdminConnectorCandidate {
  slug: string;
  name: string;
  provider: string;
  platform: string | null;
  iconUrl: string | null;
  status: string;
  sensitive: boolean;
  actions: AdminConnectorView['actions'];
  requiresAuth: boolean;
}

export function buildAdminConnectorViews(
  candidates: AdminConnectorCandidate[],
  isConnected: (candidate: AdminConnectorCandidate) => Promise<boolean>,
): Promise<AdminConnectorView[]> {
  return Promise.all(
    candidates.map(async (candidate) => ({
      slug: candidate.slug,
      name: candidate.name,
      provider: candidate.provider,
      platform: candidate.platform,
      iconUrl: candidate.iconUrl,
      status: candidate.status,
      credentialMode: 'shared' as const,
      sensitive: candidate.sensitive,
      actions: candidate.actions,
      authSecret: candidate.requiresAuth ? 'credential' : null,
      secretSet: candidate.requiresAuth ? await isConnected(candidate) : true,
    })),
  );
}
