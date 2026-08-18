import type { UpdateConnectionCredentialInput } from '@kortix/api-contract';
import { connectors, projects, projectSessionConnectorBindings } from '@kortix/db';
/**
 * Connector CRUD that round-trips `kortix.yaml` — the web UI "Add connector"
 * flow (mirrors triggers). The manifest holds the connector definition.
 * Credential MODE is always `shared` (`per_user` — each member brings their
 * own — was removed 2026-07-05, docs/specs/2026-07-05-agent-first-config-
 * unification.md §2.5). Connectors are project-wide visible — the only ACCESS
 * gate is the agent-side `agents.<name>.connectors` grant (declared in git, on
 * the agent, not the connector). Credentials live in the split store. See
 * docs/specs/connector.md §3, §5–6.
 */
import { and, eq } from 'drizzle-orm';
import { featureDisabledBody } from '../feature-flags/gate';
import { resolveFeatureFlag } from '../feature-flags/registry';
import {
  type ConnectorAuthorizationStrategy,
  type ConnectorPolicyAction,
  type ConnectorPolicySpec,
  type ConnectorSpec,
  RESERVED_CONNECTOR_SLUGS,
  RESERVED_SLUG_PROVIDERS,
  extractConnectors,
} from '../projects/connectors';
import { loadManifestForEdit } from '../projects/index';
import { withProjectGitAuth } from '../projects/lib/git';
import {
  type DefaultMode,
  type ProjectPolicySpec,
  extractProjectPolicies,
  projectPoliciesToTomlEntries,
  projectPolicySettingsToToml,
} from '../projects/policies';
import { db } from '../shared/db';
import { upsertCredential, upsertOAuth2Credential } from './credentials';
import { areValidConditions, isValidMatcher } from './policy';
import {
  rematerializeCatalogAfterCredentialUpdate,
  type SyncResult,
  syncProjectConnectors,
} from './sync';
import {
  type ManifestMutationResult,
  mutateManifestWithRetry,
} from './manifest-mutation';

export interface ConnectorDraft {
  slug: string;
  name?: string;
  provider: 'pipedream' | 'mcp' | 'openapi' | 'postman' | 'graphql' | 'http' | 'channel';
  /** Refuse to update an existing slug. */
  create_only?: boolean;
  platform?: 'slack' | 'email';
  app?: string;
  account?: string;
  url?: string;
  transport?: 'http' | 'sse';
  endpoint?: string;
  baseUrl?: string;
  spec?: string;
  /** Credential storage mode. `shared` is the only mode (`per_user` was
   *  removed 2026-07-05) — accepted for back-compat callers but never emitted
   *  into the manifest, since `shared` is already the implicit default. */
  credential?: 'shared';
  /** Exclusive owner model for connections under this connector. */
  authorization_strategy?: ConnectorAuthorizationStrategy;
  auth?: {
    type?:
      | 'none'
      | 'bearer'
      | 'basic'
      | 'custom'
      | 'api_key'
      | 'oauth1'
      | 'hmac'
      | 'aws_sigv4'
      | 'mtls';
    in?: 'header' | 'query' | 'cookie';
    name?: string;
    prefix?: string;
  };
  /** Static request headers sent on every call — an ordered map of header name
   *  → value (`{ Accept: 'application/json', 'X-Tenant-Id': 'acme' }`).
   *  NOT secrets: they are committed to kortix.yaml in plaintext, exactly like
   *  `baseUrl`. Names must be RFC 7230 tokens and values may not contain CR/LF;
   *  a header that collides with the auth header never overrides it. */
  headers?: Record<string, string>;
}

export type CrudResult =
  | { ok: true; sync?: SyncResult }
  // `body` overrides the default `{ error }` envelope when the failure has a
  // machine-readable contract (today: the `feature_disabled` 403).
  | { ok: false; error: string; status: number; body?: Record<string, unknown> };

