/**
 * The connector router's contract: the principal a call runs as, the catalog
 * and admin views it returns, and `ConnectorRouterDeps`, the dependencies it
 * is built against. Types only, so services (db-deps.ts and its siblings) can
 * implement them without importing the HTTP layer.
 */
import type { CatalogTools } from './catalog-tools';
import type { ConnectorCatalogKind, ConnectorSurfaceVariant } from './connector-catalog';
import type { UpdateConnectionCredentialInput } from '@kortix/api-contract';
import type { AgentGrant } from '@kortix/db';
import type { ConnectorRouterAuth } from './http-principal';
import type { FeatureFlagKey } from '../feature-flags/registry';
import type { ConnectorConnectOwner } from '../projects/lib/connection-access';
import type { ConnectorAttachmentStore } from './attachments';
import type { ConnectorAuthDiscovery } from './auth-discovery';
import type { ConnectorAuth } from './call';
import type { GatewayDeps } from './gateway';
import type { PolicyArgCondition } from './policy';
export interface ConnectorPrincipal {
  userId: string;
  accountId: string;
  projectId: string;
  sessionId: string | null;
  /** The presented account token's id, when the caller used one. With
   *  `sessionId`, identifies the agent session a Kortix App assertion names. */
  tokenId?: string | null;
  /** The acting identity resolved to its group memberships. */
  subject: { userId: string; groupIds: string[] };
  /** Per-agent grant from the session token — restricts which connectors this
   *  agent may call. Null = no restriction (non-agent token). */
  agentGrant?: AgentGrant | null;
  /** Canonical slugs of the channel connector(s) that CREATED this session
   *  (Slack/Teams/email). Always reachable, whatever the grant says — see
   *  `principalMayUseConnector`. Empty for a session no channel created. */
  channelConnectorSlugs?: string[];
  /**
   * The account THIS call asked to run as (`account` in the call body), by
   * connection label or id. A per-request value, carried on the principal
   * because `makeGatewayDeps(p)` is the only seam between the route and
   * connection resolution.
   *
   * Absent means "the default account", which is how every call behaved before
   * a connector could hold more than one reachable account.
   */
  requestedConnectorAccount?: string | null;
  /**
   * Present when the caller is an agent session under the agent-principal
   * model (a governed grant). Personal resources
   * (member-owned accounts, own computers) then key on `onBehalfOfUserId` AND
   * a private session, never on `userId` (the launcher). Absent = legacy.
   */
  agentPrincipal?: { onBehalfOfUserId: string | null; agentId?: string | null } | null;
  /**
   * Resolve a connector's secret as no person: only values shared with the
   * whole project. For unattended reads whose results reach sessions other
   * people open (an app-event check), never a value narrowed to `userId`.
   */
  secretsAsProject?: boolean;
}

interface CatalogAction {
  path: string; // connector-relative
  name: string;
  description: string;
  risk: string;
  /** What the tool likely does, for grouping (`likelyToolRisk`): an
   *  un-annotated MCP tool's stored `write` is a fallback, so its name decides.
   *  The admin list only; the gateway enforces `risk`. */
  likely_risk?: 'read' | 'write' | 'unknown';
  inputSchema: Record<string, unknown> | null;
  /** JSON Schema of the call's `output`; only with `includeOutputSchemas`. */
  outputSchema?: Record<string, unknown> | null;
}
/** One account a connector can run as, as surfaced in the catalog. See {@link CatalogConnector.accounts}. */
export interface CatalogAccount {
  connection_id: string;
  label: string;
  owner_type: string;
  is_default: boolean;
}
import type { RulesMatrix } from './agent-rules-matrix';

export interface CatalogConnector {
  slug: string;
  name: string;
  provider: string;
  /** Channel provider only: native platform backing this connection. */
  platform?: string | null;
  iconUrl?: string | null;
  status: string;
  actions: CatalogAction[];
  /**
   * The accounts THIS principal may run this connector as, default first.
   *
   * One connector can hold the project's shared account and each member's own
   * — this is the signal that tells a caller (human or agent) more than one
   * account exists, without a separate round trip. Undefined only for a fake
   * `ConnectorRouterDeps.listCatalog` that predates this field.
   */
  accounts?: CatalogAccount[];
  /** Label of the account an unnamed call resolves to, or null if none. */
  default_account?: string | null;
  /** The policy set the caller's agent runs under on this connector
   *  (`agents.<a>.policy_sets`). Absent = the base rules. `actions` already
   *  omits what the set blocks. */
  policy_set?: string;
}

