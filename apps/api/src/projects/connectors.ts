/**
 * `[[connectors]]` parsing for `kortix.toml`.
 *
 * A connector is one named integration the Executor can call — Pipedream,
 * MCP, OpenAPI, GraphQL, or raw HTTP. The manifest holds the *definition*
 * (provider, endpoint/spec, auth method + which project-secret to use) and,
 * for the policy layer, the connector-scoped `[[connectors.policies]]`. The
 * secret *value* and Pipedream OAuth live in the platform, never in git;
 * who-can-use-it (sharing) is platform-side too.
 *
 * Example:
 *
 *   [[connectors]]
 *   slug     = "stripe"
 *   name     = "Stripe API"
 *   provider = "openapi"
 *   spec     = "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json"
 *
 *     [connectors.auth]
 *     type   = "bearer"
 *     secret = "STRIPE_API_KEY"     # project-secret NAME; value set in dashboard
 *
 *     [[connectors.policies]]        # connector-scoped; built last
 *     match  = "*.delete*"
 *     action = "block"
 *
 *   [[connectors]]
 *   slug     = "gmail-work"
 *   provider = "pipedream"
 *   app      = "gmail"
 *   account  = "work"               # 1-click connected in the dashboard
 *
 * Parser mirrors `projects/apps.ts` + `projects/triggers.ts`: never throws on
 * a bad entry, collects them in `errors` so the UI can render them next to the
 * good ones. CRUD round-trips this same file (connectorSpecToTomlEntry).
 */
import { createHash } from 'node:crypto';
import { MANIFEST_FILENAME, readManifest, type ParsedManifest } from './triggers';
import { isValidSecretName } from './secrets';
import type { GitBackedProject } from './git';

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;

export type ConnectorProvider = 'pipedream' | 'mcp' | 'openapi' | 'graphql' | 'http';
const PROVIDERS: readonly ConnectorProvider[] = ['pipedream', 'mcp', 'openapi', 'graphql', 'http'];

type ConnectorAuthType = 'bearer' | 'basic' | 'custom' | 'none';
const AUTH_TYPES: readonly ConnectorAuthType[] = ['bearer', 'basic', 'custom', 'none'];

interface ConnectorAuthSpec {
  /** How the credential is attached to outbound calls. */
  type: ConnectorAuthType;
  /** For `custom`: where the credential goes. Defaults to `header`. */
  in: 'header' | 'query';
  /** For `custom`: the header/param name (e.g. `Authorization`, `X-API-Key`). */
  name: string | null;
  /** Optional value prefix (e.g. `Bearer`). */
  prefix: string | null;
  /** Name of the project secret holding the credential. Value set in the dashboard. */
  secret: string | null;
}

/** Tool-call policy action — mirrors executor's `approve | require_approval | block`. */
export type ConnectorPolicyAction = 'always_run' | 'require_approval' | 'block';
const POLICY_ACTIONS: readonly ConnectorPolicyAction[] = ['always_run', 'require_approval', 'block'];

export interface ConnectorPolicySpec {
  /** Glob over this connector's tool paths: `*`, `charges.*`, `charges.create`. */
  match: string;
  action: ConnectorPolicyAction;
}

export interface ConnectorSpec {
  /** URL-safe slug — unique per project. Also the tool namespace. */
  slug: string;
  /** `kortix.toml#connectors.<slug>` for UI / error reporting. */
  path: string;
  /** Human label; defaults to slug. */
  name: string;
  /** When false the materializer / gateway skip this entry. */
  enabled: boolean;
  provider: ConnectorProvider;
  /** Credential storage mode. Default: pipedream→per_user, others→shared. */
  credentialMode: 'shared' | 'per_user';
  // ── provider-specific ──
  /** pipedream: app slug (`gmail`, `slack`). */
  app: string | null;
  /** pipedream: named connected-account binding. */
  account: string | null;
  /** mcp: server endpoint. */
  url: string | null;
  /** mcp: transport. */
  transport: 'http' | 'sse' | null;
  /** graphql: HTTP endpoint. */
  endpoint: string | null;
  /** http: base URL for declared routes. */
  baseUrl: string | null;
  /** openapi/graphql/http: a URL or repo-relative file path. Optional for graphql. */
  spec: string | null;
  // ── shared ──
  auth: ConnectorAuthSpec;
  policies: ConnectorPolicySpec[];
}

