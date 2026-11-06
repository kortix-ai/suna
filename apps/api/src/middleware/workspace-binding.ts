/**
 * THE credential fence, as one rule (Workspaces, design.md §3.2 C4):
 *
 *     a workspace-bound credential reaches a request
 *     only when the request's workspace is its own.
 *
 * A workspace-bound credential is a workspace key, a project CLI token or a
 * session token (`account_tokens.project_id` = W; the workspace id IS the
 * project id), or an OAuth token whose consent named W
 * (`oauth_access_tokens.bound_workspace_id`, `middleware/auth-oauth.ts`).
 * Person credentials (a Supabase JWT, a personal key with `project_id IS
 * NULL`, an unbound OAuth token) are never judged here: they act as the person
 * in each workspace, and `authorize` decides per workspace. A
 * service-account bearer belongs to exactly one account, and `authorize`
 * resolves it only inside that account (`resolvePrincipal`), so the engine
 * already confines it to its workspace.
 *
 * The fence never decides WHAT a credential may do inside its own workspace.
 * That is the holder's role (a person's key) or `grant ∩ ceiling − HUMAN_ONLY`
 * (a governed agent), decided in `iam/authorize.ts`. There is no second,
 * credential-class wall around workspace administration: a workspace key
 * manages its own workspace exactly as far as the person who minted it may.
 *
 * Every route has exactly ONE binding, in `WORKSPACE_BINDINGS` below. There is
 * no fallback rule: an unlisted path is refused (fail closed), and
 * `__tests__/unit-workspace-binding-coverage.test.ts` fails when any route in
 * `tests/spec/routes.generated.json` has no binding.
 *
 * The binding kinds:
 *
 *   path      The workspace is in the URL. `:workspaceId` (legacy
 *             `/v1/projects/:id` routes carry the same param name) passes when
 *             it is the credential's workspace. `/v1/accounts/:workspaceId/**`
 *             takes either id and resolves an account key through the
 *             account → workspace bijection (`workspace_id_of_account`). A
 *             `split_pending` account holds several workspaces, so it is wider
 *             than any one workspace key: `account-wider-than-workspace`.
 *   resource  The URL names a resource of one workspace: a sandbox (`/v1/p/:id`,
 *             resolved through `session_sandboxes`), a drive (the drive
 *             handlers check the workspace), or the session itself (the
 *             daemon-only platform sinks, session-bound credentials only).
 *   ambient   No workspace in the URL.
 *             `reach: 'credential'`: the handler scopes every read and write to
 *             the credential's own workspace (`GET /v1/workspaces` and
 *             `GET /v1/projects` list that one workspace, `/v1/projects/current`,
 *             cost summaries, `capture/me`).
 *             `reach: 'param'`: an `account_id`, `workspace_id` or `project_id`
 *             in the query or the JSON body names the workspace; it must be the
 *             credential's own. With none, the handler falls back to the
 *             credential's own account (`scopedAccountIdFor`'s bound account).
 *   platform  Admin, router, ops and other platform or machine surfaces:
 *             refused (`platform-route`).
 *   person    The person's own surfaces across workspaces (personal keys, the
 *             inbox, devices, invites, Chrome, private tunnel machines, the
 *             workspace list of `/v1/accounts`): refused (`person-route`).
 *             `/v1/me` and `/v1/accounts/me` are self-identity (`none`).
 *   none      No workspace data at all (self-identity, the managed skills,
 *             runtime build artifacts, feedback). Every credential passes.
 *
 * Bind by ROUTE PATTERN, never by router: `/v1/projects/:workspaceId/*` and its
 * `/v1/workspaces/:workspaceId/*` alias resolve through the same kind, so both
 * route families get one verdict.
 *
 * Refusal: `403 { code: 'credential_fence_refused', check, message }`. The
 * message reads "This workspace key cannot …" and keeps
 * `[check=token-project-scope:<check> …]` for log searches.
 */

import { WORKSPACE_ACCOUNT_FAMILIES } from '@kortix/shared/workspace-routes';
import { isUuid } from '../shared/validate';

export type WorkspaceBindingKind = 'path' | 'resource' | 'ambient' | 'platform' | 'person' | 'none';

