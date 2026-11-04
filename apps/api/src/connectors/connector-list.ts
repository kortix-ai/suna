import { composioConnectedAccountId, composioConnectionIsNoAuth } from './db-deps-rows';
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
    ...connectorState(candidate, connectedSlugs),
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

/**
 * The one state every client shows, so the web, the CLI and an agent never
 * derive it three ways. `status` and `secretSet` stay for older clients.
 */
export function connectorState(
  candidate: Pick<AdminConnectorCandidate, 'slug' | 'status' | 'requiresAuth' | 'lastError'>,
  connectedSlugs: ReadonlySet<string>,
): Pick<AdminConnectorView, 'state' | 'state_reason' | 'auth_needed'> {
  const auth_needed = candidate.requiresAuth;
  if (candidate.status === 'disabled') return { state: 'disabled', state_reason: 'disabled in kortix.yaml', auth_needed };
  // Before `error`: a server that needs a sign-in fails to list its tools
  // until one exists, and the fix for that is an account, not a repair.
  if (auth_needed && !connectedSlugs.has(candidate.slug)) {
    return { state: 'needs_account', state_reason: 'no account connected', auth_needed };
  }
  if (candidate.status === 'error') {
    return { state: 'error', state_reason: safeConnectorLastError(candidate.lastError) ?? 'its tools could not be loaded', auth_needed };
  }
  return { state: 'connected', state_reason: null, auth_needed };
}

/**
 * The Composio connectors with a signed-in account the caller may use: an
 * account that holds a Composio connected account, or a no-auth toolkit. The
 * gateway's own test (`connectorConnected`). The default row sync creates for
 * every connector is not an account until it is authorized, so a connector
 * with only that row needs an account.
 */
export function signedInComposioSlugs(
  rows: ReadonlyArray<{ slug: string; connectorId: string }>,
  entitled: ReadonlyMap<string, ReadonlyArray<{ metadata: Record<string, unknown> | null }>>,
): Set<string> {
  return new Set(
    rows
      .filter((row) =>
        (entitled.get(row.connectorId) ?? []).some(
          (c) => composioConnectionIsNoAuth(c.metadata) || composioConnectedAccountId(c.metadata) !== null,
        ),
      )
      .map((row) => row.slug),
  );
}