function draftToEntry(d: ConnectorDraft): Record<string, unknown> {
  const entry: Record<string, unknown> = { slug: d.slug, provider: d.provider };
  if (d.name) entry.name = d.name;
  if (d.authorization_strategy) {
    entry.authorization_strategy = d.authorization_strategy;
  }
  // `shared` is the only mode and the implicit default — never emit `credential`.
  if (d.provider === 'pipedream') {
    if (d.app) entry.app = d.app;
    if (d.account) entry.account = d.account;
  } else if (d.provider === 'mcp') {
    if (d.url) entry.url = d.url;
    if (d.transport) entry.transport = d.transport;
  } else if (d.provider === 'graphql') {
    if (d.endpoint) entry.endpoint = d.endpoint;
    if (d.spec) entry.spec = d.spec;
  } else if (d.provider === 'http') {
    if (d.baseUrl) entry.base_url = d.baseUrl;
    if (d.spec) entry.spec = d.spec;
  } else if (d.provider === 'openapi' || d.provider === 'postman') {
    if (d.spec) entry.spec = d.spec;
  } else if (d.provider === 'channel') {
    if (d.platform) entry.platform = d.platform;
  }
  // Omitted means auto-detect; explicit none must remain a durable opt-out.
  if (d.auth && d.auth.type) {
    const auth: Record<string, unknown> = { type: d.auth.type };
    if (d.auth.type === 'custom' || d.auth.type === 'api_key' || d.auth.type === 'hmac') {
      if (d.auth.in && d.auth.in !== 'header') auth.in = d.auth.in;
      if (d.auth.name) auth.name = d.auth.name;
    }
    if (d.auth.prefix) auth.prefix = d.auth.prefix;
    entry.auth = auth;
  }
  // Validated by the parser (extractConnectors) right after this entry is
  // written, so a bad name/value fails the request with the parser's message
  // instead of committing an unusable manifest. Omit when empty so the
  // manifest stays minimal (same rule as `sensitive`).
  if (d.headers && Object.keys(d.headers).length > 0) entry.headers = { ...d.headers };
  return entry;
}

/** Build the manifest entry for an upsert without dropping fields owned by
 * other connector-connection controls. */
export function mergeConnectorDraftEntry(
  draft: ConnectorDraft,
  previous?: Record<string, unknown>,
): Record<string, unknown> {
  const entry = draftToEntry(draft);
  if (!previous) return entry;
  if (previous.policies !== undefined) entry.policies = previous.policies;
  if (draft.headers === undefined && previous.headers !== undefined) {
    entry.headers = previous.headers;
  }
  if (draft.authorization_strategy === undefined && previous.authorization_strategy !== undefined) {
    entry.authorization_strategy = previous.authorization_strategy;
  }
  if (previous.enabled !== undefined) entry.enabled = previous.enabled;
  if (entry.name === undefined && previous.name !== undefined) entry.name = previous.name;
  return entry;
}

async function loadRow(projectId: string) {
  const [row] = await db.select().from(projects).where(eq(projects.projectId, projectId)).limit(1);
  return row ?? null;
}

async function connectorIdFor(projectId: string, slug: string): Promise<string | null> {
  const [row] = await db
    .select({ connectorId: connectors.connectorId })
    .from(connectors)
    .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, slug)))
    .limit(1);
  return row?.connectorId ?? null;
}