/** The `check=` name a refusal reports. */
export type WorkspaceFenceCheck =
  | 'cross-workspace'
  | 'account-wider-than-workspace'
  | 'platform-route'
  | 'person-route'
  | 'foreign-sandbox'
  | 'default-deny';

/** The `code` every fence refusal carries. */
export const CREDENTIAL_FENCE_REFUSED_CODE = 'credential_fence_refused';

export type WorkspaceBinding =
  /**
   * `via: 'account'` = the param may be a legacy account key, resolved through
   * the bijection. `family: true` = the route acts on the account's shared rows
   * (members, IAM, billing settings, …): wider than one workspace while the
   * account is split_pending, so a key of one of its workspaces is refused.
   */
  | { kind: 'path'; param: 'workspaceId'; via?: 'account'; family?: boolean }
  | { kind: 'resource'; resource: 'sandbox' | 'drive' | 'own-session' }
  | { kind: 'ambient'; reach: 'credential' | 'param' }
  | { kind: 'platform' }
  | { kind: 'person' }
  | { kind: 'none' };

export interface WorkspaceBindingRule {
  /**
   * The route pattern, Hono-style: `:name` is one path segment, a trailing `/*`
   * is the path itself plus anything below it (`/v1/skills/*` matches
   * `/v1/skills/x` and `/v1/skills/x/y`, not `/v1/skills`).
   */
  pattern: string;
  /** Methods this rule covers; absent = every method. */
  methods?: readonly string[];
  binding: WorkspaceBinding;
  /** Only a SESSION-bound credential (the in-sandbox daemon) passes. */
  sessionBoundOnly?: boolean;
}

const PATH: WorkspaceBinding = { kind: 'path', param: 'workspaceId' };
const PATH_OR_ACCOUNT: WorkspaceBinding = { kind: 'path', param: 'workspaceId', via: 'account' };
const ACCOUNT_FAMILY: WorkspaceBinding = { kind: 'path', param: 'workspaceId', via: 'account', family: true };
const OWN_WORKSPACE: WorkspaceBinding = { kind: 'ambient', reach: 'credential' };
const PARAM: WorkspaceBinding = { kind: 'ambient', reach: 'param' };
const PLATFORM: WorkspaceBinding = { kind: 'platform' };
const PERSON: WorkspaceBinding = { kind: 'person' };
const NONE: WorkspaceBinding = { kind: 'none' };
const OWN_SESSION: WorkspaceBinding = { kind: 'resource', resource: 'own-session' };

const both = (prefix: string, binding: WorkspaceBinding): WorkspaceBindingRule[] => [
  { pattern: prefix, binding },
  { pattern: `${prefix}/*`, binding },
];

/**
 * Every route family, first match wins. Order matters only where two patterns
 * overlap; each overlap is commented.
 */
