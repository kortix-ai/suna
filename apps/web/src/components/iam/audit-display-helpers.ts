import type { UiTranslator } from '@/i18n/translator';

import { AUDIT_HTTP_ROUTES } from './audit-http-routes.generated';
import { AUDIT_TITLE_TRANSLATION_KEYS } from './audit-title-translation-keys.generated';

export { AUDIT_HTTP_ROUTES } from './audit-http-routes.generated';

// Humanise audit-event actions into "Set personal secret TEST" / "Granted
// super-admin to ino.gtav@…" style sentences. The audit_events table
// holds two flavours of action codes:
//
//   1. Middleware-logged HTTP rows. The action is the literal request
//      line, e.g. "POST /v1/projects/abc-…/group-grants". UUIDs make
//      them long and unreadable; we parse the path shape and map it.
//
//   2. IAM detail rows. Code like "iam.group.create" /
//      "iam.member.super_admin.grant". Direct lookup.
//
// Pure helpers (no React) so the audit row stays test-friendly. Lives
// in components/iam so it can be unit-tested alongside the other V2
// display helpers.

export interface HumanizedAuditAction {
  /** Short imperative verb, e.g. "Created group". */
  title: string;
  /** Optional secondary descriptor, e.g. the resource name parsed
   *  from the path. Renders next to the title. */
  detail?: string;
  /** Coarse category for the row's icon / colour accent. */
  kind:
    | 'create'
    | 'update'
    | 'delete'
    | 'grant'
    | 'revoke'
    | 'attach'
    | 'detach'
    | 'read'
    | 'export'
    | 'other';
}

export interface AuditActionDescription extends HumanizedAuditAction {
  /** True when a named action or API route produced the label. */
  mapped: boolean;
  /** HTTP method for request actions. */
  method: string | null;
  /** Manifest route template for request actions. */
  route: string | null;
  /** Short product area for the row subtitle. */
  area: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: string): boolean => UUID_RE.test(s);

interface RouteMatcher {
  method: string;
  path: string;
  pattern: RegExp;
  specificity: number;
}

