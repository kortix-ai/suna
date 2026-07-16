/**
 * `connectors` list parsing for the project manifest (`kortix.yaml`; a legacy
 * v1 project may instead declare `[[connectors]]` in `kortix.toml`).
 *
 * A connector is one named integration the Executor can call — Pipedream,
 * MCP, OpenAPI, GraphQL, or raw HTTP. The manifest holds the *definition*
 * (provider, endpoint/spec, auth method + which project-secret to use) and,
 * for the policy layer, each connector's `policies:` list. The
 * secret *value* and Pipedream OAuth live in the platform, never in git.
 * Connectors are project-wide visible — the only access gate is which AGENTS
 * may call it (`agents.<name>.connectors`, declared on the agent, in git).
 *
 * Example (kortix.yaml):
 *
 *   connectors:
 *     - slug: stripe
 *       name: Stripe API
 *       provider: openapi
 *       spec: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json"
 *       auth:
 *         type: bearer
 *         secret: STRIPE_API_KEY     # project-secret NAME; value set in dashboard
 *       policies:                    # connector-scoped; built last
 *         - match: "*.delete*"
 *           action: block
 *     - slug: gmail-work
 *       provider: pipedream
 *       app: gmail
 *       account: work                # 1-click connected in the dashboard
 *
 * Parser mirrors `projects/agents.ts` + `projects/triggers.ts`: never throws on
 * a bad entry, collects them in `errors` so the UI can render them next to the
 * good ones. CRUD round-trips this same file (connectorSpecToTomlEntry).
 */
import { createHash } from 'node:crypto';
import { MANIFEST_FILENAME, type ParsedManifest } from './triggers';
import { isValidSecretName } from './secrets';
import { CHANNEL_PLATFORMS, RESERVED_SLUG_PROVIDERS, SLUG_RE } from '@kortix/manifest-schema';

export type ConnectorProvider = 'pipedream' | 'mcp' | 'openapi' | 'graphql' | 'http' | 'channel' | 'computer';
const PROVIDERS: readonly ConnectorProvider[] = ['pipedream', 'mcp', 'openapi', 'graphql', 'http', 'channel', 'computer'];

/**
 * Platform-owned slugs and the ONLY provider allowed to use each. These are
 * install-driven, first-class connectors — the Slack channel and the Agent
 * Computer Tunnel — so a user app must never take the slug and shadow the
 * built-in catalog (the bug that made `slack thread` 404 with action_not_found,
 * fixed for Slack in #3670). Enforced in the parser (reject the wrong provider)
 * AND at CRUD via RESERVED_CONNECTOR_SLUGS, which also blocks the public `slack`
 * NAME so a Pipedream Slack can't be added (the picker already hides it).
 *
 *  - `kortix_slack` → channel only (the Slack channel materializes under it; see
 *    executor/channels.ts SLACK_CHANNEL_CONNECTOR_SLUG).
 *  - `computer`     → computer only (the Agent Computer Tunnel connector).
 * See KORTIX-206 + docs/specs/computer-connector.md. The pairs themselves are
 * canonically defined in `@kortix/manifest-schema` (imported above) — this
 * `export` just preserves this module's existing public surface, since
 * executor/manifest-crud.ts imports `RESERVED_SLUG_PROVIDERS` from here.
 */
export { RESERVED_SLUG_PROVIDERS };
/** The reserved slug the built-in Slack channel materializes under. */
export const SLACK_RESERVED_SLUG = 'kortix_slack';
export const EMAIL_RESERVED_SLUG = 'kortix_email';
export const MEET_RESERVED_SLUG = 'kortix_meet';
export const RESERVED_CONNECTOR_SLUGS = new Set<string>([
  'slack',
  'email',
  'meet',
  ...Object.keys(RESERVED_SLUG_PROVIDERS),
]);

/** Chat platforms a `channel` connector can target. */
export type ChannelPlatform = 'slack' | 'teams' | 'email' | 'meet';