export const WORKSPACE_BINDINGS: readonly WorkspaceBindingRule[] = [
  // ── none: no workspace data ────────────────────────────────────────────
  // Self-identity: "which workspace, session and agent am I bound to?"
  { pattern: '/v1/accounts/me', binding: NONE },
  { pattern: '/v1/me', binding: NONE },
  // Kortix-managed system skills: static template text, identical for everyone.
  ...both('/v1/skills', NONE),
  // The deploy's own build artifacts (daemon, CLI, managed skills).
  { pattern: '/v1/runtime-assets/*', binding: NONE },
  // `kortix feedback`: one row for the token's own user, nothing read back.
  { pattern: '/v1/feedback', methods: ['POST'], binding: NONE },

  // ── resource: the session itself (daemon-only sinks) ───────────────────
  // Reached only with the session's own KORTIX_TOKEN; each handler re-verifies
  // the sandbox ∧ session ∧ account binding (isSessionSandboxCredential).
  { pattern: '/v1/platform/runtime-projection', binding: OWN_SESSION, sessionBoundOnly: true },
  { pattern: '/v1/platform/boot-timeline', binding: OWN_SESSION, sessionBoundOnly: true },
  // Kortix in Chrome: the session asks for its owner's browser.
  { pattern: '/v1/chrome/attach', binding: OWN_SESSION, sessionBoundOnly: true },
  { pattern: '/v1/chrome/release', binding: OWN_SESSION, sessionBoundOnly: true },
  { pattern: '/v1/chrome/connections', methods: ['GET'], binding: OWN_SESSION, sessionBoundOnly: true },

  // ── ambient, bound by the handler to the credential's own workspace ────
  { pattern: '/v1/usage/cost-summary', methods: ['GET'], binding: OWN_WORKSPACE },
  { pattern: '/v1/usage/cost-by-project', methods: ['GET'], binding: OWN_WORKSPACE },
  { pattern: '/v1/capture/me/*', methods: ['GET'], binding: OWN_WORKSPACE },
  // Before `/v1/projects/:workspaceId`, which also matches `current`.
  { pattern: '/v1/projects/current', methods: ['GET'], binding: OWN_WORKSPACE },
  { pattern: '/v1/workspaces/current', methods: ['GET'], binding: OWN_WORKSPACE },
  // The workspace list: a bound credential lists its one workspace. Creating a
  // workspace is a person's act (the handler answers 403
  // new_workspace_requires_person to any key).
  { pattern: '/v1/projects', methods: ['GET'], binding: OWN_WORKSPACE },
  { pattern: '/v1/workspaces', methods: ['GET'], binding: OWN_WORKSPACE },
  // POST /v1/workspaces reaches its handler, which refuses every bound
  // credential with the coded 403 new_workspace_requires_person (WS-ROUTE-9).
  { pattern: '/v1/workspaces', methods: ['POST'], binding: OWN_WORKSPACE },
  { pattern: '/v1/projects', binding: PERSON },
  { pattern: '/v1/workspaces', binding: PERSON },

  // ── resource: drives (keyed by drive id; the handler checks the workspace) ─
  ...both('/v1/drives', { kind: 'resource', resource: 'drive' }),

  // ── the person's own surfaces (before `/v1/accounts/:workspaceId`) ─────
  // The person's workspace list, account creation, personal keys and devices.
  { pattern: '/v1/accounts', binding: PERSON },
  ...both('/v1/accounts/tokens', PERSON),
  { pattern: '/v1/accounts/me/*', binding: PERSON },
  { pattern: '/v1/me/*', binding: PERSON },

  // ── path: the workspace is in the URL ──────────────────────────────────
  // Legacy account routes take a workspace id or an account key; they act on
  // the account's shared rows, so a split_pending account is wider than a key.
  ...both('/v1/accounts/:workspaceId', ACCOUNT_FAMILY),
  // The account families under the canonical name (design.md §3.2 C5). The
  // workspace audit log (`GET …/audit`) is the workspace's own, not a family.
  { pattern: '/v1/workspaces/:workspaceId/audit', methods: ['GET'], binding: PATH_OR_ACCOUNT },
  // The project audit slice, canonical name of `GET /v1/projects/:workspaceId/audit`
  // (a project route, PATH there): the same binding, before the audit family.
  { pattern: '/v1/workspaces/:workspaceId/audit/events', methods: ['GET'], binding: PATH },
  ...WORKSPACE_ACCOUNT_FAMILIES.flatMap((family) => both(`/v1/workspaces/:workspaceId/${family}`, ACCOUNT_FAMILY)),
  ...both('/v1/projects/:workspaceId', PATH),
  ...both('/v1/connectors/projects/:workspaceId', PATH),
  // The canonical families also accept the account key of a 1:1 workspace
  // during the legacy-tolerant window (the account-family alias resolves it).
  ...both('/v1/workspaces/:workspaceId', PATH_OR_ACCOUNT),
  ...both('/v1/connectors/workspaces/:workspaceId', PATH),

  // ── resource: the sandbox proxy ────────────────────────────────────────
  // `/v1/p/auth/*` and `/v1/p/share/*` are not sandboxes (extractPreviewSandboxId).
  ...both('/v1/p/auth', PERSON),
  ...both('/v1/p/share', PERSON),
  ...both('/v1/p/:sandboxId', { kind: 'resource', resource: 'sandbox' }),

  // ── billing: the workspace is a param ──────────────────────────────────
  // Machine and deletion surfaces first; they overlap `/v1/billing/*`.
  ...both('/v1/billing/cron', PLATFORM),
  ...both('/v1/billing/webhook', PLATFORM),
  ...both('/v1/billing/webhooks', PLATFORM),
  { pattern: '/v1/billing/deduct', binding: PLATFORM },
  { pattern: '/v1/billing/deduct-usage', binding: PLATFORM },
  // Account deletion deletes the PERSON (design.md §3.1 finding 2).
  ...both('/v1/billing/account', PERSON),
  ...both('/v1/billing', PARAM),

  // ── the person's own surfaces ──────────────────────────────────────────
  ...[
    '/v1/access', '/v1/account', '/v1/account-invites', '/v1/approval-links', '/v1/apps',
    '/v1/artifacts', '/v1/auth', '/v1/capture', '/v1/channels', '/v1/chrome', '/v1/cli',
    '/v1/clients', '/v1/feedback', '/v1/invites', '/v1/mcp', '/v1/notifications', '/v1/oauth',
    '/v1/sessions', '/v1/setup-links', '/v1/tunnel', '/v1/usage',
  ].flatMap((prefix) => both(prefix, PERSON)),

  // ── platform and machine surfaces ──────────────────────────────────────
  ...[
    '/v1/admin', '/v1/connectors', '/v1/docs', '/v1/edge', '/v1/generation', '/v1/git',
    '/v1/health', '/v1/llm', '/v1/llm-gateway', '/v1/marketplace', '/v1/openapi.json', '/v1/ops',
    '/v1/platform', '/v1/prewarm', '/v1/public', '/v1/router', '/v1/runtime-assets', '/v1/system',
    '/v1/user-roles', '/v1/webhooks',
  ].flatMap((prefix) => both(prefix, PLATFORM)),

  // ── public or separately authenticated (never behind the key fence) ────
  // Listed so every route has a binding; a workspace key that ever reached
  // the fence here is refused.
  ...['/.well-known', '/health', '/internal', '/metrics', '/robots.txt', '/scim', '/sitemap.xml'].flatMap(
    (prefix) => both(prefix, PLATFORM),
  ),
];

