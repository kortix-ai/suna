import type { UpdateConnectionCredentialInput } from '@kortix/api-contract';
import { connectors, projects, projectSessionConnectorBindings } from '@kortix/db';
/**
 * Connector CRUD that round-trips `kortix.yaml` — the web UI "Add connector"
 * flow (mirrors triggers). The manifest holds the connector definition.
 * Credential MODE is always `shared` (`per_user` — each member brings their
 * own — was removed 2026-07-05). Connectors are project-wide visible — the only ACCESS
 * gate is the agent-side `agents.<name>.connectors` grant (declared in git, on
 * the agent, not the connector). Credentials live in the split store.
 */
import { and, eq } from 'drizzle-orm';
import {
  type ConnectorAuthorizationStrategy,
  type ConnectorPolicyAction,
  type ConnectorPolicySpec,
  type ConnectorSpec,
  RESERVED_CONNECTOR_SLUGS,
  RESERVED_SLUG_PROVIDERS,
  extractConnectors,
} from '../projects/connectors';
import { loadManifestForEdit } from '../projects/surface';
import { withProjectGitAuth } from '../projects/lib/git';
import {
  type DefaultMode,
  type ProjectPolicySpec,
  extractProjectPolicies,
  projectPoliciesToTomlEntries,
  projectPolicySettingsToToml,
} from '../projects/policies';
import { db } from '../shared/db';
import { featureDisabledBody } from '../feature-flags/gate';
import { resolveFeatureFlag } from '../feature-flags/registry';
import { upsertCredential, upsertOAuth2Credential } from './credentials';
import { areValidConditions, isValidMatcher, normalizeConditions } from './policy';
import { canonicalConnectorAlias } from '../shared/connector-alias';
import {
  MAX_POLICY_SETS_PER_CONNECTOR,
  MAX_RULES_PER_POLICY_SET,
  POLICY_SETS_UNSUPPORTED_PROVIDERS,
  policySetNameError,
} from '@kortix/manifest-schema';
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
  provider:
    | 'composio'
    | 'pipedream'
    | 'mcp'
    | 'openapi'
    | 'postman'
    | 'graphql'
    | 'http'
    | 'channel';
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
  if (d.provider === 'pipedream' || d.provider === 'composio') {
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
  if (previous.policy_sets !== undefined) entry.policy_sets = previous.policy_sets;
  if (draft.headers === undefined && previous.headers !== undefined) {
    entry.headers = previous.headers;
  }
  if (draft.authorization_strategy === undefined && previous.authorization_strategy !== undefined) {
    entry.authorization_strategy = previous.authorization_strategy;
  }
  if (previous.enabled !== undefined) entry.enabled = previous.enabled;
  // Owned by the sensitive toggle: an edit (or a Pipedream move) keeps the read approval gate.
  if (previous.sensitive !== undefined) entry.sensitive = previous.sensitive;
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

/** Extra steps of one connector write (a connector move uses both). */
export interface ConnectorWriteOptions {
  /** Edits other parts of the same kortix.yaml commit (a move rewrites its triggers). An error string refuses the write. */
  alsoMutate?: (manifest: EditableManifest) => string | null;
  /** Runs after the commit and before the sync (a move swaps credentials there). */
  beforeSync?: () => Promise<void>;
}

/** Create/update a connector in kortix.yaml, then materialize it. */
export async function upsertConnectorInManifest(
  projectId: string,
  accountId: string,
  draft: ConnectorDraft,
  options: ConnectorWriteOptions = {},
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
    !resolveFeatureFlag(row.metadata, 'email_channel')
  ) {
    const disabled = featureDisabledBody('email_channel');
    return { ok: false, error: disabled.error, status: 403, body: disabled };
  }

  let gitProject: Awaited<ReturnType<typeof withProjectGitAuth>>;
  try {
    gitProject = await withProjectGitAuth(row);
  } catch (e) {
    return { ok: false, error: (e as Error).message || 'failed to read manifest', status: 400 };
  }

  const result = await upsertConnectorInManifestWithRetry(gitProject, draft, options.alsoMutate);
  if (!result.ok) return result;
  await options.beforeSync?.();

  const sync = await syncProjectConnectors(projectId, accountId);
  return { ok: true, sync };
}