type ConnectorAuthType = 'bearer' | 'basic' | 'custom' | 'oauth1' | 'none';
const AUTH_TYPES: readonly ConnectorAuthType[] = ['bearer', 'basic', 'custom', 'oauth1', 'none'];

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
  /** e.g. `kortix.yaml#connectors.<slug>` (or the project's actual manifest filename) for UI / error reporting. */
  path: string;
  /** Human label; defaults to slug. */
  name: string;
  /** When false the materializer / gateway skip this entry. */
  enabled: boolean;
  provider: ConnectorProvider;
  /** Credential storage mode. `shared` is the only mode — `per_user` (each
   *  member brings their own) was removed 2026-07-05 (docs/specs/2026-07-05-
   *  agent-first-config-unification.md §2.5). A manifest that still says
   *  `credential = "per_user"` is tolerated (legacy, warning-only) but always
   *  resolves to `shared` here — it can never round-trip back into git. */
  credentialMode: 'shared';
  /** Sensitive connector (email/files/secrets-bearing): reads gate too — every
   *  action defaults to require_approval unless an explicit policy opens it. */
  sensitive: boolean;
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
  /** channel: chat platform (slack | …) — selects the fixed action catalog + API base. */
  platform: ChannelPlatform | null;
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
 * Pull the `connectors` list out of a parsed manifest. Never throws.
 */