// ─── Matching ────────────────────────────────────────────────────────────────

interface CompiledRule {
  rule: WorkspaceBindingRule;
  regex: RegExp;
  params: string[];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Compile a rule pattern. `:name` = one non-empty segment; a trailing `/*` = `/` + anything. */
export function compileBindingPattern(pattern: string): { regex: RegExp; params: string[] } {
  const wildcard = pattern.endsWith('/*');
  const base = wildcard ? pattern.slice(0, -2) : pattern;
  const params: string[] = [];
  const body = base
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        params.push(segment.slice(1));
        return '([^/]+)';
      }
      return escapeRegex(segment);
    })
    .join('/');
  return { regex: new RegExp(`^${body}${wildcard ? '/.*' : ''}$`), params };
}

const COMPILED: readonly CompiledRule[] = WORKSPACE_BINDINGS.map((rule) => ({ rule, ...compileBindingPattern(rule.pattern) }));

export interface MatchedBinding {
  rule: WorkspaceBindingRule;
  params: Record<string, string>;
}

/** A uuid in canonical (lowercase) form; anything else unchanged. Uuids are case-insensitive on input (C5). */
export function canonicalIdParam(value: string): string {
  return isUuid(value) ? value.toLowerCase() : value;
}

/** The binding of one request, or null when no rule lists it (refused). Captured uuid params are lowercase. */
export function bindingFor(method: string, path: string): MatchedBinding | null {
  const m = method.toUpperCase();
  for (const compiled of COMPILED) {
    if (compiled.rule.methods && !compiled.rule.methods.includes(m)) continue;
    const hit = compiled.regex.exec(path);
    if (!hit) continue;
    const params: Record<string, string> = {};
    compiled.params.forEach((name, i) => {
      params[name] = canonicalIdParam(hit[i + 1]!);
    });
    return { rule: compiled.rule, params };
  }
  return null;
}

// ─── The decision ────────────────────────────────────────────────────────────

export type WorkspaceFenceVerdict = { allowed: true } | { allowed: false; check: WorkspaceFenceCheck; reason: string };

export interface WorkspaceCredential {
  /** The workspace the credential is bound to (`account_tokens.project_id`). */
  workspaceId: string;
  /** A session credential (the in-sandbox `KORTIX_TOKEN`). */
  sessionBound: boolean;
}

/** What `account → workspace` gives: the one live workspace, `ambiguous` (split_pending), or null (unknown). */
export type AccountWorkspace = string | 'ambiguous' | null;