export type EditableManifest = Awaited<ReturnType<typeof loadManifestForEdit>>;

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
  alsoMutate?: ConnectorWriteOptions['alsoMutate'],
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
      const refused = alsoMutate?.(manifest);
      if (refused) return { ok: false, error: refused, status: 409 };
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
      // An agent's set on a connector that no longer exists goes in the same commit.
      for (const block of agentBlocks(manifest)) {
        rewriteAgentPolicySet(block, slug, () => null);
      }
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
      authSecret: connectors.authSecret,
    })
    .from(connectors)
    .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, slug)))
    .limit(1);
  if (!connector) return { ok: false, error: 'connector not found', status: 404 };
  // No more "this connector's strategy must be project" gate — see
  // connection-access.ts. A shared (project-owned) and a private (member-owned)
  // account can coexist on the same connector now, so storing a shared
  // credential is never refused for the connector's other accounts' shape.
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
 * `shared` is now the only credential mode (`per_user` removed 2026-07-05).
 * This entry
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

/** One manifest rule → the API shape, conditions kept. */
function ruleFromManifest(p: Record<string, unknown>): ConnectorPolicySpec {
  const conditions =
    p.conditions !== undefined && p.conditions !== null && areValidConditions(p.conditions)
      ? normalizeConditions(p.conditions)
      : null;
  return {
    match: String(p.match),
    action: p.action as ConnectorPolicyAction,
    ...(conditions && conditions.length > 0 ? { conditions } : {}),
  };
}

function rulesFromManifest(raw: unknown): ConnectorPolicySpec[] {
  return (Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [])
    .filter((p) => p && typeof p.match === 'string')
    .map(ruleFromManifest);
}

function connectorEntries(manifest: { raw: Record<string, unknown> }): Record<string, unknown>[] {
  return Array.isArray(manifest.raw.connectors)
    ? (manifest.raw.connectors as Record<string, unknown>[])
    : [];
}

function policySetsOf(entry: Record<string, unknown>): Record<string, Record<string, unknown>> | null {
  const sets = entry.policy_sets;
  return sets && typeof sets === 'object' && !Array.isArray(sets)
    ? (sets as Record<string, Record<string, unknown>>)
    : null;
}

/**
 * Read a single connector's rules from kortix.yaml (source of truth): the base
 * `policies:`, or one set's rules when `policySet` is given. `policySetFound`
 * is false when the connector exists but defines no such set.
 */
export async function getConnectorPoliciesFromManifest(
  projectId: string,
  slug: string,
  policySet?: string | null,
): Promise<{ policies: ConnectorPolicySpec[]; policySetFound?: boolean } | null> {
  const row = await loadRow(projectId);
  if (!row) return null;
  const manifest = await loadManifestForEdit(row).catch(() => null);
  if (!manifest) return { policies: [], ...(policySet ? { policySetFound: false } : {}) };
  const entry = connectorEntries(manifest).find((c) => c?.slug === slug);
  if (!entry) return null;
  if (!policySet) return { policies: rulesFromManifest(entry.policies) };
  const sets = policySetsOf(entry);
  const set = sets && Object.hasOwn(sets, policySet) ? sets[policySet] : undefined;
  return { policies: rulesFromManifest(set?.policies), policySetFound: set !== undefined };
}

/** Validate an API rule list. Returns the clean manifest rules or a 400. */
function cleanRules(
  policies: ConnectorPolicySpec[],
): { ok: true; rules: Record<string, unknown>[] } | { ok: false; error: string; status: 400 } {
  if (!Array.isArray(policies)) return { ok: false, error: '`policies` must be an array', status: 400 };
  const rules: Record<string, unknown>[] = [];
  for (const [i, p] of policies.entries()) {
    if (!p || !p.match || typeof p.match !== 'string')
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
    // Conditions are written back, never dropped: dropping one turns a
    // conditional rule into an unconditional one.
    if (p.conditions !== undefined && p.conditions !== null && !areValidConditions(p.conditions)) {
      return { ok: false, error: `rule #${i + 1}: invalid \`conditions\``, status: 400 };
    }
    const conditions = normalizeConditions(p.conditions) ?? [];
    rules.push({
      match: p.match.trim(),
      action: p.action,
      ...(conditions.length > 0 ? { conditions } : {}),
    });
  }
  return { ok: true, rules };
}