/** Create/update a connector in kortix.yaml, then materialize it. */
export async function upsertConnectorInManifest(
  projectId: string,
  accountId: string,
  draft: ConnectorDraft,
): Promise<CrudResult> {
  // Slack is a first-class channel connector — reserve its namespace so a new
  // Pipedream/OpenAPI app can't take the `slack` name (and shadow the built-in
  // Slack CLI). Connect Slack in the Channels tab; it appears as a connector
  // automatically. Only block NEW slugs — editing an existing entry is fine.
  const reservedProvider = RESERVED_SLUG_PROVIDERS[draft.slug];
  if (
    RESERVED_CONNECTOR_SLUGS.has(draft.slug) &&
    (await connectorIdFor(projectId, draft.slug)) === null &&
    reservedProvider !== draft.provider
  ) {
    return {
      ok: false,
      error:
        draft.slug === 'slack' || draft.slug === 'kortix_slack'
          ? `"${draft.slug}" is the built-in Slack channel — run \`kortix channels connect\` for a one-click install link instead of adding a connector. Once installed it appears here as \`kortix_slack\` automatically.`
          : `"${draft.slug}" is reserved for a built-in channel connection. Pick a different slug.`,
      status: 400,
    };
  }

  const row = await loadRow(projectId);
  if (!row) return { ok: false, error: 'project not found', status: 404 };
  if (
    draft.provider === 'channel' &&
    draft.platform === 'email' &&
    !resolveFeatureFlag(row.metadata, 'agentmail_email')
  ) {
    const disabled = featureDisabledBody('agentmail_email');
    return { ok: false, error: disabled.error, status: 403, body: disabled };
  }

  let gitProject: Awaited<ReturnType<typeof withProjectGitAuth>>;
  try {
    gitProject = await withProjectGitAuth(row);
  } catch (e) {
    return { ok: false, error: (e as Error).message || 'failed to read manifest', status: 400 };
  }

  const result = await upsertConnectorInManifestWithRetry(gitProject, draft);
  if (!result.ok) return result;

  const sync = await syncProjectConnectors(projectId, accountId);
  return { ok: true, sync };
}

type EditableManifest = Awaited<ReturnType<typeof loadManifestForEdit>>;

async function mutateProjectConnectorManifest(
  projectId: string,
  accountId: string,
  operation: string,
  mutate: (manifest: EditableManifest) => ManifestMutationResult,
): Promise<CrudResult> {
  const row = await loadRow(projectId);
  if (!row) return { ok: false, error: 'project not found', status: 404 };
  const result = await mutateManifestWithRetry(row, operation, mutate);
  if (!result.ok) return result;
  const sync = await syncProjectConnectors(projectId, accountId);
  return { ok: true, sync };
}

async function upsertConnectorInManifestWithRetry(
  project: Awaited<ReturnType<typeof withProjectGitAuth>>,
  draft: ConnectorDraft,
): Promise<CrudResult> {
  return mutateManifestWithRetry(
    project,
    `the connector ${draft.slug} was being updated`,
    (manifest) => {
      const current = Array.isArray(manifest.raw.connectors)
        ? (manifest.raw.connectors as Record<string, unknown>[])
        : [];
      const idx = current.findIndex((candidate) => candidate?.slug === draft.slug);
      if (idx >= 0 && draft.create_only === true) {
        return {
          ok: false,
          error: `Connector slug "${draft.slug}" already exists`,
          status: 409,
        };
      }
      const entry = mergeConnectorDraftEntry(draft, idx >= 0 ? current[idx] : undefined);
      if (idx >= 0) current[idx] = entry;
      else current.push(entry);
      manifest.raw.connectors = current;

      const error = extractConnectors(manifest).errors.find(
        (candidate) => candidate.slug === draft.slug,
      );
      if (error) return { ok: false, error: error.error, status: 400 };
      return {
        ok: true,
        commitMessage: `chore: ${idx >= 0 ? 'update' : 'add'} connector ${draft.slug}`,
      };
    },
  );
}

