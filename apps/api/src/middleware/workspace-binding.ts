/**
 * THE credential fence, as one rule (Workspaces, design.md §5):
 *
 *     a workspace-bound credential reaches a route
 *     only when the route binds to that same workspace.
 *
 * A workspace-bound credential is a project PAT or a session PAT
 * (`account_tokens.project_id` set; the workspace id IS the project id). Every
 * route has exactly ONE binding, in `WORKSPACE_BINDINGS` below. There is no
 * fallback rule: an unlisted path is refused (fail closed), and
 * `__tests__/unit-workspace-binding-coverage.test.ts` fails when any route in
 * `tests/spec/routes.generated.json` has no binding, so an unlisted route fails
 * in CI instead of answering 403 in production.
 *
 * The four binding kinds:
 *
 *   path      The workspace is in the URL: `:projectId` or `:workspaceId`. The
 *             credential passes when the URL id is its own workspace.
 *   resource  The URL names a resource of one workspace: a sandbox (`/v1/p/:id`,
 *             resolved through `session_sandboxes`), a drive (resolved by the
 *             drive handlers, `drives/routes.ts`), or the session itself (the
 *             daemon-only platform sinks, session-bound credentials only).
 *   ambient   No workspace in the URL. `reach: 'credential'` = the handler
 *             binds every read and write to the credential's OWN workspace
 *             (`/v1/projects/current`, cost summaries, `capture/me`), so the
 *             credential passes. `reach: 'account'` = the route acts on an
 *             account, on many workspaces or on the platform (billing, the
 *             router, admin, the project list), so a workspace-bound
 *             credential is refused.
 *   none      The route serves no workspace data at all (self-identity, the
 *             managed skills, runtime build artifacts, feedback). Every
 *             credential passes; the handler authenticates.
 *
 * `admin: true` marks workspace ADMINISTRATION: the account surface (members,
 * IAM, billing settings, SSO, tokens, Capture admin, audit) under
 * `/v1/accounts/*` and its `/v1/workspaces/:workspaceId/<subtree>` aliases. A
 * workspace-bound credential never reaches it, even for its own workspace.
 * That is the credential half of "an agent never inherits workspace
 * administration"; the engine half is `iam/authorize.ts` step 4b.
 *
 * Account-wide credentials (an account PAT, a JWT, a service account, OAuth)
 * are not workspace-bound and are not judged here: `authorize` decides for
 * them, as it always has. Changing that would break every account PAT used
 * across a person's accounts, which compatibility rules out.
 *
 * Bind by ROUTE PATTERN, never by router: `/v1/projects/:projectId/*` and its
 * `/v1/workspaces/:workspaceId/*` alias resolve through the same kind, so both
 * route families get one verdict.
 *
 * Every denial message keeps the `check=token-project-scope:<check>` names the
 * old per-route allowlist used (`account-level-route`, `cross-project`,
 * `project-list`, `foreign-sandbox`, `default-deny`), so log searches and
 * dashboards keep working.
 */

export type WorkspaceBindingKind = 'path' | 'resource' | 'ambient' | 'none';

/** The `check=` name a denial reports. */
export type WorkspaceFenceCheck =
  | 'account-level-route'
  | 'cross-project'
  | 'project-list'
  | 'foreign-sandbox'
  | 'default-deny';

export type WorkspaceBinding =
  | { kind: 'path'; param: 'projectId' | 'workspaceId' }
  | { kind: 'resource'; resource: 'sandbox' | 'drive' | 'own-session' }
  | { kind: 'ambient'; reach: 'credential' | 'account'; check?: WorkspaceFenceCheck }
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
  /** Workspace administration: never reached by a workspace-bound credential. */
  admin?: boolean;
  /** Only a SESSION-bound credential (the in-sandbox daemon) passes. */
  sessionBoundOnly?: boolean;
}