/**
 * Replace a connector's rules in kortix.yaml, commit, re-sync (→
 * connector_policies / connector_policy_sets, which the gateway enforces).
 * Without `policySet` it replaces the base `policies:`; with it, the rules of
 * that set, which must exist (404 `policy_set_not_found`).
 */
export async function setConnectorPoliciesInManifest(
  projectId: string,
  accountId: string,
  slug: string,
  policies: ConnectorPolicySpec[],
  policySet?: string | null,
): Promise<CrudResult> {
  const clean = cleanRules(policies);
  if (!clean.ok) return clean;
  if (policySet && clean.rules.length > MAX_RULES_PER_POLICY_SET) {
    return { ok: false, error: `at most ${MAX_RULES_PER_POLICY_SET} rules per policy set`, status: 400 };
  }

  return mutateProjectConnectorManifest(
    projectId,
    accountId,
    `the connector ${slug} policies were being updated`,
    (manifest) => {
      const current = connectorEntries(manifest);
      const entry = current.find((candidate) => candidate?.slug === slug);
      if (!entry) return { ok: false, error: 'connector not found', status: 404 };

      if (policySet) {
        const sets = policySetsOf(entry);
        if (!sets || !Object.hasOwn(sets, policySet)) return policySetNotFound(slug, policySet);
        const set = { ...(sets[policySet] ?? {}) };
        if (clean.rules.length) set.policies = clean.rules;
        else delete set.policies;
        sets[policySet] = set;
      } else if (clean.rules.length) entry.policies = clean.rules;
      else delete entry.policies;
      manifest.raw.connectors = current;

      const error = extractConnectors(manifest).errors.find(
        (candidate) => candidate.slug === slug,
      );
      if (error) return { ok: false, error: error.error, status: 400 };
      return {
        ok: true,
        commitMessage: policySet
          ? `chore: update ${slug} policy set ${policySet}`
          : `chore: update ${slug} permissions`,
      };
    },
  );
}

// ─── Policy sets (`connectors[].policy_sets` + `agents.<a>.policy_sets`) ────

function policySetError(status: number, code: string, error: string, extra: Record<string, unknown> = {}) {
  return { ok: false as const, error, status, code, body: { error, code, ...extra } };
}

function policySetNotFound(slug: string, name: string) {
  return policySetError(404, 'policy_set_not_found', `connector "${slug}" has no policy set "${name}"`);
}

/** The map-shaped (v2/v3) agent blocks of a manifest; empty for v1. */
function agentBlocks(manifest: { raw: Record<string, unknown> }): Record<string, unknown>[] {
  const agents = manifest.raw.agents;
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) return [];
  return Object.values(agents as Record<string, unknown>).filter(
    (block): block is Record<string, unknown> => !!block && typeof block === 'object' && !Array.isArray(block),
  );
}

/**
 * Rewrite an agent block's `policy_sets` entry for `slug` (either alias
 * spelling). `next` gets the current set name and returns the new one, or
 * null to remove the entry. An emptied map is removed.
 */
function rewriteAgentPolicySet(
  block: Record<string, unknown>,
  slug: string,
  next: (current: string) => string | null,
): void {
  const map = block.policy_sets;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return;
  const sets = map as Record<string, unknown>;
  const wanted = canonicalConnectorAlias(slug);
  for (const key of Object.keys(sets)) {
    if (canonicalConnectorAlias(key) !== wanted) continue;
    const value = next(String(sets[key]));
    if (value === null) delete sets[key];
    else sets[key] = value;
  }
  if (Object.keys(sets).length === 0) delete block.policy_sets;
}

/** Agent names whose `policy_sets` assign set `name` on connector `slug`. */
export function agentsUsingPolicySet(
  manifest: { raw: Record<string, unknown> },
  slug: string,
  name: string,
): string[] {
  const agents = manifest.raw.agents;
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) return [];
  const wanted = canonicalConnectorAlias(slug);
  return Object.entries(agents as Record<string, unknown>)
    .filter(([, block]) => {
      const map = (block as Record<string, unknown> | null)?.policy_sets;
      if (!map || typeof map !== 'object' || Array.isArray(map)) return false;
      return Object.entries(map as Record<string, unknown>).some(
        ([key, value]) => canonicalConnectorAlias(key) === wanted && value === name,
      );
    })
    .map(([agent]) => agent)
    .sort();
}

