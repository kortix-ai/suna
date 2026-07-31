import type { UpdateConnectorAuthorizationCredentialInput } from '@kortix/api-contract';
import { executorConnectors, projects } from '@kortix/db';
/**
 * Connector CRUD that round-trips `kortix.yaml` — the web UI "Add connector"
 * flow (mirrors triggers). The manifest holds the connector definition.
 * Credential MODE is always `shared` (`per_user` — each member brings their
 * own — was removed 2026-07-05, docs/specs/2026-07-05-agent-first-config-
 * unification.md §2.5). Connectors are project-wide visible — the only ACCESS
 * gate is the agent-side `agents.<name>.connectors` grant (declared in git, on
 * the agent, not the connector). Credentials live in the split store. See
 * docs/specs/executor.md §3, §5–6.
 */
import { and, eq } from 'drizzle-orm';
import { resolveExperimentalFeature } from '../experimental/features';
import {
  type ConnectorAuthorizationStrategy,
  type ConnectorPolicyAction,
  type ConnectorPolicySpec,
  type ConnectorSpec,
  RESERVED_CONNECTOR_SLUGS,
  RESERVED_SLUG_PROVIDERS,
  extractConnectors,
} from '../projects/connectors';
import { commitManifest, loadManifestForEdit } from '../projects/index';
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
import { type SyncResult, syncProjectConnectors } from './sync';

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
  /** Exclusive owner model for authorizations under this connector profile. */
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
  | { ok: false; error: string; status: number };

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
 * other connector-profile controls. */
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
  if (
    draft.authorization_strategy === undefined &&
    previous.authorization_strategy !== undefined
  ) {
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
    .select({ connectorId: executorConnectors.connectorId })
    .from(executorConnectors)
    .where(and(eq(executorConnectors.projectId, projectId), eq(executorConnectors.slug, slug)))
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
          : `"${draft.slug}" is reserved for a built-in channel profile. Pick a different slug.`,
      status: 400,
    };
  }

  const row = await loadRow(projectId);
  if (!row) return { ok: false, error: 'project not found', status: 404 };
  if (
    draft.provider === 'channel' &&
    draft.platform === 'email' &&
    !resolveExperimentalFeature(row.metadata, 'agentmail_email')
  ) {
    return {
      ok: false,
      error: 'AgentMail Email is experimental and must be enabled for this project',
      status: 403,
    };
  }

  let gitProject: Awaited<ReturnType<typeof withProjectGitAuth>>;
  try {
    gitProject = await withProjectGitAuth(row);
  } catch (e) {
    return { ok: false, error: (e as Error).message || 'failed to read manifest', status: 400 };
  }

  const result = await upsertConnectorInManifestWithRevision(gitProject, draft);
  if (!result.ok) return result;

  const sync = await syncProjectConnectors(projectId, accountId);
  return { ok: true, sync };
}

async function upsertConnectorInManifestWithRevision(
  project: Awaited<ReturnType<typeof withProjectGitAuth>>,
  draft: ConnectorDraft,
): Promise<CrudResult> {
  let manifest;
  try {
    manifest = await loadManifestForEdit(project);
  } catch (e) {
    return { ok: false, error: (e as Error).message || 'failed to read manifest', status: 400 };
  }

  const current = Array.isArray(manifest.raw.connectors)
    ? (manifest.raw.connectors as Record<string, unknown>[])
    : [];
  const idx = current.findIndex((c) => c?.slug === draft.slug);
  if (idx >= 0 && draft.create_only === true) {
    return {
      ok: false,
      error: `Connector profile slug "${draft.slug}" already exists`,
      status: 409,
    };
  }
  const entry = mergeConnectorDraftEntry(draft, idx >= 0 ? current[idx] : undefined);
  if (idx >= 0) {
    current[idx] = entry;
  } else {
    current.push(entry);
  }
  manifest.raw.connectors = current;

  const parsed = extractConnectors(manifest);
  const err = parsed.errors.find((e) => e.slug === draft.slug);
  if (err) return { ok: false, error: err.error, status: 400 };

  const committed = await commitManifest(
    project,
    manifest,
    `chore: ${idx >= 0 ? 'update' : 'add'} connector ${draft.slug}`,
  );
  if ('error' in committed) return { ok: false, error: committed.error, status: committed.status };

  return { ok: true };
}