export async function deleteConnectorFromManifest(
  projectId: string,
  slug: string,
): Promise<CrudResult> {
  const row = await loadRow(projectId);
  if (!row) return { ok: false, error: 'project not found', status: 404 };

  const result = await mutateManifestWithRetry(
    row,
    `the connector ${slug} was being deleted`,
    (manifest) => {
      const current = Array.isArray(manifest.raw.connectors)
        ? (manifest.raw.connectors as Record<string, unknown>[])
        : [];
      const next = current.filter((candidate) => candidate?.slug !== slug);
      if (next.length === current.length) return { ok: true, commitMessage: null };
      manifest.raw.connectors = next;
      return { ok: true, commitMessage: `chore: delete connector ${slug}` };
    },
  );
  if (!result.ok) return result;
  await db.transaction(async (tx) => {
    // Bindings intentionally restrict connector deletion so a session cannot
    // silently retain a dangling selection. Removing the connector is an
    // explicit project mutation, so remove its durable session selections in
    // the same database transaction before the connector cascade runs.
    await tx
      .delete(projectSessionConnectorBindings)
      .where(
        and(
          eq(projectSessionConnectorBindings.projectId, projectId),
          eq(projectSessionConnectorBindings.connectorAlias, slug),
        ),
      );
    await tx
      .delete(connectors)
      .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, slug)));
  });
  return { ok: true };
}

/** Set a project-owned connection credential. */
export async function setConnectorCredentialShared(
  projectId: string,
  slug: string,
  input: UpdateConnectionCredentialInput,
): Promise<CrudResult> {
  const [connector] = await db
    .select({
      connectorId: connectors.connectorId,
      accountId: connectors.accountId,
      providerType: connectors.providerType,
      authorizationStrategy: connectors.authorizationStrategy,
      authSecret: connectors.authSecret,
    })
    .from(connectors)
    .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, slug)))
    .limit(1);
  if (!connector) return { ok: false, error: 'connector not found', status: 404 };
  if (connector.authorizationStrategy !== 'project') {
    return {
      ok: false,
      error: 'Shared credentials require a project authorization strategy',
      status: 409,
    };
  }
  if (connector.authSecret) {
    return {
      ok: false,
      error: 'Clear the project secret binding before storing a connector credential',
      status: 409,
    };
  }
  if ('oauth2' in input) {
    await upsertOAuth2Credential({
      projectId,
      connectorId: connector.connectorId,
      userId: null,
      oauth2: input.oauth2,
    });
  } else {
    await upsertCredential({
      projectId,
      connectorId: connector.connectorId,
      userId: null,
      value: input.value,
      kind: input.kind,
    });
  }
  const sync = await rematerializeCatalogAfterCredentialUpdate({
    projectId,
    accountId: connector.accountId,
    provider: connector.providerType,
    ownerType: 'project',
    isDefault: true,
  });
  return { ok: true, ...(sync ? { sync } : {}) };
}

/**
 * `shared` is now the only credential mode (`per_user` removed 2026-07-05,
 * docs/specs/2026-07-05-agent-first-config-unification.md §2.5). This entry
 * point is kept, restricted to a `shared`-only no-op: it strips a lingering
 * legacy `credential: per_user` key from kortix.yaml (if present) and
 * re-syncs, but never writes a mode back. Callers asking for anything other
 * than `shared` are rejected by the router before this is called.
 */
export async function setConnectorCredentialModeInManifest(
  projectId: string,
  accountId: string,
  slug: string,
  mode: 'shared',
): Promise<CrudResult> {
  return mutateProjectConnectorManifest(
    projectId,
    accountId,
    `the connector ${slug} credential mode was being updated`,
    (manifest) => {
      const current = Array.isArray(manifest.raw.connectors)
        ? (manifest.raw.connectors as Record<string, unknown>[])
        : [];
      const entry = current.find((candidate) => candidate?.slug === slug);
      if (!entry) return { ok: false, error: 'connector not found', status: 404 };
      delete entry.credential;
      manifest.raw.connectors = current;
      const error = extractConnectors(manifest).errors.find(
        (candidate) => candidate.slug === slug,
      );
      if (error) return { ok: false, error: error.error, status: 400 };
      return { ok: true, commitMessage: `chore: set ${slug} credential mode → ${mode}` };
    },
  );
}