interface ConnectorParseError {
  slug: string;
  path: string;
  error: string;
}

export interface LoadedConnectors {
  specs: ConnectorSpec[];
  errors: ConnectorParseError[];
}

const NO_AUTH: ConnectorAuthSpec = { type: 'none', in: 'header', name: null, prefix: null, secret: null };

/**
 * Pull `[[connectors]]` out of a parsed manifest. Never throws.
 */
export function extractConnectors(manifest: ParsedManifest): LoadedConnectors {
  const raw = manifest.raw.connectors;
  if (raw === undefined || raw === null) {
    return { specs: [], errors: [] };
  }
  if (!Array.isArray(raw)) {
    return {
      specs: [],
      errors: [{
        slug: '(top-level)',
        path: MANIFEST_FILENAME,
        error: '`connectors` must be an array of tables — use [[connectors]], not [connectors]',
      }],
    };
  }

  const specs: ConnectorSpec[] = [];
  const errors: ConnectorParseError[] = [];
  const seenSlugs = new Set<string>();

  raw.forEach((entry, index) => {
    const result = parseConnectorEntry(entry, index);
    if (!result.ok) {
      errors.push(result.error);
      return;
    }
    if (seenSlugs.has(result.spec.slug)) {
      errors.push({
        slug: result.spec.slug,
        path: result.spec.path,
        error: `Duplicate connector slug "${result.spec.slug}" — slugs must be unique within a project`,
      });
      return;
    }
    seenSlugs.add(result.spec.slug);
    specs.push(result.spec);
  });

  specs.sort((a, b) => a.slug.localeCompare(b.slug));
  errors.sort((a, b) => a.slug.localeCompare(b.slug));
  return { specs, errors };
}

/**
 * Read + parse a project's manifest, then extract `[[connectors]]`. Returns
 * empty arrays + a single top-level error when the manifest fails to load —
 * never throws.
 */
export async function loadProjectConnectors(project: GitBackedProject): Promise<LoadedConnectors> {
  let manifest: ParsedManifest | null;
  try {
    manifest = await readManifest(project);
  } catch (err) {
    return {
      specs: [],
      errors: [{
        slug: '(manifest)',
        path: MANIFEST_FILENAME,
        error: (err as Error).message || 'Failed to read manifest',
      }],
    };
  }
  if (!manifest) return { specs: [], errors: [] };
  return extractConnectors(manifest);
}

/**
 * Convert a ConnectorSpec back to the TOML-shaped object that lives in
 * `manifest.raw.connectors`. Inverse of `parseConnectorEntry`. Used by the
 * CRUD path to round-trip a dashboard edit before committing.
 */
export function connectorSpecToTomlEntry(spec: ConnectorSpec): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    slug: spec.slug,
    name: spec.name,
    provider: spec.provider,
    enabled: spec.enabled,
  };
  // Only emit credential mode when it differs from the per-app default.
  const defaultMode = spec.provider === 'pipedream' ? 'per_user' : 'shared';
  if (spec.credentialMode !== defaultMode) entry.credential = spec.credentialMode;
  // Provider-specific keys — only emit what carries information.
  if (spec.provider === 'pipedream') {
    if (spec.app) entry.app = spec.app;
    if (spec.account) entry.account = spec.account;
  } else if (spec.provider === 'mcp') {
    if (spec.url) entry.url = spec.url;
    if (spec.transport) entry.transport = spec.transport;
  } else if (spec.provider === 'graphql') {
    if (spec.endpoint) entry.endpoint = spec.endpoint;
    if (spec.spec) entry.spec = spec.spec;
  } else if (spec.provider === 'http') {
    if (spec.baseUrl) entry.base_url = spec.baseUrl;
    if (spec.spec) entry.spec = spec.spec;
  } else if (spec.provider === 'openapi') {
    if (spec.spec) entry.spec = spec.spec;
  }

  if (spec.auth.type !== 'none') {
    const auth: Record<string, unknown> = { type: spec.auth.type };
    if (spec.auth.type === 'custom') {
      if (spec.auth.in !== 'header') auth.in = spec.auth.in;
      if (spec.auth.name) auth.name = spec.auth.name;
    }
    if (spec.auth.prefix) auth.prefix = spec.auth.prefix;
    if (spec.auth.secret) auth.secret = spec.auth.secret;
    entry.auth = auth;
  }

  if (spec.policies.length > 0) {
    entry.policies = spec.policies.map((p) => ({ match: p.match, action: p.action }));
  }

  return entry;
}