const HTTP_ROUTE_MATCHERS: RouteMatcher[] = AUDIT_HTTP_ROUTES.map((signature) => {
  const separator = signature.indexOf(' ');
  const method = signature.slice(0, separator);
  const path = signature.slice(separator + 1);
  const parts = path.split('/');
  const specificity = parts.filter((part) => part && !part.startsWith(':')).length;
  const source = parts
    .map((part) => (part.startsWith(':') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return { method, path, pattern: new RegExp(`^${source}/?$`), specificity };
}).sort(
  (left, right) => right.specificity - left.specificity || right.path.length - left.path.length,
);

const ROUTE_LABEL_OVERRIDES: Record<string, string> = {
  'GET /health': 'Checked API health',
  'GET /health/live': 'Checked API liveness',
  'GET /metrics': 'Viewed system metrics',
  'GET /v1/accounts/:accountId/audit': 'Viewed audit log',
  'GET /v1/accounts/:accountId/audit/export': 'Exported audit log',
  'POST /v1/accounts/:accountId/audit/reconcile': 'Reconciled audit log',
  'GET /v1/accounts/:accountId/audit/webhooks': 'Listed audit webhooks',
  'POST /v1/accounts/:accountId/audit/webhooks': 'Created audit webhook',
  'GET /v1/accounts/:accountId/audit/webhooks/:webhookId/deliveries':
    'Listed audit webhook deliveries',
  'POST /v1/accounts/:accountId/audit/webhooks/:webhookId/deliveries/:deliveryId/replay':
    'Replayed audit webhook delivery',
  'PATCH /v1/accounts/:accountId/audit/webhooks/:webhookId': 'Updated audit webhook',
  'DELETE /v1/accounts/:accountId/audit/webhooks/:webhookId': 'Deleted audit webhook',
  'GET /v1/accounts/:accountId/iam/mfa-required': 'Viewed MFA requirement',
  'GET /v1/accounts/:accountId/iam/mfa-required/preview': 'Previewed MFA enforcement',
  'POST /v1/accounts/:accountId/iam/policies:bulk-import': 'Bulk imported IAM policies',
  'POST /v1/accounts/:accountId/iam/sso/provider/from-metadata':
    'Configured SSO provider from metadata',
  'POST /v1/accounts/:accountId/leave': 'Left account',
  'GET /v1/accounts/me': 'Viewed current account',
  'GET /v1/accounts/:accountId/iam/enterprise-demo': 'Viewed Enterprise preview',
  'PUT /v1/accounts/:accountId/iam/enterprise-demo': 'Updated Enterprise preview',
  'GET /v1/projects/:projectId/audit': 'Viewed project audit log',
  'GET /v1/projects/:projectId/sessions/:sessionId/audit': 'Viewed session audit log',
  'POST /v1/projects/:projectId/sessions/:sessionId/audit/events': 'Ingested session audit events',
  'GET /v1/projects/:projectId/sessions/:sessionId/transcript': 'Viewed session transcript',
  'GET /v1/projects/:projectId/sessions/:sessionId/turn': 'Viewed session turn state',
  // The prompt inbox: a prompt is a durable server row from the moment the
  // composer accepts it, so every one of these is a real, auditable action on
  // the session's pending work.
  'POST /v1/projects/:projectId/sessions/:sessionId/prompts': 'Queued a session prompt',
  'GET /v1/projects/:projectId/sessions/:sessionId/prompts': 'Viewed queued session prompts',
  'DELETE /v1/projects/:projectId/sessions/:sessionId/prompts/:promptId':
    'Removed a queued session prompt',
  'POST /v1/projects/:projectId/sessions/:sessionId/prompts/:promptId/retry':
    'Retried a queued session prompt',
  'POST /v1/projects/:projectId/sessions/:sessionId/prompts/hold':
    'Held or released the session prompt queue',
  // The park-and-restore pair (`r4.ts`): a parked session's `question` tool
  // survives past its sandbox (`lib/pending-questions.ts`); GET reads the one
  // still waiting on a human, POST answers it as a follow-up turn. Reads
  // naturally beside `turn-question`'s "Submitted session question" below —
  // submitted, then viewed, then answered.
  'GET /v1/projects/:projectId/sessions/:sessionId/question': 'Viewed open session question',
  'POST /v1/projects/:projectId/sessions/:sessionId/question': 'Answered session question',
  'POST /v1/projects/:projectId/sessions/:sessionId/commit-push':
    'Committed and pushed session changes',
  'POST /v1/projects/:projectId/sessions/:sessionId/reload': 'Reloaded session agent config',
  'POST /v1/projects/:projectId/sessions/:sessionId/reload-stream': 'Reloaded session agent config',
  'POST /v1/projects/:projectId/turn-stream': 'Streamed session turn',
  'POST /v1/projects/:projectId/turn-question': 'Submitted session question',
  'POST /v1/projects/:projectId/sessions/warm': 'Warmed session sandbox',
  'POST /v1/projects/:projectId/sessions/warm/claim': 'Claimed warm session sandbox',
  'GET /v1/projects/:projectId/files/content': 'Viewed file content',
  'GET /v1/projects/:projectId/files/search': 'Searched project files',
  'GET /v1/projects/:projectId/files/archive': 'Downloaded project files',
  'GET /v1/projects/:projectId/detail': 'Viewed project details',
  'POST /v1/projects/:projectId/access-requests': 'Requested project access',
  'POST /v1/projects/:projectId/approvals/:executionId': 'Resolved approval',
  'GET /v1/projects/:projectId/approvals/needs-input': 'Listed approvals needing input',
  'POST /v1/projects/:projectId/connect-requests': 'Created connection request',
  'PUT /v1/projects/:projectId/connections/:connectionId/activate': 'Activated connector',
  'PUT /v1/projects/:projectId/connections/:connectionId/default': 'Set default connector',
  'PUT /v1/projects/:projectId/connections/:connectionId/revoke': 'Revoked connector',
  'POST /v1/projects/:projectId/connections/me': 'Created personal connector',
  'POST /v1/projects/:projectId/gateway/playground': 'Ran gateway playground request',
  'POST /v1/projects/:projectId/gateway/routing-policy/preview': 'Previewed gateway routing policy',
  'POST /v1/projects/:projectId/git/collaborators': 'Added Git collaborator',
  'GET /v1/git/:project/compiled-checkout': 'Downloaded compiled project checkout',
  'GET /v1/git/:project/compiled-runtime': 'Downloaded compiled session runtime',
  'GET /v1/git/:project/compiled-pi-runtime': 'Downloaded compiled pi worker runtime',
  'POST /v1/projects/:projectId/marketplace/install-session': 'Started marketplace install',
  'POST /v1/projects/:projectId/review/bulk': 'Updated review items in bulk',
  'POST /v1/projects/:projectId/snapshots/fix-with-agent': 'Fixed snapshot with agent',
  'POST /v1/projects/github/installations/linkable': 'Listed linkable GitHub installations',
  // Same underlying create as bare `POST /v1/projects/provision` (both run
  // `runProvision` in `apps/api/src/projects/provision-core.ts` — see that
  // route's own doc comment) — this is just the phased-progress transport for
  // it, not a different action. `provision` itself has no override here (the
  // generic fallback already reads correctly as "Provisioned project"); this
  // entry pins the SAME text so the two never drift apart in the log.
  'POST /v1/projects/provision-stream': 'Provisioned project',
  'POST /v1/projects/suna-migration/start': 'Started project migration',
  'POST /v1/connectors/call': 'Ran connector call',
  'GET /v1/connectors/catalog': 'Viewed connector catalog',
  'POST /v1/connectors/projects/:projectId/call': 'Ran project connector action',
  'GET /v1/connectors/projects/:projectId/catalog': 'Viewed connector catalog',
  'GET /v1/connectors/projects/:projectId/sessions/:sessionId/connect-requests':
    'Viewed pending connector authorizations',
  'PUT /v1/connectors/projects/:projectId/connectors/:slug/secret-binding':
    'Updated connector secret binding',
  'GET /v1/runtime-assets/manifest': 'Checked sandbox runtime-asset versions',
  'GET /v1/runtime-assets/cli': 'Downloaded the sandbox CLI',
  'HEAD /v1/runtime-assets/cli': 'Checked the sandbox CLI',
  'GET /v1/runtime-assets/agent': 'Downloaded the sandbox agent',
  'HEAD /v1/runtime-assets/agent': 'Checked the sandbox agent',
  'GET /v1/runtime-assets/managed-skills': 'Downloaded managed skills',
  'POST /v1/router/web-search': 'Searched the web',
  'POST /v1/router/image-search': 'Searched images',
  'POST /v1/router/chat/completions': 'Generated chat completion',
  'POST /v1/auth/logout': 'Signed out',
  'GET /v1/openapi.json': 'Viewed OpenAPI specification',
  'GET /v1/billing/account-state': 'Viewed billing status',
  'GET /v1/billing/account-state/minimal': 'Viewed billing summary',
  // One aggregated GET replacing the session-open boot chorus (round-7 perf).
  // The auto-labeller reads "open-bundle" as a bare noun, so name it.
  'GET /v1/projects/:projectId/sessions/:sessionId/open-bundle': 'Opened session (bundled reads)',
  'GET /v1/usage/cost-by-project': 'Viewed project cost rollup',
  'GET /v1/usage/cost-summary': 'Viewed cost summary',
  'POST /internal/gateway/billing': 'Processed gateway billing',
  'POST /internal/gateway/budget-check': 'Checked gateway budget',
  'POST /internal/gateway/models': 'Resolved gateway models',
  'POST /internal/gateway/trace': 'Recorded gateway trace',
  'POST /internal/gateway/usage': 'Recorded gateway usage',
  // The in-process LLM gateway ingress (`llm-gateway/wire.ts`). Each action is
  // mounted twice — bare and `/v1`-prefixed — because OpenAI-shaped clients
  // treat the base URL as an origin and append `/v1/...` themselves. Both
  // mounts are the SAME handler, so both carry the SAME text: one action, one
  // label, however the caller spelled the path. `/messages` is the Anthropic
  // wire shape over that same completion pipeline, not a separate action.
  // Without these the auto-labeller reads them as bare nouns ("Created
  // completion", "Viewed health") with no hint that the gateway served them.
  'POST /v1/llm/chat/completions': 'Ran gateway completion',
  'POST /v1/llm/v1/chat/completions': 'Ran gateway completion',
  'POST /v1/llm/messages': 'Ran gateway completion',
  'POST /v1/llm/v1/messages': 'Ran gateway completion',
  'GET /v1/llm/models': 'Listed gateway models',
  'GET /v1/llm/v1/models': 'Listed gateway models',
  'GET /v1/llm/health': 'Checked gateway health',
  'GET /scim/v2/accounts/:accountId/ResourceTypes': 'Listed SCIM resource types',
  'GET /scim/v2/accounts/:accountId/ResourceTypes/:id': 'Viewed SCIM resource type',
  'POST /v1/account-invites/:inviteId/accept': 'Accepted account invitation',
  'POST /v1/account-invites/:inviteId/decline': 'Declined account invitation',
  'DELETE /v1/account/delete-immediately': 'Deleted account immediately',
  'DELETE /v1/billing/account/delete-immediately': 'Deleted billing account immediately',
  // Admin entitlement overrides. The auto-labeller reads these as nouns
  // ("Ran trial", "Created managed model"); they are operator decisions.
  'POST /v1/admin/api/accounts/:id/trial': 'Granted account trial',
  'DELETE /v1/admin/api/accounts/:id/trial': 'Revoked account trial',
  'POST /v1/admin/api/accounts/:id/members/:userId/role': 'Changed account member role',
  'POST /v1/admin/api/accounts/:id/managed-models': 'Set managed-models override',
  'POST /v1/admin/api/accounts/:id/enterprise-demo': 'Set enterprise demo flag',
  'POST /v1/admin/api/accounts/:id/enterprise-entitlement': 'Set enterprise entitlement flag',
  'PUT /v1/admin/api/accounts/:id/overrides': 'Set account entitlement overrides',
  'POST /v1/admin/api/impersonate': 'Started account impersonation',
  'DELETE /v1/admin/api/impersonate/:grantId': 'Stopped account impersonation',
  'GET /v1/admin/api/impersonate/active': 'Listed active impersonation grants',
  'POST /v1/billing/cron/free-tier-rotation': 'Ran free-tier billing rotation',
  'POST /v1/billing/cron/trial-expiry': 'Ran trial expiry sweep',
  'POST /v1/billing/cron/yearly-rotation': 'Ran yearly billing rotation',
  'POST /v1/billing/webhook/revenuecat': 'Received RevenueCat billing webhook',
  'POST /v1/billing/webhook/stripe': 'Received Stripe billing webhook',
  'POST /v1/billing/webhooks/revenuecat': 'Received RevenueCat billing webhook',
  'POST /v1/billing/webhooks/stripe': 'Received Stripe billing webhook',
  'GET /v1/marketplace/marketplaces/featured': 'Listed featured marketplaces',
  'GET /v1/oauth/authorize': 'Started OAuth authorization',
  'POST /v1/oauth/authorize/consent': 'Submitted OAuth consent',
  'GET /v1/oauth/userinfo': 'Viewed OAuth user information',
  'POST /v1/oauth/revoke': 'Revoked an OAuth token',
  'GET /.well-known/oauth-authorization-server': 'Read OAuth server metadata',
  'GET /v1/oauth/.well-known/oauth-authorization-server': 'Read OAuth server metadata',
  'GET /v1/accounts/:accountId/iam/oauth-clients': 'Listed OAuth apps',
  'POST /v1/accounts/:accountId/iam/oauth-clients': 'Registered an OAuth app',
  'GET /v1/accounts/:accountId/iam/oauth-clients/:clientId': 'Viewed an OAuth app',
  'PATCH /v1/accounts/:accountId/iam/oauth-clients/:clientId': 'Updated an OAuth app',
  'DELETE /v1/accounts/:accountId/iam/oauth-clients/:clientId': 'Deleted an OAuth app',
  'POST /v1/accounts/:accountId/iam/oauth-clients/:clientId/rotate-secret':
    'Rotated an OAuth app secret',
  'POST /v1/auth/signup': 'Signed up',
  'POST /v1/auth/sign-in/password': 'Signed in with a password',
  'POST /v1/auth/sign-in/magic-link': 'Requested a sign-in link',
  'POST /v1/auth/verify-otp': 'Verified a sign-in code',
  'POST /v1/auth/sign-in/oauth': 'Started a social sign-in',
  'POST /v1/auth/oauth/exchange': 'Completed a social sign-in',
  'POST /v1/auth/sign-in/sso': 'Started an SSO sign-in',
  'PATCH /v1/auth/user': 'Updated their profile',
  // MFA is security-relevant, so each leg reads as a distinct event in the
  // audit log — "enrolled" and "removed" must never collapse into one label.
  'POST /v1/auth/mfa/factors': 'Enrolled a second factor',
  'DELETE /v1/auth/mfa/factors/:factorId': 'Removed a second factor',
  'POST /v1/auth/mfa/factors/:factorId/challenge': 'Started a second-factor challenge',
  'POST /v1/auth/mfa/factors/:factorId/verify': 'Verified a second factor',
  'POST /v1/auth/refresh': 'Refreshed a session',
  'POST /v1/auth/password/reset': 'Requested a password reset',
  'POST /v1/auth/password/update': 'Changed the password',
  'GET /v1/auth/user': 'Viewed the signed-in user',
  'POST /v1/auth/sign-out': 'Signed out',
  'POST /v1/platform/boot-timeline': 'Recorded platform boot timeline',
  'POST /v1/platform/github-app/manifest-start': 'Started GitHub App setup',
  'GET /v1/platform/github-app/oauth/authorize': 'Started GitHub identity verification',
  'GET /v1/platform/github-app/oauth/callback': 'Completed GitHub identity verification',
  'POST /v1/prewarm': 'Prewarmed sandbox capacity',
};

const ACRONYMS: Record<string, string> = {
  api: 'API',
  cli: 'CLI',
  github: 'GitHub',
  iam: 'IAM',
  id: 'ID',
  llm: 'LLM',
  mcp: 'MCP',
  mfa: 'MFA',
  oauth: 'OAuth',
  oauth2: 'OAuth',
  pat: 'PAT',
  rpc: 'RPC',
  scim: 'SCIM',
  sdk: 'SDK',
  sso: 'SSO',
};

const IRREGULAR_SINGULARS: Record<string, string> = {
  actions: 'action',
  accounts: 'account',
  approvals: 'approval',
  bindings: 'binding',
  branches: 'branch',
  budgets: 'budget',
  commits: 'commit',
  completions: 'completion',
  connections: 'connection',
  connectors: 'connector',
  errors: 'error',
  files: 'file',
  groups: 'group',
  identities: 'identity',
  installations: 'installation',
  integrations: 'connector',
  invites: 'invitation',
  items: 'item',
  keys: 'key',
  logs: 'log',
  mappings: 'mapping',
  marketplaces: 'marketplace',
  members: 'member',
  messages: 'message',
  models: 'model',
  permissions: 'permission',
  policies: 'policy',
  previews: 'preview',
  profiles: 'profile',
  projects: 'project',
  providers: 'provider',
  repositories: 'repository',
  requests: 'request',
  roles: 'role',
  sandboxes: 'sandbox',
  schemas: 'schema',
  secrets: 'secret',
  sessions: 'session',
  snapshots: 'snapshot',
  skills: 'skill',
  sources: 'source',
  templates: 'template',
  tokens: 'token',
  transactions: 'transaction',
  triggers: 'trigger',
  users: 'user',
  webhooks: 'webhook',
};

const PAST_TENSE: Record<string, string> = {
  accept: 'Accepted',
  act: 'Resolved',
  activate: 'Activated',
  approve: 'Approved',
  authenticate: 'Authenticated',
  authorize: 'Authorized',
  bind: 'Bound',
  build: 'Built',
  cancel: 'Canceled',
  check: 'Checked',
  claim: 'Claimed',
  close: 'Closed',
  configure: 'Configured',
  confirm: 'Confirmed',
  connect: 'Connected',
  create: 'Created',
  debit: 'Debited',
  decline: 'Declined',
  deduct: 'Deducted',
  delete: 'Deleted',
  deny: 'Denied',
  disable: 'Disabled',
  discover: 'Discovered',
  export: 'Exported',
  finalize: 'Finalized',
  fire: 'Fired',
  link: 'Linked',
  leave: 'Left',
  logout: 'Signed out',
  merge: 'Merged',
  migrate: 'Migrated',
  poll: 'Polled',
  provision: 'Provisioned',
  purchase: 'Purchased',
  reactivate: 'Reactivated',
  rebuild: 'Rebuilt',
  reject: 'Rejected',
  reopen: 'Reopened',
  request: 'Requested',
  resend: 'Resent',
  resolve: 'Resolved',
  restart: 'Restarted',
  revoke: 'Revoked',
  rotate: 'Rotated',
  schedule: 'Scheduled',
  search: 'Searched',
  start: 'Started',
  stop: 'Stopped',
  sync: 'Synchronized',
  update: 'Updated',
  upload: 'Uploaded',
  validate: 'Validated',
  verify: 'Verified',
};

const COLLECTION_SEGMENTS = new Set(Object.keys(IRREGULAR_SINGULARS));

// ─── IAM action-code map ─────────────────────────────────────────────────

const IAM_ACTION_MAP: Record<string, { title: string; kind: HumanizedAuditAction['kind'] }> = {
  'admin.account.session_limit.set': { title: 'Updated account session limit', kind: 'update' },
  'admin.account.tier.set': { title: 'Updated account tier', kind: 'update' },
  'auth.login.fail': { title: 'Failed to sign in', kind: 'other' },
  'auth.login.success': { title: 'Signed in', kind: 'read' },
  'auth.logout': { title: 'Signed out', kind: 'read' },
  'auth.session.first_sight': { title: 'Started authenticated session', kind: 'create' },
  'enterprise_demo.disable': { title: 'Disabled Enterprise preview', kind: 'update' },
  'enterprise_demo.enable': { title: 'Enabled Enterprise preview', kind: 'update' },
  'iam.audit.webhook.create': { title: 'Created audit webhook', kind: 'create' },
  'iam.audit.webhook.delete': { title: 'Deleted audit webhook', kind: 'delete' },
  'iam.audit.webhook.update': { title: 'Updated audit webhook', kind: 'update' },
  'iam.group.create': { title: 'Created group', kind: 'create' },
  'iam.group.update': { title: 'Updated group', kind: 'update' },
  'iam.group.delete': { title: 'Deleted group', kind: 'delete' },
  'iam.group.members.add': { title: 'Added member to group', kind: 'attach' },
  'iam.group.members.remove': { title: 'Removed member from group', kind: 'detach' },
  'iam.member.super_admin.grant': { title: 'Granted super-admin', kind: 'grant' },
  'iam.member.super_admin.revoke': { title: 'Revoked super-admin', kind: 'revoke' },
  'iam.member.role.change': { title: 'Changed member role', kind: 'update' },
  'iam.project.group.attach': { title: 'Attached group to project', kind: 'attach' },
  'iam.project.group.detach': { title: 'Detached group from project', kind: 'detach' },
  'iam.project.group.expired': { title: 'Expired project group access', kind: 'revoke' },
  'iam.project.group.update': { title: 'Changed group role on project', kind: 'update' },
  'iam.project.member.expired': { title: 'Expired project member access', kind: 'revoke' },
  'iam.member.invite': { title: 'Invited member', kind: 'create' },
  'iam.member.remove': { title: 'Removed member', kind: 'delete' },
  'iam.mfa_required.enable': { title: 'Required MFA for the account', kind: 'update' },
  'iam.mfa_required.disable': { title: 'Disabled MFA requirement', kind: 'update' },
  'iam.session_policy.update': { title: 'Updated session policy', kind: 'update' },
  'iam.pat_policy.update': { title: 'Updated PAT policy', kind: 'update' },
  'iam.sso.provider.update': { title: 'Updated SSO provider', kind: 'update' },
  'iam.sso.provider.create': { title: 'Created SSO provider', kind: 'create' },
  'iam.sso.provider.delete': { title: 'Removed SSO provider', kind: 'delete' },
  'iam.sso.mapping.create': { title: 'Added SSO group mapping', kind: 'create' },
  'iam.sso.mapping.delete': { title: 'Removed SSO group mapping', kind: 'delete' },
  'iam.scim.token.create': { title: 'Created SCIM token', kind: 'create' },
  'iam.scim.token.revoke': { title: 'Revoked SCIM token', kind: 'revoke' },
  'iam.service_account.create': { title: 'Created service account', kind: 'create' },
  'iam.service_account.disable': { title: 'Disabled service account', kind: 'update' },
  'iam.service_account.delete': { title: 'Deleted service account', kind: 'delete' },
  'iam.audit.export': { title: 'Exported audit log', kind: 'export' },
  'iam.policy_template.apply': { title: 'Applied policy template', kind: 'grant' },
  // These were briefly dead (V1 policies removed in PR5) but a DB-backed
  // custom-role/policy surface was rebuilt in Phase 3 of feat/iam-rbac-v1
  // (June 2026, accounts/iam/custom-roles.ts) at the same action codes —
  // this map now covers LIVE activity again, not just historical rows.
  'iam.policy.create': { title: 'Created IAM policy', kind: 'create' },
  'iam.policy.update': { title: 'Updated IAM policy', kind: 'update' },
  'iam.policy.delete': { title: 'Deleted IAM policy', kind: 'delete' },
  'iam.policy.bulk_import': { title: 'Bulk imported IAM policies', kind: 'create' },
  'iam.role.create': { title: 'Created IAM role', kind: 'create' },
  'iam.role.delete': { title: 'Deleted IAM role', kind: 'delete' },
  'iam.role.permissions.set': { title: 'Updated IAM role permissions', kind: 'update' },
  'iam.session.revoke': { title: 'Revoked account session', kind: 'revoke' },
  'project.admin_bypass_read': { title: 'Used admin bypass to view project', kind: 'read' },
  'project.admin_bypass_session_read': {
    title: 'Used admin bypass to view session',
    kind: 'read',
  },
  'project.connector.read': { title: 'Read project connector', kind: 'read' },
  'scim.group.create': { title: 'Provisioned SCIM group', kind: 'create' },
  'scim.group.delete': { title: 'Deleted SCIM group', kind: 'delete' },
  'scim.group.update': { title: 'Updated SCIM group', kind: 'update' },
  'scim.user.deactivate': { title: 'Deactivated SCIM user', kind: 'revoke' },
  'scim.user.delete': { title: 'Deleted SCIM user', kind: 'delete' },
  'scim.user.invite': { title: 'Invited SCIM user', kind: 'create' },
  'scim.user.invite_revoke': { title: 'Revoked SCIM user invitation', kind: 'revoke' },
  'webhook.test': { title: 'Sent audit webhook test', kind: 'update' },
};

// ─── HTTP path patterns ──────────────────────────────────────────────────
//
// Each entry checks against (method, segments) of the parsed path. First
// match wins. `segments` is the path after /v1/ with UUIDs replaced by
// the literal token `:id`, so e.g.
//   POST /v1/projects/abc-…/group-grants
// becomes segments ["projects", ":id", "group-grants"]

type PathSegments = string[];
type HttpPatternHandler = (
  method: string,
  segs: PathSegments,
  rawPath: string,
) => HumanizedAuditAction | null;

function httpPatterns(tI18nComplete: UiTranslator): HttpPatternHandler[] {
  return [
    // ── Project group-grants ─────────────────────────────────────────
    (m, s) => {
      if (s[0] === 'projects' && s[2] === 'group-grants') {
        if (m === 'POST' && s.length === 3)
          return { title: tI18nComplete.raw('text24a754cf2e81'), kind: 'attach' };
        if (m === 'PATCH' && s.length === 4)
          return { title: tI18nComplete.raw('text84b78c923b6a'), kind: 'update' };
        if (m === 'DELETE' && s.length === 4)
          return { title: tI18nComplete.raw('text4891f0add1ec'), kind: 'detach' };
      }
      return null;
    },
    // ── Project secrets ──────────────────────────────────────────────
    (m, s, raw) => {
      if (s[0] === 'projects' && s[2] === 'secrets') {
        // /v1/projects/:id/secrets/NAME[/personal]
        const name = s[3] && s[3] !== ':id' ? s[3] : null;
        const personal = s[4] === 'personal';
        if (m === 'PUT' && s[4] === 'strategy') {
          return {
            title: tI18nComplete.raw('text78992a9b4a8f'),
            detail: name ?? undefined,
            kind: 'update',
          };
        }
        if (m === 'PUT') {
          return {
            title: personal ? 'Set personal secret' : 'Set shared secret',
            detail: name ?? undefined,
            kind: 'update',
          };
        }
        if (m === 'DELETE') {
          return {
            title: personal ? 'Removed personal secret' : 'Removed shared secret',
            detail: name ?? undefined,
            kind: 'delete',
          };
        }
        if (m === 'POST' && raw.endsWith(':rotate')) {
          return {
            title: tI18nComplete.raw('textf7d383dc224d'),
            detail: name ?? undefined,
            kind: 'update',
          };
        }
        if (m === 'POST' && s[4] === 'grant') {
          // Writes the agent's `secrets:` list in kortix.yaml, so it widens what a
          // session can reach — an access change, not a value change.
          return {
            title: tI18nComplete.raw('textfdcd7d7a2b54'),
            detail: name ?? undefined,
            kind: 'update',
          };
        }
        // POST /v1/projects/:id/secrets with name in body (not in path).
        // The name isn't recoverable from the URL so we just label the
        // action and rely on the before/after diff for the detail.
        if (m === 'POST' && s.length === 3) {
          return { title: tI18nComplete.raw('textb61c8415b2b6'), kind: 'update' };
        }
      }
      return null;
    },
    // ── Project access (direct members + pending invites) ───────────
    (m, s) => {
      if (s[0] === 'projects' && s[2] === 'access') {
        // Bootstrap-grant pending-invite endpoints. The DELETE is the
        // Revoke action on the Pending Invitations card.
        if (s[3] === 'pending-invites') {
          if (m === 'GET') return { title: tI18nComplete.raw('textf7870941f5a8'), kind: 'read' };
          if (m === 'DELETE')
            return { title: tI18nComplete.raw('textad5c82071432'), kind: 'revoke' };
        }
        if (m === 'POST' && s[3] === 'invite')
          return { title: tI18nComplete.raw('text69396637a410'), kind: 'create' };
        if (m === 'PUT' && s.length === 4)
          return { title: tI18nComplete.raw('text2b99e2a42352'), kind: 'update' };
        if (m === 'DELETE' && s.length === 4)
          return { title: tI18nComplete.raw('texta4c9215859a8'), kind: 'delete' };
      }
      return null;
    },
    // ── Project sessions ─────────────────────────────────────────────
    // POST /v1/projects/:id/sessions[/:sessionId/...] — every interactive
    // run lands here, so we get a lot of these. Friendly title beats raw
    // method+path in a long audit list.
    (m, s) => {
      if (s[0] === 'projects' && s[2] === 'sessions') {
        const tail = s.slice(3); // after /sessions
        if (m === 'POST' && tail.length === 0)
          return { title: tI18nComplete.raw('text1f2cde4f0d46'), kind: 'create' };
        if (m === 'POST' && tail[1] === 'exec')
          return { title: tI18nComplete.raw('textc0d5cbb786f3'), kind: 'update' };
        if (m === 'POST' && tail[1] === 'stop')
          return { title: tI18nComplete.raw('text4e7b0cd1a437'), kind: 'update' };
        if (m === 'DELETE' && tail.length === 1)
          return { title: tI18nComplete.raw('text06c4ea480765'), kind: 'delete' };
        if (m === 'PATCH' && tail.length === 1)
          return { title: tI18nComplete.raw('text8bfaeec7acfe'), kind: 'update' };
      }
      return null;
    },
    // ── Project triggers ─────────────────────────────────────────────
    (m, s) => {
      if (s[0] === 'projects' && s[2] === 'triggers') {
        if (m === 'POST' && s.length === 3)
          return { title: tI18nComplete.raw('text7bc57426b2fa'), kind: 'create' };
        if (m === 'PATCH' && s.length === 4)
          return { title: tI18nComplete.raw('text1d2a6194e5b0'), kind: 'update' };
        if (m === 'DELETE' && s.length === 4)
          return { title: tI18nComplete.raw('text38438f131ca0'), kind: 'delete' };
        if (m === 'POST' && s[4] === 'fire')
          return { title: tI18nComplete.raw('text183bd99db5b3'), kind: 'create' };
      }
      // Monitor event intake — the project monitor box appending to its event
      // log (sandbox-token-only; see docs/specs/2026-08-12-monitors.md).
      if (s[0] === 'projects' && s[2] === 'monitors' && s[3] === 'ingest' && m === 'POST') {
        return { title: tI18nComplete.raw('text6201f8d3134e'), kind: 'create' };
      }
      return null;
    },
    // ── Project lifecycle ────────────────────────────────────────────
    (m, s) => {
      if (s[0] === 'projects') {
        if (m === 'POST' && s.length === 1)
          return { title: tI18nComplete.raw('text79ffe7bf8192'), kind: 'create' };
        if (m === 'PATCH' && s.length === 2)
          return { title: tI18nComplete.raw('text4ad32e5b8e19'), kind: 'update' };
        if (m === 'DELETE' && s.length === 2)
          return { title: tI18nComplete.raw('textb39d263f67ad'), kind: 'delete' };
      }
      return null;
    },
    // ── Account members ──────────────────────────────────────────────
    (m, s) => {
      if (s[0] === 'accounts' && s[2] === 'members') {
        if (m === 'POST' && s.length === 3)
          return { title: tI18nComplete.raw('texte4f5f1e08c59'), kind: 'create' };
        if (m === 'PATCH' && s.length === 4)
          return { title: tI18nComplete.raw('text3e820fc2d91f'), kind: 'update' };
        if (m === 'DELETE' && s.length === 4)
          return { title: tI18nComplete.raw('texted41f8758db3'), kind: 'delete' };
      }
      return null;
    },
    // ── Account lifecycle (name/description edits) ───────────────────
    // PATCH /v1/accounts/:id — used by the account settings form. Without
    // this the audit log shows a bare "PATCH /v1/accounts/{id}" that
    // tells the reader nothing.
    (m, s) => {
      if (s[0] === 'accounts' && s.length === 2) {
        if (m === 'PATCH') return { title: tI18nComplete.raw('textc2c989a90482'), kind: 'update' };
        if (m === 'DELETE') return { title: tI18nComplete.raw('textefb5b201f3c6'), kind: 'delete' };
      }
      return null;
    },
    // ── IAM policy templates ─────────────────────────────────────────
    // Templates are baked-in role bundles ("project-readonly-auditor",
    // "billing-only", etc) — applying one creates the underlying group
    // grants in a single shot, so we surface both the verb and which
    // template was applied.
    (m, s) => {
      if (s[0] === 'accounts' && s[2] === 'iam' && s[3] === 'policy-templates') {
        const slug = s[4] && s[4] !== ':id' ? s[4] : null;
        if (m === 'POST' && s[5] === 'apply')
          return {
            title: tI18nComplete.raw('textab2f1e5b956a'),
            detail: slug ?? undefined,
            kind: 'grant',
          };
        if (m === 'GET') return { title: tI18nComplete.raw('text57c848e1ca75'), kind: 'read' };
      }
      return null;
    },
    // ── Role assignments + the permission catalog ────────────────────
    // The canonical grant surface: ONE row per (principal, role, scope, object).
    // It replaced the five endpoint families below, which stay mapped while they
    // dual-write.
    (m, s) => {
      if (s[0] === 'accounts' && s[2] === 'iam' && s[3] === 'assignments') {
        if (m === 'POST') return { title: tI18nComplete.raw('texta21492a5bd01'), kind: 'grant' };
        if (m === 'DELETE') return { title: tI18nComplete.raw('texte75eb1c6178c'), kind: 'revoke' };
        if (m === 'GET') return { title: tI18nComplete.raw('text548677c5771e'), kind: 'read' };
      }
      if (s[0] === 'accounts' && s[2] === 'iam' && s[3] === 'permissions' && m === 'GET') {
        return { title: tI18nComplete.raw('text5122577b6042'), kind: 'read' };
      }
      return null;
    },
    // ── IAM policies (bare /iam/policies endpoints) ──────────────────
    // Fallback for rows logged as the raw HTTP path rather than a specific
    // iam.policy.* code (e.g. applying a policy template, or older rows from
    // before the direct action-code logging existed). The policies surface
    // itself is live (custom-roles.ts, Phase 3 of feat/iam-rbac-v1) — this
    // isn't legacy-only. Map them so the log doesn't show raw curl commands.
    (m, s) => {
      if (s[0] === 'accounts' && s[2] === 'iam' && s[3] === 'policies') {
        if (m === 'POST' && s.length === 4)
          return { title: tI18nComplete.raw('textf58f153c56ed'), kind: 'create' };
        if (m === 'PATCH' && s.length === 5)
          return { title: tI18nComplete.raw('text720878394def'), kind: 'update' };
        if (m === 'DELETE' && s.length === 5)
          return { title: tI18nComplete.raw('textbb4db6a8ee1a'), kind: 'delete' };
        if (m === 'GET') return { title: tI18nComplete.raw('texte7b9a6c97fc7'), kind: 'read' };
      }
      return null;
    },
    // ── IAM members (super-admin, groups, project access, effective probe) ──
    (m, s) => {
      if (s[0] === 'accounts' && s[2] === 'iam' && s[3] === 'members') {
        const tail = s.slice(4); // after /members/:userId
        if (tail[1] === 'super-admin')
          return { title: tI18nComplete.raw('text2bc95eda6944'), kind: 'grant' };
        if (tail[1] === 'project-access')
          return { title: tI18nComplete.raw('text6dead34f47ed'), kind: 'read' };
        if (tail[1] === 'groups')
          return { title: tI18nComplete.raw('texta5437897f3e7'), kind: 'read' };
        if (tail[1]?.startsWith('effective'))
          return { title: tI18nComplete.raw('text3ecb3ffd4f33'), kind: 'read' };
        if (tail[1] === 'boundary')
          return { title: tI18nComplete.raw('textea5453721f2c'), kind: 'update' };
      }
      return null;
    },
    // ── IAM groups ───────────────────────────────────────────────────
    (m, s) => {
      if (s[0] === 'accounts' && s[2] === 'iam' && s[3] === 'groups') {
        const tail = s.slice(4); // after /groups
        if (m === 'POST' && tail.length === 0)
          return { title: tI18nComplete.raw('texte0edaf920655'), kind: 'create' };
        if (m === 'PATCH' && tail.length === 1)
          return { title: tI18nComplete.raw('text1a5971d4dc9f'), kind: 'update' };
        if (m === 'DELETE' && tail.length === 1)
          return { title: tI18nComplete.raw('textfc718110809e'), kind: 'delete' };
        if (tail[1] === 'members') {
          if (m === 'POST') return { title: tI18nComplete.raw('text56b0e1edef9a'), kind: 'attach' };
          if (m === 'DELETE')
            return { title: tI18nComplete.raw('text5ba18b8f3b74'), kind: 'detach' };
        }
        if (tail[1] === 'project-grants')
          return { title: tI18nComplete.raw('textcb7a14a8cd1d'), kind: 'read' };
      }
      return null;
    },
    // ── Account settings (MFA, SSO, SCIM, session, PAT) ──────────────
    (m, s) => {
      if (s[0] === 'accounts' && s[2] === 'iam') {
        if (s[3] === 'mfa-required' && m === 'PATCH')
          return { title: tI18nComplete.raw('text23ffb018d2a2'), kind: 'update' };
        if (s[3] === 'session-policy' && m === 'PATCH')
          return { title: tI18nComplete.raw('textce582f2663e8'), kind: 'update' };
        if (s[3] === 'sessions' && s[5] === 'revoke')
          return { title: tI18nComplete.raw('textd4bc8ec6a562'), kind: 'revoke' };
        if (s[3] === 'pat-policy' && m === 'PATCH')
          return { title: tI18nComplete.raw('text80f505ac6a81'), kind: 'update' };
        if (s[3] === 'sso' && s[4] === 'provider') {
          if (m === 'PUT') return { title: tI18nComplete.raw('text2decf9534011'), kind: 'update' };
          if (m === 'DELETE')
            return { title: tI18nComplete.raw('text0268dc441c39'), kind: 'delete' };
        }
        if (s[3] === 'sso' && s[4] === 'mappings') {
          if (m === 'POST') return { title: tI18nComplete.raw('texteaf9eda43588'), kind: 'create' };
          if (m === 'DELETE')
            return { title: tI18nComplete.raw('textb5e0b14b924e'), kind: 'delete' };
        }
        if (s[3] === 'scim' && s[4] === 'tokens') {
          if (m === 'POST') return { title: tI18nComplete.raw('text7d5fcb164f17'), kind: 'create' };
          if (m === 'DELETE')
            return { title: tI18nComplete.raw('textaba314822529'), kind: 'revoke' };
        }
        if (s[3] === 'service-accounts') {
          if (m === 'POST' && s.length === 4)
            return { title: tI18nComplete.raw('text6a49860e54af'), kind: 'create' };
          if (s[5] === 'disable')
            return { title: tI18nComplete.raw('text8d4800aa530c'), kind: 'update' };
          if (m === 'DELETE' && s.length === 5)
            return { title: tI18nComplete.raw('text22489bebb98f'), kind: 'delete' };
        }
      }
      return null;
    },
    // ── Audit export ────────────────────────────────────────────────
    (m, s) => {
      if (s[0] === 'accounts' && s[2] === 'audit' && s[3] === 'export')
        return { title: tI18nComplete.raw('text3139ff90b6e9'), kind: 'export' };
      return null;
    },
  ];
}

// ─── Public API ───────────────────────────────────────────────────────────

function translateAuditTitle(title: string, tI18nComplete: UiTranslator): string {
  const key = AUDIT_TITLE_TRANSLATION_KEYS[title];
  return key ? tI18nComplete.raw(key as Parameters<UiTranslator['raw']>[0]) : title;
}

function describeNamedAction(
  action: string,
  tI18nComplete: UiTranslator,
): HumanizedAuditAction | null {
  const iam = IAM_ACTION_MAP[action];
  if (iam) return { title: translateAuditTitle(iam.title, tI18nComplete), kind: iam.kind };

  if (action === 'session.created') {
    return { title: tI18nComplete.raw('text1f2cde4f0d46'), kind: 'create' };
  }
  if (action === 'connector.approval.approved') {
    return { title: tI18nComplete.raw('textd2555357d10a'), kind: 'grant' };
  }
  if (action === 'connector.approval.denied') {
    return { title: tI18nComplete.raw('text82ff2bbaa7ac'), kind: 'revoke' };
  }
  if (action.startsWith('connector.')) {
    return {
      title: tI18nComplete.raw('text4571b6091ba2'),
      detail: action.slice('connector.'.length),
      kind: 'update',
    };
  }
  if (action.startsWith('computer.')) {
    return {
      title: tI18nComplete.raw('texta31f402d0382'),
      detail: action.slice('computer.'.length),
      kind: 'update',
    };
  }
  return null;
}

function matchHttpRoute(method: string, path: string): RouteMatcher | null {
  return (
    HTTP_ROUTE_MATCHERS.find(
      (candidate) => candidate.method === method && candidate.pattern.test(path),
    ) ?? null
  );
}

function routeArea(path: string): string {
  if (path.startsWith('/internal/gateway/')) return 'Gateway';
  if (path.startsWith('/scim/')) return 'SCIM';
  if (path === '/health' || path === '/health/live' || path === '/metrics') return 'System';
  if (path.includes('/accounts/:accountId/audit')) return 'Account audit';
  if (path.includes('/accounts/:accountId/iam')) return 'Identity and access';
  if (path.includes('/projects/:projectId/sessions') || path.includes('/turn-')) return 'Sessions';
  if (path.includes('/projects/:projectId/gateway')) return 'AI gateway';
  if (path.includes('/connector') || path.startsWith('/v1/connectors/')) return 'Connectors';
  if (path.startsWith('/v1/billing/')) return 'Billing';
  if (path.startsWith('/v1/tunnel/')) return 'Computer';
  if (path.startsWith('/v1/admin/')) return 'Administration';
  if (path.startsWith('/v1/marketplace/')) return 'Marketplace';
  if (path.startsWith('/v1/webhooks/')) return 'Webhooks';
  if (path.includes('/channels/')) return 'Channels';
  if (path.startsWith('/v1/router/') || path.startsWith('/v1/llm/')) return 'Models';
  if (path.startsWith('/v1/projects')) return 'Projects';
  if (path.startsWith('/v1/accounts') || path.startsWith('/v1/account')) return 'Accounts';
  return 'API';
}

function routeSegments(path: string): string[] {
  const segments = path.split('/').filter(Boolean);
  if (segments[0] === 'v1') return segments.slice(1);
  if (segments[0] === 'scim' && segments[1] === 'v2') return segments.slice(2);
  if (segments[0] === 'internal') return segments.slice(1);
  return segments;
}

function words(value: string): string {
  return value
    .replace(/\.json$/i, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[-_: ]+/)
    .filter(Boolean)
    .map((word) => ACRONYMS[word.toLowerCase()] ?? word.toLowerCase())
    .join(' ');
}

function singular(value: string): string {
  const normalized = value.toLowerCase();
  const direct = IRREGULAR_SINGULARS[normalized];
  if (direct) return direct;
  const parts = normalized.split('-');
  if (parts.length > 1) {
    const last = parts.at(-1) as string;
    parts[parts.length - 1] = IRREGULAR_SINGULARS[last] ?? last;
    return parts.join('-');
  }
  if (normalized === 'resourcetypes') return 'resource-type';
  return normalized;
}

function isCollectionSegment(segment: string): boolean {
  const normalized = segment.split(':')[0].toLowerCase();
  if (COLLECTION_SEGMENTS.has(normalized)) return true;
  const last = normalized.split('-').at(-1) ?? normalized;
  return COLLECTION_SEGMENTS.has(last) || normalized === 'resourcetypes';
}

function contextualResource(path: string, segment: string): string {
  const normalized = segment.split(':')[0];
  if (normalized === 'webhooks' && path.includes('/audit/')) return 'audit webhooks';
  if (normalized === 'provider' && path.includes('/sso/')) return 'SSO provider';
  if (normalized === 'mappings' && path.includes('/sso/')) return 'SSO mappings';
  if (normalized === 'tokens' && path.includes('/scim/')) return 'SCIM tokens';
  if (normalized === 'sessions' && path.includes('/iam/')) return 'account sessions';
  if (normalized === 'policies' && path.includes('/iam/')) return 'IAM policies';
  if (normalized === 'installation') {
    const provider = routeSegments(path)
      .filter((part) => !part.startsWith(':'))
      .at(-2);
    return provider ? `${words(provider)} installation` : 'channel installation';
  }
  return words(normalized);
}

function actionTarget(path: string, actionIndex: number): string {
  const segments = routeSegments(path);
  for (let index = actionIndex - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (!segment.startsWith(':')) {
      return words(singular(segment.split(':')[0]));
    }
  }
  return 'request';
}

function imperativeLabel(path: string, terminal: string, terminalIndex: number): string | null {
  const [resource, colonAction] = terminal.split(':');
  if (colonAction?.startsWith('bulk-')) {
    const verb = colonAction.slice('bulk-'.length);
    const past = PAST_TENSE[verb];
    return past ? `Bulk ${past.toLowerCase()} ${words(resource)}` : null;
  }

  const parts = terminal.split('-');
  const past = PAST_TENSE[parts[0]];
  if (!past) return null;
  if (parts.length > 1) return `${past} ${words(parts.slice(1).join('-'))}`;
  return `${past} ${actionTarget(path, terminalIndex)}`;
}

function genericRouteLabel(method: string, path: string): string {
  const segments = routeSegments(path);
  const terminalIndex = segments.length - 1;
  const terminal = segments[terminalIndex] ?? 'API';

  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && !terminal.startsWith(':')) {
    const imperative = imperativeLabel(path, terminal, terminalIndex);
    if (imperative) return imperative;
  }

  if (method === 'POST' && path.startsWith('/v1/webhooks/')) {
    const provider = segments.find((part) =>
      ['email', 'sandbox', 'slack', 'teams', 'telegram'].includes(part),
    );
    return `Received ${provider ? `${words(provider)} ` : ''}webhook`;
  }

  const endsWithParameter = terminal.startsWith(':');
  const resourceSegment = endsWithParameter
    ? ([...segments].reverse().find((part) => !part.startsWith(':')) ?? 'resource')
    : terminal;
  const resource = contextualResource(path, resourceSegment);
  const singularResource = contextualResource(path, singular(resourceSegment.split(':')[0]));
  const isCollection = isCollectionSegment(resourceSegment);

  switch (method) {
    case 'GET':
      return endsWithParameter || !isCollection
        ? `Viewed ${endsWithParameter ? singularResource : resource}`
        : `Listed ${resource}`;
    case 'POST':
      return isCollection ? `Created ${singularResource}` : `Ran ${resource}`;
    case 'PUT':
    case 'PATCH':
      return `Updated ${endsWithParameter ? singularResource : resource}`;
    case 'DELETE':
      return `Deleted ${singularResource}`;
    case 'OPTIONS':
      return `Checked ${resource} options`;
    default:
      return `Accessed ${resource}`;
  }
}

function compactHttpAction(method: string, path: string): string {
  return `${method} ${path.replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '/…')}`;
}

/**
 * Describe an audit action with a readable title and its matched route.
 * Unknown actions keep the compact raw value as their title.
 */
export function describeAuditAction(
  action: string,
  tI18nComplete: UiTranslator,
): AuditActionDescription {
  const named = describeNamedAction(action, tI18nComplete);
  if (named) {
    return { ...named, mapped: true, method: null, route: null, area: null };
  }

  const httpMatch = action.match(/^([A-Z]+)\s+(\/\S+)$/);
  if (httpMatch) {
    const method = httpMatch[1];
    const rawPath = httpMatch[2];
    const path = rawPath.split('?')[0].replace(/\/$/, '') || '/';
    const route = matchHttpRoute(method, path);
    const tail = path.replace(/^\/v1\/?/, '');
    const segments = tail ? tail.split('/').map((seg) => (isUuid(seg) ? ':id' : seg)) : [];
    for (const handler of httpPatterns(tI18nComplete)) {
      const out = handler(method, segments, path);
      if (out) {
        return {
          ...out,
          mapped: true,
          method,
          route: route?.path ?? null,
          area: routeArea(route?.path ?? path),
        };
      }
    }

    if (!route) {
      return {
        title: compactHttpAction(method, path),
        kind: kindFromMethod(method),
        mapped: false,
        method,
        route: null,
        area: 'API',
      };
    }

    return {
      title: translateAuditTitle(
        ROUTE_LABEL_OVERRIDES[`${method} ${route.path}`] ?? genericRouteLabel(method, route.path),
        tI18nComplete,
      ),
      kind: kindFromMethod(method),
      mapped: true,
      method,
      route: route.path,
      area: routeArea(route.path),
    };
  }

  return {
    title: action,
    kind: 'other',
    mapped: false,
    method: null,
    route: null,
    area: null,
  };
}

/**
 * Return the compact shape used by existing audit consumers.
 */
export function humanizeAuditAction(
  action: string,
  tI18nComplete: UiTranslator,
): HumanizedAuditAction {
  const { title, detail, kind } = describeAuditAction(action, tI18nComplete);
  return detail ? { title, detail, kind } : { title, kind };
}

function kindFromMethod(method: string): HumanizedAuditAction['kind'] {
  switch (method) {
    case 'POST':
      return 'create';
    case 'PUT':
    case 'PATCH':
      return 'update';
    case 'DELETE':
      return 'delete';
    default:
      return 'other';
  }
}

/**
 * Render a friendly resource pill: "Project · 8fb490fe" / "Group · Engineering".
 * Resource type comes from the audit_events row; the id is shortened
 * to the first 8 chars so it stays scannable.
 */
export function formatResourcePill(
  resourceType: string | null | undefined,
  resourceId: string | null | undefined,
): string | null {
  if (!resourceType) return null;
  const label = resourceType.replace(/_/g, ' ');
  const short = resourceId ? resourceId.slice(0, 8) : null;
  return short ? `${label} · ${short}` : label;
}

/**
 * Tailwind colour classes per action-kind. Used for the small leading
 * dot on each row. Kept in this module so the row component stays a
 * presentation shell.
 */
export const KIND_DOT_CLASS: Record<HumanizedAuditAction['kind'], string> = {
  create: 'bg-emerald-500/70',
  update: 'bg-amber-500/70',
  delete: 'bg-rose-500/70',
  grant: 'bg-violet-500/70',
  revoke: 'bg-rose-500/70',
  attach: 'bg-sky-500/70',
  detach: 'bg-zinc-400/70',
  read: 'bg-zinc-300/60',
  export: 'bg-sky-500/70',
  other: 'bg-zinc-300/60',
};