export function extractConnectors(manifest: ParsedManifest): LoadedConnectors {
  const filename = manifest.path || MANIFEST_FILENAME;
  const raw = manifest.raw.connectors;
  if (raw === undefined || raw === null) {
    return { specs: [], errors: [] };
  }
  if (!Array.isArray(raw)) {
    return {
      specs: [],
      errors: [{
        slug: '(top-level)',
        path: filename,
        error:
          manifest.format === 'yaml'
            ? '`connectors` must be a list — write it as a YAML `connectors:` list, not a map or scalar.'
            : '`connectors` must be an array of tables — use [[connectors]], not [connectors]',
      }],
    };
  }

  const specs: ConnectorSpec[] = [];
  const errors: ConnectorParseError[] = [];
  const seenSlugs = new Set<string>();

  raw.forEach((entry, index) => {
    const result = parseConnectorEntry(entry, index, filename);
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
 * Convert a ConnectorSpec back to the raw object that lives in
 * `manifest.raw.connectors` (serialized as YAML for `kortix.yaml`, or TOML
 * for a legacy v1 `kortix.toml`). Inverse of `parseConnectorEntry`. Used by
 * the CRUD path to round-trip a dashboard edit before committing.
 */
export function connectorSpecToTomlEntry(spec: ConnectorSpec): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    slug: spec.slug,
    name: spec.name,
    provider: spec.provider,
    enabled: spec.enabled,
  };
  // `shared` is the only mode and the implicit default for every provider —
  // never emit `credential` (mirrors how `sensitive: false` is omitted).
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
  } else if (spec.provider === 'channel') {
    if (spec.platform) entry.platform = spec.platform;
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
    platform: spec.platform,
    spec: spec.spec,
    auth: spec.auth,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

interface ParseOk { ok: true; spec: ConnectorSpec }
interface ParseErr { ok: false; error: ConnectorParseError }

function parseConnectorEntry(entry: unknown, index: number, filename: string = MANIFEST_FILENAME): ParseOk | ParseErr {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return err('(invalid)', `[[connectors]] entry #${index + 1} is not a table`, filename);
  }
  const row = entry as Record<string, unknown>;

  const slug = typeof row.slug === 'string' ? row.slug.trim() : '';
  if (!slug) return err(`(index-${index})`, `[[connectors]] entry #${index + 1} is missing a slug`, filename);
  if (!SLUG_RE.test(slug)) {
    return err(slug, `Invalid slug "${slug}" — lowercase letters, digits, dashes, underscores only`, filename);
  }

  const provider = typeof row.provider === 'string' ? row.provider.trim().toLowerCase() : '';
  if (!PROVIDERS.includes(provider as ConnectorProvider)) {
    return err(slug, `provider must be one of ${PROVIDERS.join(', ')} (got "${provider || 'unset'}")`, filename);
  }

  // Reserved platform-owned slugs: only the matching built-in provider may use
  // them, so a user app can never shadow the built-in catalog (the bug that made
  // `slack thread` resolve to a Pipedream Slack and 404 with action_not_found).
  // The public `slack` NAME stays parseable here (so existing manifests don't
  // break) but is blocked at the CRUD layer and hidden from the list once the
  // channel exists.
  const reservedProvider = RESERVED_SLUG_PROVIDERS[slug];
  if (reservedProvider && provider !== reservedProvider) {
    return err(
      slug,
      `"${slug}" is reserved for the built-in ${reservedProvider} connector (provider="${reservedProvider}")`,
      filename,
    );
  }

  const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : slug;
  const enabled = coerceBool(row.enabled, true);
  const sensitive = coerceBool(row.sensitive, false);

  // Credential mode — `shared` is the only mode. `per_user` is tolerated as a
  // legacy value (existing manifests that still say `credential = "per_user"`
  // parse fine, same as the manifest-schema validator's warning) but always
  // resolves to `shared` — it's never round-tripped back into git.
  const credRaw = typeof row.credential === 'string' ? row.credential.trim().toLowerCase() : '';
  if (credRaw && credRaw !== 'shared' && credRaw !== 'per_user') {
    return err(slug, 'credential must be "shared" ("per_user" is tolerated as a legacy value, resolving to "shared")', filename);
  }
  const credentialMode: 'shared' = 'shared';

  // Defaults; provider blocks fill them in.
  const base: Omit<ConnectorSpec, 'auth' | 'policies'> = {
    slug,
    path: `${filename}#connectors.${slug}`,
    name,
    enabled,
    provider: provider as ConnectorProvider,
    credentialMode,
    sensitive,
    app: null,
    account: null,
    url: null,
    transport: null,
    endpoint: null,
    baseUrl: null,
    platform: null,
    spec: null,
  };

  const providerParsed = parseProviderFields(slug, provider as ConnectorProvider, row, base, filename);
  if (!providerParsed.ok) return providerParsed;

  const authParsed = parseAuth(slug, provider as ConnectorProvider, row.auth, filename);
  if (!authParsed.ok) return authParsed;

  const policiesParsed = parsePolicies(slug, row.policies, filename);
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
  filename: string = MANIFEST_FILENAME,
): { ok: true; value: Omit<ConnectorSpec, 'auth' | 'policies'> } | ParseErr {
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

  if (provider === 'pipedream') {
    const app = str(row.app);
    if (!app) return err(slug, 'provider="pipedream" requires `app` (the Pipedream app slug)', filename);
    // account defaults to the slug — names the connected-account binding.
    const account = str(row.account) ?? slug;
    return { ok: true, value: { ...base, app, account } };
  }

  if (provider === 'mcp') {
    const url = str(row.url);
    if (!url) return err(slug, 'provider="mcp" requires `url` (the MCP server endpoint)', filename);
    const t = typeof row.transport === 'string' ? row.transport.trim().toLowerCase() : 'http';
    if (t !== 'http' && t !== 'sse') {
      return err(slug, `transport must be "http" or "sse" (got "${t}")`, filename);
    }
    return { ok: true, value: { ...base, url, transport: t } };
  }

  if (provider === 'openapi') {
    const spec = str(row.spec);
    if (!spec) return err(slug, 'provider="openapi" requires `spec` (a URL or repo-relative file path)', filename);
    return { ok: true, value: { ...base, spec } };
  }

  if (provider === 'channel') {
    const platform = (str(row.platform) ?? '').toLowerCase();
    if (!CHANNEL_PLATFORMS.includes(platform as ChannelPlatform)) {
      return err(slug, `provider="channel" requires platform one of ${CHANNEL_PLATFORMS.join(', ')} (got "${platform || 'unset'}")`, filename);
    }
    return { ok: true, value: { ...base, platform: platform as ChannelPlatform } };
  }

  if (provider === 'computer') {
    // Synth-only: connecting a machine over the Agent Computer Tunnel auto-
    // materializes a single `computer` connector. It can't be declared by hand.
    return err(slug, 'provider="computer" is managed automatically when you connect a machine (Computers) — it cannot be declared in kortix.yaml', filename);
  }

  if (provider === 'graphql') {
    const endpoint = str(row.endpoint);
    if (!endpoint) return err(slug, 'provider="graphql" requires `endpoint`', filename);
    // spec (SDL) is optional — omit to introspect at sync.
    return { ok: true, value: { ...base, endpoint, spec: str(row.spec) } };
  }

  // http
  const baseUrl = str(row.base_url) ?? str(row.baseUrl);
  if (!baseUrl) return err(slug, 'provider="http" requires `base_url`', filename);
  return { ok: true, value: { ...base, baseUrl, spec: str(row.spec) } };
}

function parseAuth(
  slug: string,
  provider: ConnectorProvider,
  raw: unknown,
  filename: string = MANIFEST_FILENAME,
): { ok: true; value: ConnectorAuthSpec } | ParseErr {
  // No auth table → none (pipedream authenticates via its connected account).
  if (raw === undefined || raw === null) return { ok: true, value: { ...NO_AUTH } };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return err(slug, '[connectors.auth] must be a table', filename);
  }
  const row = raw as Record<string, unknown>;

  const type = typeof row.type === 'string' ? row.type.trim().toLowerCase() : 'none';
  if (!AUTH_TYPES.includes(type as ConnectorAuthType)) {
    return err(slug, `[connectors.auth].type must be one of ${AUTH_TYPES.join(', ')} (got "${type}")`, filename);
  }
  if (provider === 'pipedream' && type !== 'none') {
    return err(slug, 'provider="pipedream" authenticates via its connected account — omit [connectors.auth]', filename);
  }
  if (provider === 'channel' && type !== 'none') {
    return err(slug, 'provider="channel" authenticates via its platform install token — omit [connectors.auth]', filename);
  }
  if (type === 'oauth1' && provider !== 'openapi' && provider !== 'http') {
    return err(slug, '[connectors.auth] type="oauth1" is only supported for openapi/http connectors');
  }

  if (type === 'none') return { ok: true, value: { ...NO_AUTH } };

  const inRaw = typeof row.in === 'string' ? row.in.trim().toLowerCase() : 'header';
  if (inRaw !== 'header' && inRaw !== 'query') {
    return err(slug, '[connectors.auth].in must be "header" or "query"', filename);
  }
  const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : null;
  if (type === 'custom' && !name) {
    return err(slug, '[connectors.auth] type="custom" requires `name` (the header/param name)', filename);
  }
  const prefix = typeof row.prefix === 'string' && row.prefix.trim() ? row.prefix.trim() : null;

  // `secret` is optional — credentials live in the platform (executor_credentials),
  // not as a named project secret. If present it's validated for back-compat.
  const secret = typeof row.secret === 'string' && row.secret.trim() ? row.secret.trim() : null;
  if (secret && !isValidSecretName(secret)) {
    return err(slug, `[connectors.auth].secret "${secret}" must look like a project-secret name (^[A-Z_][A-Z0-9_]{0,63}$)`, filename);
  }

  return { ok: true, value: { type: type as ConnectorAuthType, in: inRaw, name, prefix, secret } };
}

function parsePolicies(
  slug: string,
  raw: unknown,
  filename: string = MANIFEST_FILENAME,
): { ok: true; value: ConnectorPolicySpec[] } | ParseErr {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) {
    return err(slug, '[[connectors.policies]] must be an array of tables', filename);
  }
  const out: ConnectorPolicySpec[] = [];
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i];
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      return err(slug, `[[connectors.policies]] entry #${i + 1} is not a table`, filename);
    }
    const prow = p as Record<string, unknown>;
    const match = typeof prow.match === 'string' && prow.match.trim() ? prow.match.trim() : '';
    if (!match) return err(slug, `[[connectors.policies]] entry #${i + 1} is missing \`match\``, filename);
    const action = typeof prow.action === 'string' ? prow.action.trim().toLowerCase() : '';
    if (!POLICY_ACTIONS.includes(action as ConnectorPolicyAction)) {
      return err(slug, `[[connectors.policies]] \`action\` must be one of ${POLICY_ACTIONS.join(', ')} (got "${action || 'unset'}")`, filename);
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

function err(slug: string, message: string, filename: string = MANIFEST_FILENAME): ParseErr {
  return {
    ok: false,
    error: { slug, path: `${filename}#connectors.${slug}`, error: message },
  };
}