/** Set the exclusive connection owner model for one connector. */
export async function setConnectorAuthorizationStrategyInManifest(
  projectId: string,
  accountId: string,
  slug: string,
  authorizationStrategy: ConnectorAuthorizationStrategy,
): Promise<CrudResult> {
  return mutateProjectConnectorManifest(
    projectId,
    accountId,
    `the connector ${slug} connection strategy was being updated`,
    (manifest) => {
      const current = Array.isArray(manifest.raw.connectors)
        ? (manifest.raw.connectors as Record<string, unknown>[])
        : [];
      const entry = current.find((candidate) => candidate?.slug === slug);
      if (!entry) return { ok: false, error: 'connector not found', status: 404 };
      entry.authorization_strategy = authorizationStrategy;
      manifest.raw.connectors = current;
      const error = extractConnectors(manifest).errors.find(
        (candidate) => candidate.slug === slug,
      );
      if (error) return { ok: false, error: error.error, status: 400 };
      return {
        ok: true,
        commitMessage: `chore: set ${slug} connection strategy to ${authorizationStrategy}`,
      };
    },
  );
}

/**
 * Toggle a connector's `sensitive` flag in kortix.yaml, commit, re-sync. A
 * sensitive connector gates its reads too (every action defaults to
 * require_approval unless an explicit policy opens it) — for email/files/
 * secrets-bearing connectors where reading is itself an exfiltration surface.
 */
export async function setConnectorSensitiveInManifest(
  projectId: string,
  accountId: string,
  slug: string,
  sensitive: boolean,
): Promise<CrudResult> {
  return mutateProjectConnectorManifest(
    projectId,
    accountId,
    `the connector ${slug} sensitivity was being updated`,
    (manifest) => {
      const current = Array.isArray(manifest.raw.connectors)
        ? (manifest.raw.connectors as Record<string, unknown>[])
        : [];
      const entry = current.find((candidate) => candidate?.slug === slug);
      if (!entry) return { ok: false, error: 'connector not found', status: 404 };
      if (sensitive) entry.sensitive = true;
      else delete entry.sensitive;
      manifest.raw.connectors = current;
      const error = extractConnectors(manifest).errors.find(
        (candidate) => candidate.slug === slug,
      );
      if (error) return { ok: false, error: error.error, status: 400 };
      return {
        ok: true,
        commitMessage: `chore: mark ${slug} ${sensitive ? 'sensitive' : 'not sensitive'}`,
      };
    },
  );
}

/** Rename a connector — patches the kortix.yaml entry's `name` (display label) + re-syncs. */
export async function setConnectorNameInManifest(
  projectId: string,
  accountId: string,
  slug: string,
  name: string,
): Promise<CrudResult> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: 'name is required', status: 400 };
  if (trimmed.length > 255) return { ok: false, error: 'name is too long (max 255)', status: 400 };
  return mutateProjectConnectorManifest(
    projectId,
    accountId,
    `the connector ${slug} name was being updated`,
    (manifest) => {
      const current = Array.isArray(manifest.raw.connectors)
        ? (manifest.raw.connectors as Record<string, unknown>[])
        : [];
      const entry = current.find((candidate) => candidate?.slug === slug);
      if (!entry) return { ok: false, error: 'connector not found', status: 404 };
      entry.name = trimmed;
      manifest.raw.connectors = current;
      const error = extractConnectors(manifest).errors.find(
        (candidate) => candidate.slug === slug,
      );
      if (error) return { ok: false, error: error.error, status: 400 };
      return { ok: true, commitMessage: `chore: rename connector ${slug} → ${trimmed}` };
    },
  );
}

// ─── Connector definition (the [[connectors]] entry itself) ─────────────────