export interface WorkspaceFenceDeps {
  /** The workspace that owns a sandbox, or null when unknown. */
  sandboxWorkspace(sandboxId: string): Promise<string | null>;
  /** True when the workspace belongs to a split_pending legacy account. Optional: absent = never. */
  workspaceSplitPending?(workspaceId: string): Promise<boolean>;
  /** The workspace of a legacy account key (`workspace_id_of_account`). */
  accountWorkspace(accountId: string): Promise<AccountWorkspace>;
}

/** The ids a `reach: 'param'` request names, from the query string and the JSON body. */
export interface WorkspaceParams {
  ids: readonly string[];
}

const REFUSALS: Record<WorkspaceFenceCheck, string> = {
  'cross-workspace': 'This workspace key cannot access another workspace',
  'account-wider-than-workspace': 'This workspace key cannot act on a legacy account that holds several workspaces; name the workspace',
  'platform-route': 'This workspace key cannot call platform routes',
  'person-route': "This workspace key cannot call a person's own routes; use a personal key or sign in",
  'foreign-sandbox': 'This workspace key cannot access a sandbox outside its workspace',
  'default-deny': 'This workspace key cannot call this route',
};

const refuse = (check: WorkspaceFenceCheck): WorkspaceFenceVerdict => ({ allowed: false, check, reason: REFUSALS[check] });
const ALLOWED: WorkspaceFenceVerdict = { allowed: true };

/** Does one id (a workspace id or a legacy account key) name the credential's workspace? */
async function namesOwnWorkspace(
  id: string,
  credential: WorkspaceCredential,
  deps: WorkspaceFenceDeps,
  viaAccount: boolean,
): Promise<WorkspaceFenceVerdict> {
  const canonical = canonicalIdParam(id);
  if (canonical === credential.workspaceId) return ALLOWED;
  if (!viaAccount || !isUuid(canonical)) return refuse('cross-workspace');
  const workspace = await deps.accountWorkspace(canonical);
  if (workspace === credential.workspaceId) return ALLOWED;
  return refuse(workspace === 'ambiguous' ? 'account-wider-than-workspace' : 'cross-workspace');
}

/**
 * `credential.workspace == binding(request).workspace`, for one request.
 *
 * Pure apart from the two lookups in `deps`.
 */
export async function workspaceFenceVerdict(
  method: string,
  path: string,
  credential: WorkspaceCredential,
  deps: WorkspaceFenceDeps,
  params: WorkspaceParams = { ids: [] },
): Promise<WorkspaceFenceVerdict> {
  const matched = bindingFor(method, path);
  if (!matched) return refuse('default-deny');
  const { rule } = matched;
  if (rule.sessionBoundOnly && !credential.sessionBound) {
    // The daemon sinks: a plain workspace key never reaches them.
    return refuse('platform-route');
  }
  const b = rule.binding;
  switch (b.kind) {
    case 'none':
      return ALLOWED;
    case 'platform':
      return refuse('platform-route');
    case 'person':
      return refuse('person-route');
    case 'path': {
      const verdict = await namesOwnWorkspace(matched.params[b.param]!, credential, deps, b.via === 'account');
      if (verdict.allowed && b.family && (await deps.workspaceSplitPending?.(credential.workspaceId))) {
        return refuse('account-wider-than-workspace');
      }
      return verdict;
    }
    case 'resource': {
      if (b.resource === 'own-session' || b.resource === 'drive') return ALLOWED;
      const owner = await deps.sandboxWorkspace(matched.params.sandboxId!);
      return owner !== null && owner === credential.workspaceId ? ALLOWED : refuse('foreign-sandbox');
    }
    case 'ambient': {
      if (b.reach === 'credential') return ALLOWED;
      for (const id of params.ids) {
        const verdict = await namesOwnWorkspace(id, credential, deps, true);
        if (!verdict.allowed) return verdict;
      }
      return ALLOWED;
    }
  }
}

/** The param names a `reach: 'param'` route reads its workspace from. */
export const WORKSPACE_PARAM_NAMES = ['account_id', 'workspace_id', 'project_id'] as const;

/** Does this request need its query and body read (a `reach: 'param'` route)? */
export function readsWorkspaceParams(method: string, path: string): boolean {
  const matched = bindingFor(method, path);
  return matched?.rule.binding.kind === 'ambient' && matched.rule.binding.reach === 'param';
}