const PATH_PROJECT: WorkspaceBinding = { kind: 'path', param: 'projectId' };
const PATH_WORKSPACE: WorkspaceBinding = { kind: 'path', param: 'workspaceId' };
const OWN_WORKSPACE: WorkspaceBinding = { kind: 'ambient', reach: 'credential' };
const ACCOUNT_SURFACE: WorkspaceBinding = { kind: 'ambient', reach: 'account' };
const ACCOUNT_ADMIN: WorkspaceBinding = { kind: 'ambient', reach: 'account', check: 'account-level-route' };
const PROJECT_LIST: WorkspaceBinding = { kind: 'ambient', reach: 'account', check: 'project-list' };
const NONE: WorkspaceBinding = { kind: 'none' };

/**
 * The account subtrees that collapse into `/v1/workspaces/:workspaceId/<x>`
 * (design.md §4). They are workspace administration. `audit` is special:
 * `GET /v1/workspaces/:workspaceId/audit` is the project audit (path-bound),
 * everything below it is the account audit (administration).
 */
export const WORKSPACE_ADMIN_SUBTREES = [
  'iam',
  'capture',
  'secret-resources',
  'branding',
  'members',
  'invites',
  'automations',
  'subscription-connections',
  'top-up-requests',
  'leave',
  'tokens',
] as const;

/**
 * Every route family, first match wins. Order matters only where two patterns
 * overlap; each overlap is commented.
 */