/** The editable connection config — same fields the "Add connector" form sets. */
export interface ConnectorConfigView {
  slug: string;
  name: string;
  provider: ConnectorSpec['provider'];
  platform: ConnectorSpec['platform'];
  credentialMode: 'shared';
  authorizationStrategy: ConnectorAuthorizationStrategy;
  app: string | null;
  account: string | null;
  url: string | null;
  transport: 'http' | 'sse' | null;
  endpoint: string | null;
  baseUrl: string | null;
  spec: string | null;
  /** Platform-managed Computers profiles only. Manifest connectors omit it. */
  tunnelIds?: string[];
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
  /** Static request headers (ordered map of name → value); `{}` when none. */
  headers: Record<string, string>;
}

/**
 * Read a single connector's definition from kortix.yaml (source of truth) in the
 * same shape the dashboard edits. Parsed via extractConnectors so it round-trips
 * exactly with the upsert path. Returns null if the connector doesn't exist.
 */
export async function getConnectorConfigFromManifest(
  projectId: string,
  slug: string,
): Promise<ConnectorConfigView | null> {
  const row = await loadRow(projectId);
  if (!row) return null;
  const manifest = await loadManifestForEdit(row).catch(() => null);
  if (!manifest) return null;
  const spec = extractConnectors(manifest).specs.find((s) => s.slug === slug);
  if (!spec) return null;
  return {
    slug: spec.slug,
    name: spec.name,
    provider: spec.provider,
    platform: spec.platform,
    credentialMode: spec.credentialMode,
    authorizationStrategy: spec.authorizationStrategy,
    app: spec.app,
    account: spec.account,
    url: spec.url,
    transport: spec.transport,
    endpoint: spec.endpoint,
    baseUrl: spec.baseUrl,
    spec: spec.spec,
    auth: {
      type: spec.auth.type,
      in: spec.auth.in,
      name: spec.auth.name,
      prefix: spec.auth.prefix,
    },
    headers: { ...spec.headers },
  };
}

// ─── Per-connector policies (each connector's `policies:` list) ─────────────

const CONNECTOR_POLICY_ACTIONS: readonly ConnectorPolicyAction[] = [
  'always_run',
  'require_approval',
  'block',
];

/** Read a single connector's `policies:` list from kortix.yaml (source of truth). */
export async function getConnectorPoliciesFromManifest(
  projectId: string,
  slug: string,
): Promise<{ policies: ConnectorPolicySpec[] } | null> {
  const row = await loadRow(projectId);
  if (!row) return null;
  const manifest = await loadManifestForEdit(row).catch(() => null);
  if (!manifest) return { policies: [] };
  const current = Array.isArray(manifest.raw.connectors)
    ? (manifest.raw.connectors as Record<string, unknown>[])
    : [];
  const entry = current.find((c) => c?.slug === slug);
  if (!entry) return null;
  const raw = Array.isArray(entry.policies) ? (entry.policies as Record<string, unknown>[]) : [];
  const policies = raw
    .filter((p) => p && typeof p.match === 'string')
    .map((p) => ({ match: String(p.match), action: p.action as ConnectorPolicyAction }));
  return { policies };
}

/**
 * Replace a connector's `policies:` list in kortix.yaml, commit, re-sync
 * (→ connector_policies, which the gateway enforces). Matches are glob
 * or `/regex/` — validated here so a bad regex can't be persisted.
 */
export async function setConnectorPoliciesInManifest(
  projectId: string,
  accountId: string,
  slug: string,
  policies: ConnectorPolicySpec[],
): Promise<CrudResult> {
  for (const [i, p] of policies.entries()) {
    if (!p.match || typeof p.match !== 'string')
      return { ok: false, error: `rule #${i + 1}: \`match\` is required`, status: 400 };
    if (!isValidMatcher(p.match.trim()))
      return { ok: false, error: `rule #${i + 1}: invalid regex pattern`, status: 400 };
    if (!CONNECTOR_POLICY_ACTIONS.includes(p.action)) {
      return {
        ok: false,
        error: `rule #${i + 1}: \`action\` must be ${CONNECTOR_POLICY_ACTIONS.join(' | ')}`,
        status: 400,
      };
    }
  }

  return mutateProjectConnectorManifest(
    projectId,
    accountId,
    `the connector ${slug} policies were being updated`,
    (manifest) => {
      const current = Array.isArray(manifest.raw.connectors)
        ? (manifest.raw.connectors as Record<string, unknown>[])
        : [];
      const entry = current.find((candidate) => candidate?.slug === slug);
      if (!entry) return { ok: false, error: 'connector not found', status: 404 };

      const clean = policies.map((policy) => ({
        match: policy.match.trim(),
        action: policy.action,
      }));
      if (clean.length) entry.policies = clean;
      else delete entry.policies;
      manifest.raw.connectors = current;

      const error = extractConnectors(manifest).errors.find(
        (candidate) => candidate.slug === slug,
      );
      if (error) return { ok: false, error: error.error, status: 400 };
      return { ok: true, commitMessage: `chore: update ${slug} permissions` };
    },
  );
}