export interface AdminConnectorView extends CatalogConnector {
  authSecret: string | null;
  /** Project secret identifier used as the connector credential source. */
  secretIdentifier: string | null;
  /** Credential location. No credential value is returned. */
  credentialSource: 'none' | 'stored' | 'project_secret' | 'platform';
  /** Credential storage mode. Always `shared` — `per_user` (each member's
   *  own) was removed 2026-07-05. */
  credentialMode: 'shared';
  /**
   * @deprecated A DERIVED SUMMARY, not a setting: `user` when this connector's
   * live accounts are member-owned only, `project` otherwise. The PUT that used
   * to set it is an inert no-op. Kept on the wire for older clients.
   */
  authorizationStrategy: 'project' | 'user';
  /** Authentication shape required when a member adds a private credential. */
  requestAuthType: ConnectorAuth['type'];
  /** Marked sensitive — its reads gate too (require_approval by default). */
  sensitive: boolean;
  /** Whether the shared credential is set. */
  secretSet: boolean;
  /**
   * Why the last attempt to load this connector's tools failed, or null.
   * Meaningful when `status` is `error`. Passed through
   * `safeConnectorLastError`: no URL query, credential, or bearer value.
   */
  lastError: string | null;
  /** The one state to show: `disabled`, `error` (its tools could not be
   *  loaded), `needs_account` (it needs an account and has none the caller can
   *  use) or `connected`. Derived from `status`, `secretSet` and `lastError`. */
  state: 'disabled' | 'error' | 'needs_account' | 'connected';
  /** Why, in a few words, for every state but `connected`. */
  state_reason: string | null;
  /** False: the connector runs with no account (a public server). */
  auth_needed: boolean;
}

export interface SyncResult {
  synced: number;
  errors: Array<{ slug: string; error: string }>;
}

export type CrudOutcome =
  | { ok: true; sync?: SyncResult }
  // `body` overrides the default `{ error }` envelope when the failure carries a
  // machine-readable contract (today: the `feature_disabled` 403).
  | { ok: false; error: string; status: number; body?: Record<string, unknown> };

type PolicyAction = 'always_run' | 'require_approval' | 'block';
export type DefaultMode = 'risk' | 'allow_all';


export interface ProjectPolicyView {
  match: string;
  action: PolicyAction;
  /** Optional ARGUMENT conditions — ALL must hold for the rule to apply. Lets a
   *  rule say "only to these recipients", which a tool-name pattern cannot. */
  conditions?: PolicyArgCondition[] | null;
}

export interface ProjectPoliciesViewResponse {
  policies: ProjectPolicyView[];
  defaultMode: DefaultMode;
  errors: Array<{ path: string; error: string }>;
  /** Per-connector rule counts from the same manifest — the parent `policy ls`
   *  view must reflect a rule `policy <slug> set` just wrote (KRTX-2527). */
  connectorRules?: Array<{ slug: string; count: number }>;
}

export interface ListCatalogOptions {
  /** Restrict to one connector (by slug, canonicalized). */
  slug?: string;
  /**
   * Include the full per-action JSON Schema. Default false — the dominant
   * contributor to this route's payload (measured on prod: 439KB body,
   * n=97 db queries for a bulk listing) and no bulk-listing caller reads it.
   * `describeConnectorTool` (the one caller that needs a schema) passes
   * `slug` + `true` together instead of fetching the whole catalog.
   */
  includeSchemas?: boolean;
  /**
   * Add each action's stored `outputSchema` (null when the connector publishes
   * none: managed Composio and Pipedream). Default false, so the sandbox
   * catalog payload does not grow; `kortix connectors types` sets it.
   */
  includeOutputSchemas?: boolean;
}