/** Shared guard: a v2/v3 manifest and a connector that may carry sets. */
function policySetTarget(
  manifest: { raw: Record<string, unknown>; schemaVersion?: number },
  slug: string,
):
  | { ok: true; current: Record<string, unknown>[]; entry: Record<string, unknown> }
  | ReturnType<typeof policySetError> {
  if ((manifest.schemaVersion ?? 1) < 2) {
    return policySetError(400, 'unsupported_in_v1', 'policy sets need kortix_version 2 or 3');
  }
  const current = connectorEntries(manifest);
  const entry = current.find((candidate) => candidate?.slug === slug);
  if (!entry) return policySetError(404, 'connector_not_found', 'connector not found');
  const provider = typeof entry.provider === 'string' ? entry.provider.trim().toLowerCase() : '';
  if ((POLICY_SETS_UNSUPPORTED_PROVIDERS as readonly string[]).includes(provider)) {
    return policySetError(400, 'policy_sets_unsupported', `${provider} connectors cannot carry policy sets`);
  }
  return { ok: true, current, entry };
}

function checkSetName(name: string) {
  const problem = policySetNameError(name);
  return problem ? policySetError(400, 'invalid_policy_set_name', problem) : null;
}

/** The sets of one connector as kortix.yaml declares them, with the agents using each. */
export async function listConnectorPolicySetsFromManifest(
  projectId: string,
  slug: string,
): Promise<{
  sets: Array<{ name: string; description: string | null; policies: ConnectorPolicySpec[] }>;
  agents: Record<string, string[]>;
} | null> {
  const row = await loadRow(projectId);
  if (!row) return null;
  const manifest = await loadManifestForEdit(row).catch(() => null);
  if (!manifest) return null;
  const entry = connectorEntries(manifest).find((c) => c?.slug === slug);
  if (!entry) return null;
  const sets = Object.entries(policySetsOf(entry) ?? {}).map(([name, set]) => ({
    name,
    description: typeof set?.description === 'string' && set.description.trim() ? set.description.trim() : null,
    policies: rulesFromManifest(set?.policies),
  }));
  const agents: Record<string, string[]> = Object.create(null);
  for (const set of sets) agents[set.name] = agentsUsingPolicySet(manifest, slug, set.name);
  return { sets, agents };
}

/**
 * Create a set, or change its description. Rules are written through
 * `setConnectorPoliciesInManifest(…, policySet)`, the one rule writer.
 * `description: null` or `''` removes the description; undefined keeps it.
 */
export async function upsertConnectorPolicySetInManifest(
  projectId: string,
  accountId: string,
  slug: string,
  name: string,
  description: string | null | undefined,
): Promise<CrudResult & { created?: boolean }> {
  const bad = checkSetName(name);
  if (bad) return bad;
  let created = false;
  const result = await mutateProjectConnectorManifest(
    projectId,
    accountId,
    `the policy set ${slug}/${name} was being saved`,
    (manifest) => {
      const target = policySetTarget(manifest, slug);
      if (!target.ok) return target;
      const sets = policySetsOf(target.entry) ?? {};
      created = !Object.hasOwn(sets, name);
      if (created && Object.keys(sets).length >= MAX_POLICY_SETS_PER_CONNECTOR) {
        return policySetError(400, 'policy_set_limit', `at most ${MAX_POLICY_SETS_PER_CONNECTOR} policy sets per connector`);
      }
      const set = { ...(sets[name] ?? {}) };
      if (description !== undefined) {
        if (description && description.trim()) set.description = description.trim();
        else delete set.description;
      }
      if (!created && description === undefined) return { ok: true, commitMessage: null };
      sets[name] = set;
      target.entry.policy_sets = sets;
      manifest.raw.connectors = target.current;
      const error = extractConnectors(manifest).errors.find((candidate) => candidate.slug === slug);
      if (error) return { ok: false, error: error.error, status: 400 };
      return {
        ok: true,
        commitMessage: created ? `chore: add ${slug} policy set ${name}` : `chore: update ${slug} policy set ${name}`,
      };
    },
  );
  return result.ok ? { ...result, created } : result;
}