// ─── Project-level policies (top-level `policies:` list + `policy:` block) ──

export interface ProjectPoliciesView {
  policies: ProjectPolicySpec[];
  defaultMode: DefaultMode;
  errors: Array<{ path: string; error: string }>;
}

/** Read the project's `policies:` list + `policy:` block (kortix.yaml = source of truth). */
export async function getProjectPoliciesFromManifest(
  projectId: string,
): Promise<ProjectPoliciesView | null> {
  const row = await loadRow(projectId);
  if (!row) return null;
  const manifest = await loadManifestForEdit(row).catch(() => null);
  if (!manifest) return { policies: [], defaultMode: 'allow_all', errors: [] };
  const parsed = extractProjectPolicies(manifest);
  return {
    policies: parsed.policies,
    defaultMode: parsed.settings.defaultMode,
    errors: parsed.errors,
  };
}

/**
 * Replace the WHOLE `policies:` list + `policy.default_mode` in kortix.yaml,
 * commit, and re-sync so the runtime tables reflect the new posture. The UI is
 * an ordered list; "save" PUTs the whole list back. Per-rule add/edit/delete
 * remain client-side until commit.
 */
export async function setProjectPoliciesInManifest(
  projectId: string,
  accountId: string,
  policies: ProjectPolicySpec[],
  defaultMode: DefaultMode,
): Promise<CrudResult> {
  // Validate against the parser before writing — same rules the runtime enforces.
  for (const [i, p] of policies.entries()) {
    if (!p.match || typeof p.match !== 'string') {
      return { ok: false, error: `policy #${i + 1}: \`match\` is required`, status: 400 };
    }
    if (p.action !== 'always_run' && p.action !== 'require_approval' && p.action !== 'block') {
      return {
        ok: false,
        error: `policy #${i + 1}: \`action\` must be always_run | require_approval | block`,
        status: 400,
      };
    }
    // Also checked at the route, re-checked here because this is the function
    // that WRITES kortix.yaml — a bad condition committed to the manifest would
    // come back on every sync, and an unevaluable rule silently loses its
    // restriction rather than failing loudly.
    if (p.conditions !== undefined && p.conditions !== null && !areValidConditions(p.conditions)) {
      return {
        ok: false,
        error: `policy #${i + 1}: invalid \`conditions\``,
        status: 400,
      };
    }
  }
  if (defaultMode !== 'risk' && defaultMode !== 'allow_all') {
    return { ok: false, error: '`default_mode` must be risk | allow_all', status: 400 };
  }

  return mutateProjectConnectorManifest(
    projectId,
    accountId,
    'the project connector policies were being updated',
    (manifest) => {
      const entries = projectPoliciesToTomlEntries(policies);
      if (entries.length > 0) manifest.raw.policies = entries;
      else delete manifest.raw.policies;

      const settingsBlock = projectPolicySettingsToToml({ defaultMode });
      if (settingsBlock) manifest.raw.policy = settingsBlock;
      else delete manifest.raw.policy;

      return { ok: true, commitMessage: 'chore: update connector policies' };
    },
  );
}
