import type { AdminConnectorView } from './router-contract';

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
  /** The accounts this connector holds, default first. Omitted → `[]`. */
  accounts?: AdminConnectorView['accounts'];
  /** Label of the account an unnamed call resolves to. Omitted → `null`. */
  defaultAccount?: AdminConnectorView['default_account'];
  /** `connectors.last_error` as stored. Omitted → `null`. */
  lastError?: string | null;
}

const LAST_ERROR_MAX = 300;

/**
 * Make a stored `connectors.last_error` safe to show to every project member
 * who can read connectors.
 *
 * The MCP path writes fixed, already-redacted reasons. Every other provider
 * stores the raw exception message from `resolveCatalog` (sync.ts), which can
 * carry the spec URL with its query, a git remote with embedded credentials,
 * or upstream response text. This strips URL credentials, URL queries and
 * fragments, `Bearer`/`Basic` values and named credential headers, flattens
 * control characters, and caps the length.
 */
// ponytail: pattern-based, so a secret in an unrecognised shape inside upstream
// text still passes. Upgrade path: write fixed reasons at each throw site in
// sync.ts, as `listMcpTools` and `mcpCatalogCredentialError` already do.
export function safeConnectorLastError(raw: string | null | undefined): string | null {
  const text = (raw ?? '')
    .replace(/[\0-\x1f\x7f]+/g, ' ')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi, '$1[REDACTED]@')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>]+)[?#]\S*/gi, '$1?[REDACTED]')
    .replace(
      /\b(authorization|proxy-authorization|x-api-key|api[-_]?key|cookie)(["']?\s*[:=]\s*)[^\r\n,;]+/gi,
      '$1$2[REDACTED]',
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 [REDACTED]')
    .replace(/ {2,}/g, ' ')
    .trim();
  if (!text) return null;
  return text.length > LAST_ERROR_MAX ? `${text.slice(0, LAST_ERROR_MAX - 1)}…` : text;
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
    lastError: safeConnectorLastError(candidate.lastError),
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