/**
 * Rename a set and every `agents.<a>.policy_sets` reference to it, in one
 * commit, so no agent ever points at a missing set (which blocks).
 */
export async function renameConnectorPolicySetInManifest(
  projectId: string,
  accountId: string,
  slug: string,
  from: string,
  to: string,
): Promise<CrudResult> {
  const bad = checkSetName(to);
  if (bad) return bad;
  return mutateProjectConnectorManifest(
    projectId,
    accountId,
    `the policy set ${slug}/${from} was being renamed`,
    (manifest) => {
      const target = policySetTarget(manifest, slug);
      if (!target.ok) return target;
      const sets = policySetsOf(target.entry);
      if (!sets || !Object.hasOwn(sets, from)) return policySetNotFound(slug, from);
      if (from === to) return { ok: true, commitMessage: null };
      if (Object.hasOwn(sets, to)) {
        return policySetError(409, 'policy_set_exists', `connector "${slug}" already has a policy set "${to}"`);
      }
      // Rebuild to keep the authoring order: the renamed set stays in place.
      target.entry.policy_sets = Object.fromEntries(
        Object.entries(sets).map(([key, value]) => [key === from ? to : key, value]),
      );
      for (const block of agentBlocks(manifest)) {
        rewriteAgentPolicySet(block, slug, (current) => (current === from ? to : current));
      }
      manifest.raw.connectors = target.current;
      return { ok: true, commitMessage: `chore: rename ${slug} policy set ${from} to ${to}` };
    },
  );
}

/**
 * Delete a set. Refused with 409 `policy_set_in_use` while an agent uses it.
 * The check runs inside the compare-and-swap callback, over the manifest that
 * gets committed, so a concurrent assignment cannot slip in between.
 */
export async function deleteConnectorPolicySetInManifest(
  projectId: string,
  accountId: string,
  slug: string,
  name: string,
): Promise<CrudResult> {
  return mutateProjectConnectorManifest(
    projectId,
    accountId,
    `the policy set ${slug}/${name} was being deleted`,
    (manifest) => {
      const target = policySetTarget(manifest, slug);
      if (!target.ok) return target;
      const sets = policySetsOf(target.entry);
      if (!sets || !Object.hasOwn(sets, name)) return policySetNotFound(slug, name);
      const agents = agentsUsingPolicySet(manifest, slug, name);
      if (agents.length > 0) {
        return policySetError(
          409,
          'policy_set_in_use',
          `policy set "${name}" is used by ${agents.map((a) => `"${a}"`).join(', ')}. Give those agents another set first.`,
          { agents },
        );
      }
      delete sets[name];
      if (Object.keys(sets).length === 0) delete target.entry.policy_sets;
      manifest.raw.connectors = target.current;
      return { ok: true, commitMessage: `chore: delete ${slug} policy set ${name}` };
    },
  );
}

// ─── Project-level policies (top-level `policies:` list + `policy:` block) ──

export interface ProjectPoliciesView {
  policies: ProjectPolicySpec[];
  defaultMode: DefaultMode;
  errors: Array<{ path: string; error: string }>;
  /** Per-connector tool-call rule counts, from the same manifest (KRTX-2527):
   *  `policy <slug> set` must be visible to the parent `policy ls` too. */
  connectorRules: Array<{ slug: string; count: number }>;
}

/** Read the project's `policies:` list + `policy:` block (kortix.yaml = source of truth). */
export async function getProjectPoliciesFromManifest(
  projectId: string,
): Promise<ProjectPoliciesView | null> {
  const row = await loadRow(projectId);
  if (!row) return null;
  const manifest = await loadManifestForEdit(row).catch(() => null);
  if (!manifest)
    return { policies: [], defaultMode: 'allow_all', errors: [], connectorRules: [] };
  const parsed = extractProjectPolicies(manifest);
  const connectorSpecs = extractConnectors(manifest).specs;
  return {
    policies: parsed.policies,
    defaultMode: parsed.settings.defaultMode,
    errors: parsed.errors,
    connectorRules: connectorSpecs
      .filter((spec) => spec.policies.length > 0)
      .map((spec) => ({ slug: spec.slug, count: spec.policies.length })),
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
