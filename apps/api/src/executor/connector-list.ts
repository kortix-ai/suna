import type { AdminConnectorView } from './router';

export interface AdminConnectorCandidate {
  slug: string;
  name: string;
  provider: string;
  platform: string | null;
  iconUrl: string | null;
  status: string;
  authorizationStrategy: 'project' | 'user';
  sensitive: boolean;
  actions: AdminConnectorView['actions'];
  requiresAuth: boolean;
  requestAuthType: AdminConnectorView['requestAuthType'];
}

export function buildAdminConnectorViews(
  candidates: AdminConnectorCandidate[],
  connectedSlugs: ReadonlySet<string>,
): AdminConnectorView[] {
  return candidates.map((candidate) => ({
    slug: candidate.slug,
    name: candidate.name,
    provider: candidate.provider,
    platform: candidate.platform,
    iconUrl: candidate.iconUrl,
    status: candidate.status,
    credentialMode: 'shared' as const,
    authorizationStrategy: candidate.authorizationStrategy,
    sensitive: candidate.sensitive,
    actions: candidate.actions,
    requestAuthType: candidate.requestAuthType,
    authSecret: candidate.requiresAuth ? 'credential' : null,
    secretSet: candidate.requiresAuth ? connectedSlugs.has(candidate.slug) : true,
  }));
}