export const WORKSPACE_BINDINGS: readonly WorkspaceBindingRule[] = [
  // ── none: no workspace data ────────────────────────────────────────────
  // Self-identity: "which workspace, session and agent am I bound to?"
  // `/v1/me` is its alias (design.md §4); `/v1/me/*` stays administration like `/v1/accounts/me/*`.
  { pattern: '/v1/accounts/me', binding: NONE },
  { pattern: '/v1/me', binding: NONE },
  { pattern: '/v1/me/*', binding: ACCOUNT_ADMIN, admin: true },
  // Kortix-managed system skills: static template text, identical for everyone.
  { pattern: '/v1/skills', binding: NONE },
  { pattern: '/v1/skills/*', binding: NONE },
  // The deploy's own build artifacts (daemon, CLI, managed skills).
  { pattern: '/v1/runtime-assets/*', binding: NONE },
  // `kortix feedback`: one row for the token's own user, nothing read back.
  { pattern: '/v1/feedback', methods: ['POST'], binding: NONE },

  // ── resource: the session itself (daemon-only sinks) ───────────────────
  // Reached only with the session's own KORTIX_TOKEN; each handler re-verifies
  // the sandbox ∧ session ∧ account binding (isSessionSandboxCredential).
  { pattern: '/v1/platform/runtime-projection', binding: { kind: 'resource', resource: 'own-session' }, sessionBoundOnly: true },
  { pattern: '/v1/platform/boot-timeline', binding: { kind: 'resource', resource: 'own-session' }, sessionBoundOnly: true },
  // Kortix in Chrome: the session asks for its owner's browser.
  { pattern: '/v1/chrome/attach', binding: { kind: 'resource', resource: 'own-session' }, sessionBoundOnly: true },
  { pattern: '/v1/chrome/release', binding: { kind: 'resource', resource: 'own-session' }, sessionBoundOnly: true },
  { pattern: '/v1/chrome/connections', methods: ['GET'], binding: { kind: 'resource', resource: 'own-session' }, sessionBoundOnly: true },

  // ── ambient, bound by the handler to the credential's own workspace ────
  { pattern: '/v1/usage/cost-summary', methods: ['GET'], binding: OWN_WORKSPACE },
  { pattern: '/v1/usage/cost-by-project', methods: ['GET'], binding: OWN_WORKSPACE },
  { pattern: '/v1/capture/me/*', methods: ['GET'], binding: OWN_WORKSPACE },
  // Before `/v1/projects/:projectId`, which also matches `current`.
  { pattern: '/v1/projects/current', methods: ['GET'], binding: OWN_WORKSPACE },
  { pattern: '/v1/workspaces/current', methods: ['GET'], binding: OWN_WORKSPACE },

  // ── resource: drives (keyed by drive id; the handler checks the workspace) ─
  { pattern: '/v1/drives', binding: { kind: 'resource', resource: 'drive' } },
  { pattern: '/v1/drives/*', binding: { kind: 'resource', resource: 'drive' } },

  // ── administration: the account surface ────────────────────────────────
  { pattern: '/v1/accounts', binding: ACCOUNT_ADMIN, admin: true },
  { pattern: '/v1/accounts/*', binding: ACCOUNT_ADMIN, admin: true },
  // The project audit keeps its path binding; the account audit below it is administration.
  { pattern: '/v1/workspaces/:workspaceId/audit', methods: ['GET'], binding: PATH_WORKSPACE },
  { pattern: '/v1/workspaces/:workspaceId/audit/*', binding: ACCOUNT_ADMIN, admin: true },
  ...WORKSPACE_ADMIN_SUBTREES.flatMap((subtree): WorkspaceBindingRule[] => [
    { pattern: `/v1/workspaces/:workspaceId/${subtree}`, binding: ACCOUNT_ADMIN, admin: true },
    { pattern: `/v1/workspaces/:workspaceId/${subtree}/*`, binding: ACCOUNT_ADMIN, admin: true },
  ]),

  // ── path: the workspace is in the URL ──────────────────────────────────
  { pattern: '/v1/projects/:projectId', binding: PATH_PROJECT },
  { pattern: '/v1/projects/:projectId/*', binding: PATH_PROJECT },
  { pattern: '/v1/connectors/projects/:projectId', binding: PATH_PROJECT },
  { pattern: '/v1/connectors/projects/:projectId/*', binding: PATH_PROJECT },
  { pattern: '/v1/workspaces/:workspaceId', binding: PATH_WORKSPACE },
  { pattern: '/v1/workspaces/:workspaceId/*', binding: PATH_WORKSPACE },
  { pattern: '/v1/connectors/workspaces/:workspaceId', binding: PATH_WORKSPACE },
  { pattern: '/v1/connectors/workspaces/:workspaceId/*', binding: PATH_WORKSPACE },

  // ── ambient across workspaces: the list ────────────────────────────────
  { pattern: '/v1/projects', binding: PROJECT_LIST },
  { pattern: '/v1/workspaces', binding: PROJECT_LIST },

  // ── resource: the sandbox proxy ────────────────────────────────────────
  // `/v1/p/auth/*` and `/v1/p/share/*` are not sandboxes (extractPreviewSandboxId);
  // they are listed first and refused like any account surface.
  { pattern: '/v1/p/auth', binding: ACCOUNT_SURFACE },
  { pattern: '/v1/p/auth/*', binding: ACCOUNT_SURFACE },
  { pattern: '/v1/p/share', binding: ACCOUNT_SURFACE },
  { pattern: '/v1/p/share/*', binding: ACCOUNT_SURFACE },
  { pattern: '/v1/p/:sandboxId', binding: { kind: 'resource', resource: 'sandbox' } },
  { pattern: '/v1/p/:sandboxId/*', binding: { kind: 'resource', resource: 'sandbox' } },

  // ── ambient account / platform surfaces: refused for a workspace-bound credential ─
  ...[
    '/v1/access', '/v1/account', '/v1/account-invites', '/v1/admin', '/v1/approval-links',
    '/v1/apps', '/v1/artifacts', '/v1/auth', '/v1/billing', '/v1/capture', '/v1/channels',
    '/v1/chrome', '/v1/cli', '/v1/clients', '/v1/connectors', '/v1/docs', '/v1/edge',
    '/v1/feedback', '/v1/generation', '/v1/git', '/v1/health', '/v1/invites', '/v1/llm',
    '/v1/llm-gateway', '/v1/marketplace', '/v1/mcp', '/v1/notifications', '/v1/oauth',
    '/v1/openapi.json', '/v1/ops', '/v1/platform', '/v1/prewarm', '/v1/public', '/v1/router',
    '/v1/runtime-assets', '/v1/sessions', '/v1/setup-links', '/v1/system', '/v1/tunnel',
    '/v1/usage', '/v1/user-roles', '/v1/webhooks',
  ].flatMap((prefix): WorkspaceBindingRule[] => [
    { pattern: prefix, binding: ACCOUNT_SURFACE },
    { pattern: `${prefix}/*`, binding: ACCOUNT_SURFACE },
  ]),

  // ── public or separately authenticated (never behind the PAT fence) ────
  // Listed so every route has a binding; a workspace-bound PAT that ever
  // reached the fence here is refused.
  ...['/.well-known', '/health', '/internal', '/metrics', '/robots.txt', '/scim', '/sitemap.xml'].flatMap(
    (prefix): WorkspaceBindingRule[] => [
      { pattern: prefix, binding: ACCOUNT_SURFACE },
      { pattern: `${prefix}/*`, binding: ACCOUNT_SURFACE },
    ],
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

/** The binding of one request, or null when no rule lists it (refused). */
export function bindingFor(method: string, path: string): MatchedBinding | null {
  const m = method.toUpperCase();
  for (const compiled of COMPILED) {
    if (compiled.rule.methods && !compiled.rule.methods.includes(m)) continue;
    const hit = compiled.regex.exec(path);
    if (!hit) continue;
    const params: Record<string, string> = {};
    compiled.params.forEach((name, i) => {
      params[name] = hit[i + 1]!;
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

export interface WorkspaceFenceDeps {
  /** The workspace that owns a sandbox, or null when unknown. */
  sandboxWorkspace(sandboxId: string): Promise<string | null>;
}

const REFUSALS: Record<WorkspaceFenceCheck, string> = {
  'account-level-route': 'Project-scoped token cannot call account-level routes',
  'cross-project': 'Project-scoped token cannot access a different project',
  'project-list': 'Project-scoped token cannot list projects',
  'foreign-sandbox': 'Project-scoped token cannot access a sandbox outside its project',
  'default-deny': 'Project-scoped token cannot call this surface',
};

const refuse = (check: WorkspaceFenceCheck): WorkspaceFenceVerdict => ({ allowed: false, check, reason: REFUSALS[check] });

/**
 * `credential.workspace == binding(route).workspace`, for one request.
 *
 * Pure apart from `deps.sandboxWorkspace`, the one binding that needs a lookup.
 */
export async function workspaceFenceVerdict(
  method: string,
  path: string,
  credential: WorkspaceCredential,
  deps: WorkspaceFenceDeps,
): Promise<WorkspaceFenceVerdict> {
  const matched = bindingFor(method, path);
  if (!matched) return refuse('default-deny');
  const { rule, params } = matched;
  if (rule.sessionBoundOnly && !credential.sessionBound) {
    // The method-less rule for the same path decides; for these daemon sinks it
    // is the platform surface, which a plain workspace PAT never reaches.
    return refuse('default-deny');
  }
  if (rule.admin) return refuse(rule.binding.kind === 'ambient' && rule.binding.check ? rule.binding.check : 'account-level-route');

  const b = rule.binding;
  switch (b.kind) {
    case 'none':
      return { allowed: true };
    case 'path':
      return params[b.param] === credential.workspaceId ? { allowed: true } : refuse('cross-project');
    case 'resource': {
      if (b.resource === 'own-session' || b.resource === 'drive') return { allowed: true };
      const owner = await deps.sandboxWorkspace(params.sandboxId!);
      return owner !== null && owner === credential.workspaceId ? { allowed: true } : refuse('foreign-sandbox');
    }
    case 'ambient':
      return b.reach === 'credential' ? { allowed: true } : refuse(b.check ?? 'default-deny');
  }
}