/**
 * Stable hash over everything that should trigger a catalog re-sync when it
 * changes (so the materializer can skip unchanged connectors). `slug`/`name`
 * are excluded — renaming doesn't change what the connector resolves to.
 * Policies are excluded too — they gate calls, not the catalog.
 */
export function manifestHashForConnector(spec: ConnectorSpec): string {
  const canonical = JSON.stringify({
    provider: spec.provider,
    credentialMode: spec.credentialMode,
    app: spec.app,
    account: spec.account,
    url: spec.url,
    transport: spec.transport,
    endpoint: spec.endpoint,
    baseUrl: spec.baseUrl,
    spec: spec.spec,
    auth: spec.auth,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

interface ParseOk { ok: true; spec: ConnectorSpec }
interface ParseErr { ok: false; error: ConnectorParseError }

function parseConnectorEntry(entry: unknown, index: number): ParseOk | ParseErr {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return err('(invalid)', `[[connectors]] entry #${index + 1} is not a table`);
  }
  const row = entry as Record<string, unknown>;

  const slug = typeof row.slug === 'string' ? row.slug.trim() : '';
  if (!slug) return err(`(index-${index})`, `[[connectors]] entry #${index + 1} is missing a slug`);
  if (!SLUG_RE.test(slug)) {
    return err(slug, `Invalid slug "${slug}" — lowercase letters, digits, dashes, underscores only`);
  }

  const provider = typeof row.provider === 'string' ? row.provider.trim().toLowerCase() : '';
  if (!PROVIDERS.includes(provider as ConnectorProvider)) {
    return err(slug, `provider must be one of ${PROVIDERS.join(', ')} (got "${provider || 'unset'}")`);
  }

  const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : slug;
  const enabled = coerceBool(row.enabled, true);

  // Credential mode — per-app default, overridable via `credential = "..."`.
  const credRaw = typeof row.credential === 'string' ? row.credential.trim().toLowerCase() : '';
  if (credRaw && credRaw !== 'shared' && credRaw !== 'per_user') {
    return err(slug, 'credential must be "shared" or "per_user"');
  }
  const credentialMode: 'shared' | 'per_user' =
    credRaw === 'shared' || credRaw === 'per_user'
      ? credRaw
      : provider === 'pipedream' ? 'per_user' : 'shared';

  // Defaults; provider blocks fill them in.
  const base: Omit<ConnectorSpec, 'auth' | 'policies'> = {
    slug,
    path: `${MANIFEST_FILENAME}#connectors.${slug}`,
    name,
    enabled,
    provider: provider as ConnectorProvider,
    credentialMode,
    app: null,
    account: null,
    url: null,
    transport: null,
    endpoint: null,
    baseUrl: null,
    spec: null,
  };

  const providerParsed = parseProviderFields(slug, provider as ConnectorProvider, row, base);
  if (!providerParsed.ok) return providerParsed;

  const authParsed = parseAuth(slug, provider as ConnectorProvider, row.auth);
  if (!authParsed.ok) return authParsed;

  const policiesParsed = parsePolicies(slug, row.policies);
  if (!policiesParsed.ok) return policiesParsed;

  return {
    ok: true,
    spec: { ...providerParsed.value, auth: authParsed.value, policies: policiesParsed.value },
  };
}

function parseProviderFields(
  slug: string,
  provider: ConnectorProvider,
  row: Record<string, unknown>,
  base: Omit<ConnectorSpec, 'auth' | 'policies'>,
): { ok: true; value: Omit<ConnectorSpec, 'auth' | 'policies'> } | ParseErr {
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

  if (provider === 'pipedream') {
    const app = str(row.app);
    if (!app) return err(slug, 'provider="pipedream" requires `app` (the Pipedream app slug)');
    // account defaults to the slug — names the connected-account binding.
    const account = str(row.account) ?? slug;
    return { ok: true, value: { ...base, app, account } };
  }

  if (provider === 'mcp') {
    const url = str(row.url);
    if (!url) return err(slug, 'provider="mcp" requires `url` (the MCP server endpoint)');
    const t = typeof row.transport === 'string' ? row.transport.trim().toLowerCase() : 'http';
    if (t !== 'http' && t !== 'sse') {
      return err(slug, `transport must be "http" or "sse" (got "${t}")`);
    }
    return { ok: true, value: { ...base, url, transport: t } };
  }

  if (provider === 'openapi') {
    const spec = str(row.spec);
    if (!spec) return err(slug, 'provider="openapi" requires `spec` (a URL or repo-relative file path)');
    return { ok: true, value: { ...base, spec } };
  }

  if (provider === 'graphql') {
    const endpoint = str(row.endpoint);
    if (!endpoint) return err(slug, 'provider="graphql" requires `endpoint`');
    // spec (SDL) is optional — omit to introspect at sync.
    return { ok: true, value: { ...base, endpoint, spec: str(row.spec) } };
  }

  // http
  const baseUrl = str(row.base_url) ?? str(row.baseUrl);
  if (!baseUrl) return err(slug, 'provider="http" requires `base_url`');
  return { ok: true, value: { ...base, baseUrl, spec: str(row.spec) } };
}

function parseAuth(
  slug: string,
  provider: ConnectorProvider,
  raw: unknown,
): { ok: true; value: ConnectorAuthSpec } | ParseErr {
  // No auth table → none (pipedream authenticates via its connected account).
  if (raw === undefined || raw === null) return { ok: true, value: { ...NO_AUTH } };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return err(slug, '[connectors.auth] must be a table');
  }
  const row = raw as Record<string, unknown>;

  const type = typeof row.type === 'string' ? row.type.trim().toLowerCase() : 'none';
  if (!AUTH_TYPES.includes(type as ConnectorAuthType)) {
    return err(slug, `[connectors.auth].type must be one of ${AUTH_TYPES.join(', ')} (got "${type}")`);
  }
  if (provider === 'pipedream' && type !== 'none') {
    return err(slug, 'provider="pipedream" authenticates via its connected account — omit [connectors.auth]');
  }

  if (type === 'none') return { ok: true, value: { ...NO_AUTH } };

  const inRaw = typeof row.in === 'string' ? row.in.trim().toLowerCase() : 'header';
  if (inRaw !== 'header' && inRaw !== 'query') {
    return err(slug, '[connectors.auth].in must be "header" or "query"');
  }
  const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : null;
  if (type === 'custom' && !name) {
    return err(slug, '[connectors.auth] type="custom" requires `name` (the header/param name)');
  }
  const prefix = typeof row.prefix === 'string' && row.prefix.trim() ? row.prefix.trim() : null;

  // `secret` is optional — credentials live in the platform (executor_credentials),
  // not as a named project secret. If present it's validated for back-compat.
  const secret = typeof row.secret === 'string' && row.secret.trim() ? row.secret.trim() : null;
  if (secret && !isValidSecretName(secret)) {
    return err(slug, `[connectors.auth].secret "${secret}" must look like a project-secret name (^[A-Z_][A-Z0-9_]{0,63}$)`);
  }

  return { ok: true, value: { type: type as ConnectorAuthType, in: inRaw, name, prefix, secret } };
}

function parsePolicies(
  slug: string,
  raw: unknown,
): { ok: true; value: ConnectorPolicySpec[] } | ParseErr {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) {
    return err(slug, '[[connectors.policies]] must be an array of tables');
  }
  const out: ConnectorPolicySpec[] = [];
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i];
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      return err(slug, `[[connectors.policies]] entry #${i + 1} is not a table`);
    }
    const prow = p as Record<string, unknown>;
    const match = typeof prow.match === 'string' && prow.match.trim() ? prow.match.trim() : '';
    if (!match) return err(slug, `[[connectors.policies]] entry #${i + 1} is missing \`match\``);
    const action = typeof prow.action === 'string' ? prow.action.trim().toLowerCase() : '';
    if (!POLICY_ACTIONS.includes(action as ConnectorPolicyAction)) {
      return err(slug, `[[connectors.policies]] \`action\` must be one of ${POLICY_ACTIONS.join(', ')} (got "${action || 'unset'}")`);
    }
    out.push({ match, action: action as ConnectorPolicyAction });
  }
  return { ok: true, value: out };
}

function coerceBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
    if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  }
  return fallback;
}

function err(slug: string, message: string): ParseErr {
  return {
    ok: false,
    error: { slug, path: `${MANIFEST_FILENAME}#connectors.${slug}`, error: message },
  };
}