/** The router's dependencies: its request authorizers (`ConnectorRouterAuth`,
 *  `http-principal.ts`) and the services behind its routes. */
export interface ConnectorRouterDeps extends ConnectorRouterAuth {
  /** Build the DB-backed (or fake) gateway deps for a principal. */
  makeGatewayDeps(p: ConnectorPrincipal): GatewayDeps;
  /** The catalog the principal can actually use (agent-grant filtered, blocked hidden). */
  listCatalog(p: ConnectorPrincipal, options?: ListCatalogOptions): Promise<CatalogConnector[]>;
  /** Private raw-byte staging used by the MCP attachment transport. */
  attachmentStore?: ConnectorAttachmentStore;
  /**
   * Per-project feature-flag state. Injected (not imported) so this router
   * stays free of the DB import graph and the in-memory e2e keeps driving the
   * real HTTP layer. Required, not optional: a new deps implementation must
   * decide what the gated routes see rather than silently opening them.
   */
  featureFlagEnabled(projectId: string, key: FeatureFlagKey): Promise<boolean>;
  /**
   * `actingUserId`: whose own credentialed accounts count toward "connected"
   * for a connector with no project-wide shared credential (connection-access.ts
   * — reachability is per-row, not per-connector). Omit only when there is no
   * human caller to ask.
   */
  listConnectors(
    projectId: string,
    actingUserId?: string | null,
    options?: { includeSchemas?: boolean },
  ): Promise<AdminConnectorView[]>;
  syncConnectors(projectId: string, accountId: string): Promise<SyncResult>;
  /** Create/update a connector in kortix.yaml + materialize. */
  createConnector?(
    projectId: string,
    accountId: string,
    draft: Record<string, unknown>,
    actorUserId?: string,
  ): Promise<CrudOutcome>;
  discoverConnectorAuth?(
    projectId: string,
    draft: Record<string, unknown>,
  ): Promise<ConnectorAuthDiscovery>;
  /** Remove a connector from kortix.yaml + drop its rows. */
  deleteConnector?(projectId: string, slug: string): Promise<CrudOutcome>;
  /** Set a connector's server-side static or OAuth2 credential. */
  setConnectorCredential?(
    projectId: string,
    slug: string,
    input: UpdateConnectionCredentialInput,
  ): Promise<CrudOutcome & { account?: string | null; oauth2ExpiresAt?: number }>;
  /** Bind or unbind a brokered project secret as the connector credential. */
  setConnectorSecretBinding?(
    projectId: string,
    slug: string,
    secretIdentifier: string | null,
  ): Promise<CrudOutcome>;
  /** `userId` is accepted for back-compat but unused — a connector has exactly
   *  one (shared) credential since `per_user` was removed 2026-07-05. */
  deleteConnectorCredential?(projectId: string, slug: string, userId: string): Promise<CrudOutcome>;
  /** `shared` is the only credential mode (`per_user` removed 2026-07-05). This
   *  route is kept as a restricted no-op for back-compat callers — the router
   *  rejects any `mode` other than `shared` before calling this. */
  setCredentialMode?(
    projectId: string,
    accountId: string,
    slug: string,
    mode: 'shared',
  ): Promise<CrudOutcome>;
  /** @deprecated Retired. Its route is an inert 200 no-op and never calls this. */
  setAuthorizationStrategy?(
    projectId: string,
    accountId: string,
    slug: string,
    authorizationStrategy: 'project' | 'user',
  ): Promise<CrudOutcome>;
  /** Toggle a connector's `sensitive` flag (gate reads too) in kortix.yaml + re-sync. */
  setSensitive?(
    projectId: string,
    accountId: string,
    slug: string,
    sensitive: boolean,
  ): Promise<CrudOutcome>;
  /** Rename a connector (display label) in kortix.yaml + re-sync. */
  setConnectorName?(
    projectId: string,
    accountId: string,
    slug: string,
    name: string,
  ): Promise<CrudOutcome>;
  /** Read a connector's [[connectors.policies]] (per-tool/per-pattern permissions). */
  getConnectorPolicies?(
    projectId: string,
    slug: string,
    policySet?: string | null,
  ): Promise<
    | { policies: Array<{ match: string; action: string }>; policy_set?: string }
    | { error: string; code: 'policy_set_not_found' }
    | null
  >;
  /** List a connector's policy sets (`connectors[].policy_sets`) with the agents using each. */
  listConnectorPolicySets?(
    projectId: string,
    slug: string,
  ): Promise<{
    sets: Array<{ name: string; description: string | null; policies: Array<{ match: string; action: string }>; agents: string[] }>;
  } | null>;
  /** Create a policy set, or change its description, in kortix.yaml + re-sync. */
  upsertConnectorPolicySet?(
    projectId: string,
    accountId: string,
    slug: string,
    name: string,
    description: string | null | undefined,
    /** Replace the set's rules in the same commit (a template). */
    policies?: Array<{ match: string; action: PolicyAction }>,
  ): Promise<CrudOutcome & { created?: boolean }>;
  /** Rename a policy set and every agent reference to it, in one commit. */
  renameConnectorPolicySet?(
    projectId: string,
    accountId: string,
    slug: string,
    from: string,
    to: string,
  ): Promise<CrudOutcome>;
  /** Every declared agent × every connector: granted and its rule set (`agent-rules-matrix.ts`). */
  getRulesMatrix?(projectId: string): Promise<RulesMatrix | null>;
  /** Delete a policy set; 409 `policy_set_in_use` while an agent uses it. */
  deleteConnectorPolicySet?(
    projectId: string,
    accountId: string,
    slug: string,
    name: string,
  ): Promise<CrudOutcome>;
  /** Read a connector's definition (provider + connection fields) from kortix.yaml for editing. */
  getConnectorConfig?(
    projectId: string,
    slug: string,
  ): Promise<{
    slug: string;
    name: string;
    provider: string;
    platform?: string | null;
    credentialMode: 'shared';
    authorizationStrategy: 'project' | 'user';
    app: string | null;
    account: string | null;
    url: string | null;
    transport: 'http' | 'sse' | null;
    endpoint: string | null;
    baseUrl: string | null;
    spec: string | null;
    auth: {
      type:
        | 'none'
        | 'bearer'
        | 'basic'
        | 'custom'
        | 'api_key'
        | 'oauth1'
        | 'hmac'
        | 'aws_sigv4'
        | 'mtls';
      in: 'header' | 'query' | 'cookie';
      name: string | null;
      prefix: string | null;
    };
  } | null>;
  /** Replace a connector's `policies:` list in kortix.yaml + re-sync. */
  setConnectorPolicies?(
    projectId: string,
    accountId: string,
    slug: string,
    policies: Array<{ match: string; action: string }>,
    policySet?: string | null,
  ): Promise<CrudOutcome>;
  /** Pipedream 1-click: mint a connect token (for the frontend SDK overlay) + link.
   *  null = not pipedream. `userId` is accepted for back-compat but unused —
   *  the connection is always the shared project account (`per_user` removed
   *  2026-07-05). */
  pipedreamConnect?(
    projectId: string,
    slug: string,
    userId: string,
    redirects?: { success?: string; error?: string },
  ): Promise<{ token?: string; app?: string; connectUrl?: string } | null>;
  /** Pipedream 1-click: after the user finishes, persist the shared account binding. */
  pipedreamFinalize?(
    projectId: string,
    slug: string,
    userId: string,
  ): Promise<{ connected: boolean; accountId?: string } | null>;
  /**
   * The accounts this principal may run a connector as, default first.
   *
   * One connector can hold the project's shared account and each member's own.
   * The CLI prints this so a human can see what exists and name one; the call
   * denial uses it to say which names WERE available when a named account did
   * not match.
   */
  listConnectorAccounts?(input: {
    projectId: string;
    slug: string;
    userId: string;
    sessionId: string | null;
    agentPrincipal?: { onBehalfOfUserId: string | null; agentId?: string | null } | null;
  }): Promise<
    Array<{
      connection_id: string;
      label: string;
      owner_type: string;
      is_default: boolean;
      /** Who the account was authorized as. `null` when unknown. */
      connected_as?: string | null;
      /** When the upstream first answered 401 to this account's stored
       *  credential (a repeat 401 keeps the first time); cleared by a new
       *  credential or an ok call. */
      credential_rejected_at?: string | null;
      /** Shopify: what the account's token could read when it connected
       *  (catalog / orders / customers / inventory: ok | blocked | missing_scope | error). */
      access?: import('./shopify').ShopifyAccess | null;
    }>
  >;
  /**
   * A hosted authorization link for a connector with no connected account, or
   * null when this connector has no hosted page (a raw HTTP/MCP connector whose
   * credential someone has to paste, or a deployment with no link provider).
   *
   * Used by the call denial so `connector_not_connected` carries its own
   * remedy. Never throws: a link we cannot mint degrades to the plain hint.
   */
  mintConnectorConnectLink?(input: {
    projectId: string;
    slug: string;
    userId: string;
    sessionId: string | null;
  }): Promise<string | null>;
  /** Provider-neutral connect routes. Prefer Composio when wired; keep Pipedream path intact. */
  connectorConnect?(
    projectId: string,
    slug: string,
    userId: string,
    redirects?: { success?: string; error?: string },
    /** The session whose agent asked for this connector, when a session token made
     *  the call. Persisted on the connection so finalize can tell that agent the
     *  account landed instead of it re-minting a link on its next run. */
    requestingSessionId?: string | null,
    /** Whose account this authorization lands on. Defaults to `me`. */
    owner?: ConnectorConnectOwner,
  ): Promise<{
    provider: string;
    token?: string;
    app?: string;
    connectUrl?: string;
    requestId?: string;
    sessionId?: string;
    connectionId?: string;
    connected?: boolean;
    isNoAuth?: boolean;
  } | null>;
  connectorFinalize?(
    projectId: string,
    slug: string,
    userId: string,
    selector?: { connectionId?: string; requestId?: string },
    /** Whose account the matching connect started on. Defaults to `me`. */
    owner?: ConnectorConnectOwner,
  ): Promise<{
    provider: string;
    connected: boolean;
    accountId?: string;
    connectionId?: string;
    isNoAuth?: boolean;
    /** The authorized identity (an email, login, or name). `null` when unknown. */
    connectedAs?: string | null;
    /** The connection's label after finalize. A generic default becomes `connectedAs`. */
    label?: string;
  } | null>;
  /** Connectors this session's agent asked a human to authorize, and whether
   *  each is connected yet. Drives the in-session Connect button. */
  listSessionConnectRequests?(
    projectId: string,
    sessionId: string,
  ): Promise<Array<{ slug: string; app: string; provider: string; connected: boolean }>>;
  connectStatus?(): Promise<{ configured: boolean; provider: string | null; providers?: string[] }>;
  /** API/MCP catalogue id by app join key, for the managed listings' `directId`. */
  catalogDirectIds?(): Promise<ReadonlyMap<string, string>>;
  /** Hosted MCP server URL by app join key, for the managed listings' `directMcpUrl`. */
  catalogDirectMcpUrls?(): Promise<ReadonlyMap<string, string>>;
  listConnectToolkits?(
    projectId: string,
    input: { q?: string; category?: string; cursor?: string; limit?: number },
  ): Promise<unknown | null>;
  /** The easy-connect browse page: a fixed top slice of each of the largest
   *  categories, each with the category's true total. `null` = no provider. */
  listConnectSections?(
    projectId: string,
    input: { perCategory?: number; maxCategories?: number },
  ): Promise<unknown | null>;
  /**
   * Pipedream webhook: verify sig + finalize. `ok:false` = the signature (or the
   * connector/authorization binding the id names) did not check out → 401.
   * `ok:true, connected:false` = the signature was good but Pipedream still
   * reports no account for that external user id → 503, never a silent 200.
   */
  pipedreamWebhook?(
    externalUserId: string,
    sig: string | null,
  ): Promise<{ ok: boolean; connected: boolean }>;
  /**
   * The public connect form (`app-form.ts`): the native Shopify sign-in and
   * Composio's own-app form. No user auth: the sealed token is the capability.
   */
  appForm?: {
    info(token: string): Promise<import('./app-form').AppFormInfo>;
    submit(
      token: string,
      body: { store?: unknown; client_id?: unknown; client_secret?: unknown },
    ): Promise<import('./app-form').AppFormResult>;
  };
  /** Shopify's OAuth callback (`shopify-connect.ts`): a redirect or a 400 text. */
  shopifyCallback?(
    requestUrl: string,
  ): Promise<{ status: 302; location: string } | { status: 400; body: string }>;
  /**
   * A page of the Pipedream catalogue, filtered by query and/or category.
   *
   * Category filtering is served from a server-side snapshot of the whole
   * catalogue — Pipedream's own `/apps` endpoint accepts a category parameter
   * and ignores it, so it cannot answer this. `indexReady: false` means the
   * snapshot is still building and `category` was ignored for this page.
   */
  listPipedreamApps?(input: {
    q?: string;
    category?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{
    apps: Array<{
      slug: string;
      name: string;
      description: string | null;
      imgSrc: string | null;
      authType: string | null;
      categories: string[];
      hasActions: boolean;
      hasTriggers: boolean;
      featuredWeight: number;
    }>;
    categories: Array<{ key: string; label: string; count: number }>;
    total: number;
    nextCursor?: string;
    hasMore: boolean;
    indexReady: boolean;
    excludedNoActions: number;
  }>;

  /** The browse page: a fixed top slice of each of the largest categories,
   *  each with the category's true total, in one request. */
  listPipedreamSections?(input: { perCategory?: number; maxCategories?: number }): Promise<{
    sections: Array<{ key: string; label: string; total: number; apps: unknown[] }>;
    categories: Array<{ key: string; label: string; count: number }>;
    indexReady: boolean;
  }>;
  /** Browse the Discover catalogue: Kortix's apps, integrations.sh and the
   *  managed toolkits as one (`mcp-apps.ts`). */
  listDiscoverConnectors?(input: {
    q?: string;
    cursor?: string;
    /** A browse-section key from `listDiscoverSections`. */
    category?: string;
    limit?: number;
    /** Only the apps that connect with nothing to set up. */
    oneClick?: boolean;
    kinds?: readonly ConnectorCatalogKind[];
    /** App ids the project cannot use yet, left out before counting. */
    exclude?: ReadonlySet<string>;
  }): Promise<unknown>;
  /** The Discover browse page: Popular plus a fixed top slice of each
   *  section, each with the section's true total across the whole catalogue. */
  listDiscoverSections?(input: {
    perCategory?: number;
    maxCategories?: number;
    oneClick?: boolean;
    kinds?: readonly ConnectorCatalogKind[];
    /** App ids the project cannot use yet, left out before counting. */
    exclude?: ReadonlySet<string>;
  }): Promise<unknown>;
  /** Resolve every known surface for one trusted catalogue record. */
  getDiscoverConnector?(id: string): Promise<unknown>;
  /** Every profile's slug and the way in it is (`connectorIdentity`): install
   *  answers an existing profile and the catalogue marks `installed`. */
  listConnectorIdentities?(projectId: string): Promise<Array<{ slug: string; identity: string | null }>>;
  /** The web page where a person reviews and adds a custom server an agent asked for. */
  customConnectorSetupUrl?(projectId: string, draft: Record<string, unknown>): string;
  /** The tools one way to connect offers, before install (`catalog-tools.ts`). */
  discoverConnectorTools?(variant: ConnectorSurfaceVariant): Promise<CatalogTools>;
  /** Read project-level `policies:` list + `policy.default_mode` from kortix.yaml. */
  getProjectPolicies?(projectId: string): Promise<ProjectPoliciesViewResponse | null>;
  /** Replace project policies + default_mode (CRUD round-trips to kortix.yaml). */
  setProjectPolicies?(
    projectId: string,
    accountId: string,
    policies: ProjectPolicyView[],
    defaultMode: DefaultMode,
  ): Promise<CrudOutcome>;
}