export async function deleteConnectorFromManifest(
  projectId: string,
  slug: string,
): Promise<CrudResult> {
  const row = await loadRow(projectId);
  if (!row) return { ok: false, error: 'project not found', status: 404 };

  let manifest;
  try {
    manifest = await loadManifestForEdit(row);
  } catch (e) {
    return { ok: false, error: (e as Error).message || 'failed to read manifest', status: 400 };
  }

  const current = Array.isArray(manifest.raw.connectors)
    ? (manifest.raw.connectors as Record<string, unknown>[])
    : [];
  const next = current.filter((c) => c?.slug !== slug);
  if (next.length === current.length) {
    await db
      .delete(executorConnectors)
      .where(and(eq(executorConnectors.projectId, projectId), eq(executorConnectors.slug, slug)));
    return { ok: true };
  }
  manifest.raw.connectors = next;
  const committed = await commitManifest(row, manifest, `chore: delete connector ${slug}`);
  if ('error' in committed) return { ok: false, error: committed.error, status: committed.status };
  await db
    .delete(executorConnectors)
    .where(and(eq(executorConnectors.projectId, projectId), eq(executorConnectors.slug, slug)));
  return { ok: true };
}

/** Set a project-owned connector authorization credential. */
export async function setConnectorCredentialShared(
  projectId: string,
  slug: string,
  input: UpdateConnectorAuthorizationCredentialInput,
): Promise<CrudResult> {
  const [connector] = await db
    .select({
      connectorId: executorConnectors.connectorId,
      authorizationStrategy: executorConnectors.authorizationStrategy,
    })
    .from(executorConnectors)
    .where(and(eq(executorConnectors.projectId, projectId), eq(executorConnectors.slug, slug)))
    .limit(1);
  if (!connector) return { ok: false, error: 'connector not found', status: 404 };
  if (connector.authorizationStrategy !== 'project') {
    return {
      ok: false,
      error: 'Shared credentials require a project authorization strategy',
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
  return { ok: true };
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
  const row = await loadRow(projectId);
  if (!row) return { ok: false, error: 'project not found', status: 404 };

  let manifest;
  try {
    manifest = await loadManifestForEdit(row);
  } catch (e) {
    return { ok: false, error: (e as Error).message || 'failed to read manifest', status: 400 };
  }

  const current = Array.isArray(manifest.raw.connectors)
    ? (manifest.raw.connectors as Record<string, unknown>[])
    : [];
  const entry = current.find((c) => c?.slug === slug);
  if (!entry) return { ok: false, error: 'connector not found', status: 404 };
  delete entry.credential;
  manifest.raw.connectors = current;

  const parsed = extractConnectors(manifest);
  const err = parsed.errors.find((e) => e.slug === slug);
  if (err) return { ok: false, error: err.error, status: 400 };

  const committed = await commitManifest(
    row,
    manifest,
    `chore: set ${slug} credential mode → ${mode}`,
  );
  if ('error' in committed) return { ok: false, error: committed.error, status: committed.status };

  const sync = await syncProjectConnectors(projectId, accountId);
  return { ok: true, sync };
}

/** Set the exclusive authorization owner model for one connector profile. */
export async function setConnectorAuthorizationStrategyInManifest(
  projectId: string,
  accountId: string,
  slug: string,
  authorizationStrategy: ConnectorAuthorizationStrategy,
): Promise<CrudResult> {
  const row = await loadRow(projectId);
  if (!row) return { ok: false, error: 'project not found', status: 404 };

  let manifest;
  try {
    manifest = await loadManifestForEdit(row);
  } catch (e) {
    return { ok: false, error: (e as Error).message || 'failed to read manifest', status: 400 };
  }

  const current = Array.isArray(manifest.raw.connectors)
    ? (manifest.raw.connectors as Record<string, unknown>[])
    : [];
  const entry = current.find((candidate) => candidate?.slug === slug);
  if (!entry) return { ok: false, error: 'connector not found', status: 404 };
  entry.authorization_strategy = authorizationStrategy;
  manifest.raw.connectors = current;

  const parsed = extractConnectors(manifest);
  const error = parsed.errors.find((candidate) => candidate.slug === slug);
  if (error) return { ok: false, error: error.error, status: 400 };

  const committed = await commitManifest(
    row,
    manifest,
    `chore: set ${slug} authorization strategy to ${authorizationStrategy}`,
  );
  if ('error' in committed) {
    return { ok: false, error: committed.error, status: committed.status };
  }

  const sync = await syncProjectConnectors(projectId, accountId);
  return { ok: true, sync };
}

/**
 * Toggle a connector's `sensitive` flag in kortix.yaml, commit, re-sync. A
 * sensitive connector gates its reads too (every action defaults to
 * require_approval unless an explicit policy opens it) — for email/files/
 * secrets-bearing integrations where reading is itself an exfiltration surface.
 */
export async function setConnectorSensitiveInManifest(
  projectId: string,
  accountId: string,
  slug: string,
  sensitive: boolean,
): Promise<CrudResult> {
  const row = await loadRow(projectId);
  if (!row) return { ok: false, error: 'project not found', status: 404 };

  let manifest;
  try {
    manifest = await loadManifestForEdit(row);
  } catch (e) {
    return { ok: false, error: (e as Error).message || 'failed to read manifest', status: 400 };
  }

  const current = Array.isArray(manifest.raw.connectors)
    ? (manifest.raw.connectors as Record<string, unknown>[])
    : [];
  const entry = current.find((c) => c?.slug === slug);
  if (!entry) return { ok: false, error: 'connector not found', status: 404 };
  // Omit the key when false so the emitted manifest stays minimal (false is the default).
  if (sensitive) entry.sensitive = true;
  else delete entry.sensitive;
  manifest.raw.connectors = current;

  const parsed = extractConnectors(manifest);
  const err = parsed.errors.find((e) => e.slug === slug);
  if (err) return { ok: false, error: err.error, status: 400 };

  const committed = await commitManifest(
    row,
    manifest,
    `chore: mark ${slug} ${sensitive ? 'sensitive' : 'not sensitive'}`,
  );
  if ('error' in committed) return { ok: false, error: committed.error, status: committed.status };

  const sync = await syncProjectConnectors(projectId, accountId);
  return { ok: true, sync };
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

  const row = await loadRow(projectId);
  if (!row) return { ok: false, error: 'project not found', status: 404 };

  let manifest;
  try {
    manifest = await loadManifestForEdit(row);
  } catch (e) {
    return { ok: false, error: (e as Error).message || 'failed to read manifest', status: 400 };
  }

  const current = Array.isArray(manifest.raw.connectors)
    ? (manifest.raw.connectors as Record<string, unknown>[])
    : [];
  const entry = current.find((c) => c?.slug === slug);
  if (!entry) return { ok: false, error: 'connector not found', status: 404 };
  entry.name = trimmed;
  manifest.raw.connectors = current;

  const parsed = extractConnectors(manifest);
  const err = parsed.errors.find((e) => e.slug === slug);
  if (err) return { ok: false, error: err.error, status: 400 };

  const committed = await commitManifest(
    row,
    manifest,
    `chore: rename connector ${slug} → ${trimmed}`,
  );
  if ('error' in committed) return { ok: false, error: committed.error, status: committed.status };

  const sync = await syncProjectConnectors(projectId, accountId);
  return { ok: true, sync };
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
 * (→ executor_connector_policies, which the gateway enforces). Matches are glob
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

  const row = await loadRow(projectId);
  if (!row) return { ok: false, error: 'project not found', status: 404 };

  let manifest;
  try {
    manifest = await loadManifestForEdit(row);
  } catch (e) {
    return { ok: false, error: (e as Error).message || 'failed to read manifest', status: 400 };
  }

  const current = Array.isArray(manifest.raw.connectors)
    ? (manifest.raw.connectors as Record<string, unknown>[])
    : [];
  const entry = current.find((c) => c?.slug === slug);
  if (!entry) return { ok: false, error: 'connector not found', status: 404 };

  const clean = policies.map((p) => ({ match: p.match.trim(), action: p.action }));
  if (clean.length) entry.policies = clean;
  else delete entry.policies;
  manifest.raw.connectors = current;

  const parsed = extractConnectors(manifest);
  const err = parsed.errors.find((e) => e.slug === slug);
  if (err) return { ok: false, error: err.error, status: 400 };

  const committed = await commitManifest(row, manifest, `chore: update ${slug} permissions`);
  if ('error' in committed) return { ok: false, error: committed.error, status: committed.status };

  const sync = await syncProjectConnectors(projectId, accountId);
  return { ok: true, sync };
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
  const row = await loadRow(projectId);
  if (!row) return { ok: false, error: 'project not found', status: 404 };

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

  let manifest;
  try {
    manifest = await loadManifestForEdit(row);
  } catch (e) {
    return { ok: false, error: (e as Error).message || 'failed to read manifest', status: 400 };
  }

  // Rewrite both knobs. Omit empties so the manifest stays clean.
  const entries = projectPoliciesToTomlEntries(policies);
  if (entries.length > 0) {
    manifest.raw.policies = entries;
  } else {
    delete manifest.raw.policies;
  }
  const settingsBlock = projectPolicySettingsToToml({ defaultMode });
  if (settingsBlock) {
    manifest.raw.policy = settingsBlock;
  } else {
    delete manifest.raw.policy;
  }

  const committed = await commitManifest(row, manifest, 'chore: update executor policies');
  if ('error' in committed) return { ok: false, error: committed.error, status: committed.status };

  // Materialize: project policies are reconciled inside syncProjectConnectors.
  const sync = await syncProjectConnectors(projectId, accountId);
  return { ok: true, sync };
}
