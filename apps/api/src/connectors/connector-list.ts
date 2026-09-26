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
  secretIdentifier: string | null;
  credentialSource: AdminConnectorView['credentialSource'];
  /** The sync engine's stored failure reason — the why behind status 'error'. */
  lastError: string | null;
  /** The accounts this connector holds, default first. Omitted → `[]`. */
  accounts?: AdminConnectorView['accounts'];
  /** Label of the account an unnamed call resolves to. Omitted → `null`. */
  defaultAccount?: AdminConnectorView['default_account'];
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
    lastError: candidate.lastError,
    credentialMode: 'shared' as const,
    authorizationStrategy: candidate.authorizationStrategy,
    sensitive: candidate.sensitive,
    actions: candidate.actions,
    requestAuthType: candidate.requestAuthType,
    authSecret: candidate.requiresAuth ? 'credential' : null,
    secretIdentifier: candidate.secretIdentifier,
    credentialSource: candidate.credentialSource,
    secretSet: candidate.requiresAuth ? connectedSlugs.has(candidate.slug) : true,
    accounts: candidate.accounts ?? [],
    default_account: candidate.defaultAccount ?? null,
  }));
}
