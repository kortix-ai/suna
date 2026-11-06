#!/usr/bin/env bun
/**
 * Workspace verdict parity — "does the one-scope IAM engine and the one-rule
 * fence give every request the same auth verdict as the code it replaces?"
 * (Workspaces, design.md §5 "Proving parity"; the shape of rbac-cutover-audit.ts.)
 *
 * Every route in `tests/spec/routes.generated.json` × every credential kind ×
 * every role × {a 1:1 workspace, a split-pending legacy account}, sent IN
 * PROCESS through `app.request` (no server, no network), once with the base
 * commit's code and once with the head's, against the SAME seeded database.
 * The verdict of each request is its auth outcome: 401 / 403 with its `check=`
 * name or code / 404 / 429 / "passed auth" (anything else). The diff lists every
 * request whose verdict changed.
 *
 * SAFE BY CONSTRUCTION
 *   - Synthetic data only: example.test emails, random ids. No customer data.
 *   - The run phase sets the parity database READ ONLY
 *     (`default_transaction_read_only`), so a request that passes auth can
 *     write nothing: the results do not depend on request order, and base and
 *     head see the same rows. A handler that tries to write answers 5xx, which
 *     still counts as "passed auth" (the verdict is about auth, not handlers).
 *   - Run it with `scripts/test.env`: fake provider keys, so no sandbox,
 *     payment, email or GitHub call can leave the machine.
 *   - Never against a shared database: `seed` refuses any host but 127.0.0.1 /
 *     localhost.
 *
 * USAGE (from apps/api; DB = a local database this script may drop and create)
 *   export PARITY_ENV="--env-file=scripts/test.env"
 *   export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/<parity db>
 *   export SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY=<local> SUPABASE_ANON_KEY=<local>
 *   bun $PARITY_ENV scripts/workspace-verdict-parity.ts seed --state ../../output/parity-state.json
 *   bun $PARITY_ENV scripts/workspace-verdict-parity.ts run  --state ../../output/parity-state.json --out ../../output/parity-head.json
 *   (copy this file into a checkout of the base commit; run `run` there with --out parity-base.json)
 *   bun scripts/workspace-verdict-parity.ts diff --base … --head … --md ../../output/workspace-parity.md
 *
 * The `run` and `diff` phases import nothing but `../src/app` and node built-ins,
 * so this file runs unchanged in an older checkout.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

type Args = Record<string, string>;

function parseArgs(argv: string[]): { cmd: string; args: Args } {
  const [cmd = '', ...rest] = argv;
  const args: Args = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith('--')) {
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[a.slice(2)] = next;
        i++;
      } else args[a.slice(2)] = 'true';
    }
  }
  return { cmd, args };
}

const ROLES = ['owner', 'admin', 'member', 'manager', 'project_member', 'no_grant', 'group_grant', 'custom_role'] as const;
type Role = (typeof ROLES)[number];
const PERSON_KINDS = ['jwt', 'account_pat', 'project_pat', 'session_pat', 'oauth'] as const;
type Kind = (typeof PERSON_KINDS)[number] | 'service_account' | 'api_key';
type Ctx = 'one' | 'legacy';

interface Credential {
  ctx: Ctx;
  role: Role | 'machine';
  kind: Kind;
  authorization: string;
}
interface ContextState {
  accountId: string;
  workspaceId: string;
  /** A second workspace of the same account (legacy only), never the credentials' own. */
  siblingWorkspaceId: string | null;
  /** The owner's live session sandbox in the workspace (`/v1/p/:sandboxId`). */
  sandboxId: string;
}
interface State {
  contexts: Record<Ctx, ContextState>;
  credentials: Credential[];
}

const PASSWORD = 'ws-parity-Synthetic-1!';

// ─── seed ────────────────────────────────────────────────────────────────────

async function seed(args: Args): Promise<void> {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error(`refusing to seed a non-local database (${url.hostname})`);
  }
  const supabaseUrl = process.env.SUPABASE_URL ?? '';
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const anon = process.env.SUPABASE_ANON_KEY ?? '';
  if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(supabaseUrl)) throw new Error('SUPABASE_URL must be the local Supabase');
  if (!service || !anon) throw new Error('SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required');

  const { sql, eq, and, isNull } = await import('drizzle-orm');
  const db = (await import('../src/shared/db')).db;
  const schema = await import('@kortix/db');
  const { insertIntoView } = await import('../src/__tests__/helpers/compat-views');
  const { createAccountToken } = await import('../src/repositories/account-tokens');
  const { createServiceAccount } = await import('../src/repositories/service-accounts');
  const { createApiKey } = await import('../src/repositories/api-keys');
  const { hashSecretKeyAsync } = await import('../src/shared/token-hash');

  // People: one synthetic auth user per role, the same people in both contexts.
  const userIds = {} as Record<Role, string>;
  const jwts = {} as Record<Role, string>;
  for (const role of ROLES) {
    const email = `ws-parity-${role.replace('_', '-')}@example.test`;
    const created = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { apikey: service, authorization: `Bearer ${service}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
    });
    if (!created.ok && created.status !== 422) throw new Error(`create ${email}: ${created.status}`);
    const token = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: anon, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    if (!token.ok) throw new Error(`sign in ${email}: ${token.status}`);
    const body = (await token.json()) as { access_token: string; user: { id: string } };
    userIds[role] = body.user.id;
    jwts[role] = body.access_token;
    // The branch database has its own copy of auth.users; the SSO check joins it.
    await db.execute(sql`insert into auth.users (id, email, aud, role, instance_id, created_at, updated_at)
      values (${body.user.id}::uuid, ${email}, 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', now(), now())
      on conflict (id) do nothing`);
    // A JWT is live only while its auth.sessions row is (shared/jwt-liveness.ts):
    // mirror the session the sign-in just created.
    const claims = JSON.parse(Buffer.from(body.access_token.split('.')[1]!, 'base64url').toString('utf8')) as { session_id: string };
    await db.execute(sql`insert into auth.sessions (id, user_id, created_at, updated_at, aal)
      values (${claims.session_id}::uuid, ${body.user.id}::uuid, now(), now(), 'aal1')
      on conflict (id) do nothing`);
  }

  const [memberProjectRole] = await db
    .select({ roleId: schema.iamRoles.roleId })
    .from(schema.iamRoles)
    .where(and(eq(schema.iamRoles.key, 'member'), eq(schema.iamRoles.scopeType, 'project'), isNull(schema.iamRoles.accountId)));
  if (!memberProjectRole) throw new Error('system role project:member is missing');

  const contexts = {} as Record<Ctx, ContextState>;
  const credentials: Credential[] = [];

  for (const ctx of ['one', 'legacy'] as const) {
    const accountId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const siblingWorkspaceId = ctx === 'legacy' ? crypto.randomUUID() : null;
    await db.insert(schema.accounts).values({ accountId, name: `ws-parity-${ctx}` });
    await db.insert(schema.projects).values([
      {
        projectId: workspaceId,
        accountId,
        name: `ws-parity-${ctx}`,
        repoUrl: `https://example.test/${ctx}.git`,
        splitPending: ctx === 'legacy',
      },
      ...(siblingWorkspaceId
        ? [{ projectId: siblingWorkspaceId, accountId, name: 'ws-parity-sibling', repoUrl: 'https://example.test/sibling.git', splitPending: true }]
        : []),
    ]);
    contexts[ctx] = { accountId, workspaceId, siblingWorkspaceId, sandboxId: '' };

    // Memberships and grants, all on the context's primary workspace.
    const accountRole: Record<Role, 'owner' | 'admin' | 'member' | null> = {
      owner: 'owner', admin: 'admin', member: 'member', manager: 'member', project_member: 'member',
      no_grant: null, group_grant: 'member', custom_role: 'member',
    };
    for (const role of ROLES) {
      const r = accountRole[role];
      if (r) await insertIntoView(db, schema.accountMembers, { userId: userIds[role], accountId, accountRole: r });
    }
    await insertIntoView(db, schema.projectMembers, { accountId, projectId: workspaceId, userId: userIds.manager, projectRole: 'manager' });
    await insertIntoView(db, schema.projectMembers, { accountId, projectId: workspaceId, userId: userIds.project_member, projectRole: 'member' });
    const groupId = crypto.randomUUID();
    await db.insert(schema.accountGroups).values({ groupId, accountId, name: `ws-parity-group-${ctx}` });
    await db.insert(schema.accountGroupMembers).values({ groupId, userId: userIds.group_grant });
    await insertIntoView(db, schema.projectGroupGrants, { projectId: workspaceId, groupId, accountId, role: 'member' });
    const customRoleId = crypto.randomUUID();
    await db.insert(schema.iamRoles).values({ roleId: customRoleId, accountId, key: `ws-parity-${ctx}`, name: 'ws parity reader', scopeType: 'project' });
    await db.insert(schema.iamRoleActions).values([
      { roleId: customRoleId, action: 'project.read' },
      { roleId: customRoleId, action: 'project.session.read' },
    ]);
    await db.insert(schema.roleAssignments).values({
      accountId, principalType: 'user', principalId: userIds.custom_role, roleId: customRoleId, scopeType: 'project', scopeId: workspaceId,
    });

    // The agent's service account for session tokens (ungoverned: no grant).
    const agentSa = await createServiceAccount({ accountId, name: `ws-parity-agent-${ctx}`, createdBy: userIds.owner });
    const oauthClientId = crypto.randomUUID();
    await db.insert(schema.oauthClients).values({
      clientId: oauthClientId, clientSecretHash: await hashSecretKeyAsync(`ws-parity-client-${ctx}`), name: `ws-parity-${ctx}`, accountId,
    });

    for (const role of ROLES) {
      const userId = userIds[role];
      credentials.push({ ctx, role, kind: 'jwt', authorization: `Bearer ${jwts[role]}` });
      // A token needs a membership row only to be USEFUL; minting one for a
      // non-member is exactly the "no grant" case.
      const accountPat = await createAccountToken({ accountId, userId, name: `ws-parity-${role}` });
      credentials.push({ ctx, role, kind: 'account_pat', authorization: `Bearer ${accountPat.secretKey}` });
      const projectPat = await createAccountToken({ accountId, userId, name: `ws-parity-${role}-p`, projectId: workspaceId });
      credentials.push({ ctx, role, kind: 'project_pat', authorization: `Bearer ${projectPat.secretKey}` });
      // A session credential is valid only while its sandbox lease is live:
      // one `active` session_sandboxes row, no external sandbox behind it.
      const sessionId = crypto.randomUUID();
      await db.insert(schema.sessionSandboxes).values({
        sandboxId: sessionId, sessionId, accountId, projectId: workspaceId, provider: 'platinum' as never, status: 'active' as never,
      });
      if (role === 'owner') contexts[ctx].sandboxId = sessionId;
      const sessionPat = await createAccountToken({
        accountId, userId, name: `ws-parity-${role}-s`, projectId: workspaceId,
        sessionId, serviceAccountId: agentSa.serviceAccountId, onBehalfOfUserId: userId,
      });
      credentials.push({ ctx, role, kind: 'session_pat', authorization: `Bearer ${sessionPat.secretKey}` });
      const oat = `kortix_oat_${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
      await db.insert(schema.oauthAccessTokens).values({
        tokenHash: await hashSecretKeyAsync(oat), clientId: oauthClientId, userId, accountId,
        expiresAt: new Date(Date.now() + 30 * 24 * 3600_000),
      });
      credentials.push({ ctx, role, kind: 'oauth', authorization: `Bearer ${oat}` });
    }

    // A direct service-account bearer, bound to project:member on the workspace.
    const sa = await createServiceAccount({ accountId, name: `ws-parity-sa-${ctx}`, createdBy: userIds.owner });
    await db.insert(schema.roleAssignments).values({
      accountId, principalType: 'service_account', principalId: sa.serviceAccountId, roleId: memberProjectRole.roleId,
      scopeType: 'project', scopeId: workspaceId,
    });
    credentials.push({ ctx, role: 'machine', kind: 'service_account', authorization: `Bearer ${sa.secret}` });
    // A sandbox API key (`kortix_sb_`), path-allowlisted routes only.
    const apiKey = await createApiKey({ sandboxId: crypto.randomUUID(), accountId, title: `ws-parity-${ctx}`, type: 'sandbox' as never });
    credentials.push({ ctx, role: 'machine', kind: 'api_key', authorization: `Bearer ${apiKey.secretKey}` });
  }

  const state: State = { contexts, credentials };
  const out = args.state ?? 'parity-state.json';
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(state, null, 2)}\n`);
  process.stdout.write(`seeded 2 contexts, ${credentials.length} credentials -> ${out}\n`);
  process.exit(0);
}

// ─── run ─────────────────────────────────────────────────────────────────────

const FILLER = '00000000-0000-4000-8000-0000000000aa';

/** A concrete request path for a manifest route pattern. */
export function concretePath(pattern: string, ctx: ContextState): string {
  // A legacy account-keyed path takes the account id, as an old client sends it.
  // Only the canonical /v1/workspaces family takes the workspace id there.
  const accountKeyed = /^\/(v1\/accounts|v1\/account-invites|scim\/v2\/accounts)\//.test(pattern);
  return pattern
    .replace(/\{[^}]*\}/g, '') // Hono param regexes: `:path{.+}`
    .replace(/:(projectId|workspaceId)\b/g, accountKeyed ? ctx.accountId : ctx.workspaceId)
    .replace(/:accountId\b/g, ctx.accountId)
    .replace(/:sandboxId\b/g, ctx.sandboxId)
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, FILLER)
    .replace(/\*/g, 'x');
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** The auth verdict of one response. */
export function verdictOf(status: number, body: string): string {
  if (status !== 401 && status !== 403 && status !== 404 && status !== 429) return 'pass';
  if (status === 404 || status === 429) return String(status);
  const check = /check=([a-z0-9:_-]+)/i.exec(body)?.[1];
  if (check) return `${status}:${check}`;
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    /* plain text */
  }
  for (const field of ['code', 'reason']) {
    const v = parsed[field];
    if (typeof v === 'string' && v) return `${status}:${v}`;
  }
  const textField = [parsed.message, parsed.error, parsed.detail].find((v) => typeof v === 'string' && v);
  const text = String(textField ?? body).replace(UUID_RE, '<id>').replace(/\s+/g, ' ').slice(0, 60);
  return `${status}:${text}`;
}

async function run(args: Args): Promise<void> {
  const state = JSON.parse(readFileSync(args.state!, 'utf8')) as State;
  const manifestPath = args.routes ?? join(import.meta.dir, '..', '..', '..', 'tests', 'spec', 'routes.generated.json');
  const routes = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { routes: Array<{ method: string; path: string }> }).routes;
  const concurrency = Number(args.concurrency ?? 24);
  const { app } = await import('../src/app');

  type Job = { key: string; method: string; path: string; authorization: string };
  const jobs: Job[] = [];
  for (const cred of state.credentials) {
    const ctx = state.contexts[cred.ctx];
    for (const r of routes) {
      const method = r.method === 'ALL' ? 'GET' : r.method;
      jobs.push({
        key: `${r.method} ${r.path} | ${cred.ctx} | ${cred.kind} | ${cred.role}`,
        method,
        path: concretePath(r.path, ctx),
        authorization: cred.authorization,
      });
    }
  }
  const limit = args.limit ? Number(args.limit) : jobs.length;
  const results: Record<string, { verdict: string; status: number }> = {};
  let next = 0;
  let done = 0;
  const started = Date.now();
  async function worker() {
    while (next < Math.min(limit, jobs.length)) {
      const job = jobs[next++]!;
      const init: RequestInit = { method: job.method, headers: { authorization: job.authorization } };
      if (!['GET', 'HEAD', 'OPTIONS', 'DELETE'].includes(job.method)) {
        init.body = '{}';
        (init.headers as Record<string, string>)['content-type'] = 'application/json';
      }
      let status = 0;
      let body = '';
      try {
        const res = await Promise.race([
          app.request(job.path, init),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 20_000)),
        ]);
        status = res.status;
        body = status === 401 || status === 403 ? await res.text() : '';
        if (status !== 401 && status !== 403) await res.body?.cancel().catch(() => undefined);
      } catch (err) {
        status = -1;
        body = (err as Error).message;
      }
      results[job.key] = { verdict: status === -1 ? `error:${body.slice(0, 40)}` : verdictOf(status, body), status };
      done++;
      if (done % 2000 === 0) process.stderr.write(`[parity] ${done}/${limit} ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const out = args.out ?? 'parity.json';
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ label: args.label ?? '', requests: done, results }, null, 1)}\n`);
  process.stdout.write(`ran ${done} requests in ${((Date.now() - started) / 1000).toFixed(0)}s -> ${out}\n`);
  process.exit(0);
}

// ─── diff ────────────────────────────────────────────────────────────────────

/**
 * Differences the design intends, with the reason. A diff row whose verdicts
 * and request match one of these is "intended"; every other row is
 * "UNEXPECTED" and must be fixed before merge.
 */
interface Intended {
  why: string;
  match: (row: { method: string; path: string; ctx: string; kind: string; role: string; base: string; head: string }) => boolean;
}

const BOUND = new Set(['project_pat', 'session_pat']);
const FENCE_RENAMES: Record<string, string[]> = {
  'cross-project': ['cross-workspace'],
  'default-deny': ['platform-route', 'person-route', 'default-deny'],
  'account-level-route': ['person-route', 'account-wider-than-workspace', 'cross-workspace'],
  'project-list': ['person-route'],
  'foreign-sandbox': ['foreign-sandbox'],
};
const fenceCheck = (v: string) => /^403:token-project-scope:(.+)$/.exec(v)?.[1] ?? null;
/** A canonical route the base tree never mounted. */
const CANONICAL = /^\/(v1\/workspaces|v1\/me|v1\/invites|v1\/connectors\/workspaces|v1\/webhooks\/workspaces|scim\/v2\/workspaces)(\/|$)/;
/** Legacy-named routes the branch added (no base handler): the account-keyed token list, the person's keys, setup and restore, the deletion plan. */
const NEW_LEGACY_ROUTES = /^\/v1\/(accounts\/:workspaceId\/tokens|accounts\/me\/tokens|projects\/:workspaceId\/(setup|restore)$|account\/deletion-plan$)/;
/** Routes that name no workspace: they act on the caller's own (default) workspace or on the person. */
const NO_WORKSPACE_IN_PATH = (path: string) => !/:(workspaceId|projectId|accountId|id)\b/.test(path.replace(/\/:(tokenId|installationId|sessionId)\b/g, ''));

const INTENDED: Intended[] = [
  {
    why: 'New canonical route: the base tree answers 404 (not mounted); the head serves the /v1/workspaces family (design.md §3.2 C5).',
    match: (r) => r.base === '404' && CANONICAL.test(r.path),
  },
  {
    why: 'K1, one fence rule: a workspace-bound key reaches every route of its OWN workspace, administration included (members, IAM, tokens, billing reads, the list); its holder\'s role decides (C4, findings 15, 25).',
    match: (r) =>
      BOUND.has(r.kind) &&
      ['account-level-route', 'project-list'].includes(fenceCheck(r.base) ?? '') &&
      !r.head.startsWith('403:token-project-scope:'),
  },
  {
    why: 'Fence check renamed with the same refusal: cross-project → cross-workspace, default-deny → platform-route / person-route, account-level-route → person-route / account-wider-than-workspace (C4).',
    match: (r) => {
      const b = fenceCheck(r.base);
      const h = fenceCheck(r.head);
      return b !== null && h !== null && (FENCE_RENAMES[b] ?? []).includes(h);
    },
  },
  {
    why: 'K1: an inherited (ungoverned) agent session acts as its person minus HUMAN_ONLY; step 4b (agents never administer) is deleted (C8).',
    match: (r) => r.kind === 'session_pat' && r.base === '403:agent_human_only_action' && r.head !== r.base,
  },
  {
    why: 'HUMAN_ONLY (C8): minting credentials and moving money are refused to every agent session; on the account surface its reason was token_out_of_scope.',
    match: (r) => r.kind === 'session_pat' && r.head === '403:agent_human_only_action',
  },
  {
    why: 'C4: an account-scope action is in scope for a workspace-bound key on its own 1:1 workspace (token_out_of_scope → the role decides).',
    match: (r) => BOUND.has(r.kind) && r.ctx === 'one' && r.base === '403:token_out_of_scope',
  },
  {
    why: 'Membership is access (C3, findings 3, 4): an account member of a 1:1 workspace reaches it at the member tier, so the project gate passes and the route\'s own next gate answers (pass, a role/leaf denial, a feature flag, an agent-session rule).',
    match: (r) =>
      r.ctx === 'one' &&
      ['member', 'manager', 'project_member', 'group_grant', 'custom_role'].includes(r.role) &&
      /no_project_membership|You do not have access to this project/.test(r.base) &&
      !/no_project_membership|do not have access to this workspace/.test(r.head),
  },
  {
    why: 'K1, budgets: an inherited agent session sets and deletes gateway budgets as its person (the route answered its own "You do not have permission to set budgets").',
    match: (r) => r.kind === 'session_pat' && r.path.includes('/gateway/budgets') && /permission to set budgets/.test(r.base) && r.head === 'pass',
  },
  {
    why: 'Membership is access (C3) on routes with their own denial wording: the connector gateway (403 forbidden), the sandbox proxy (Not authorized to access this sandbox), a hidden-artifact 404 that now reaches its feature gate.',
    match: (r) =>
      r.ctx === 'one' &&
      r.role === 'member' &&
      /^(403:forbidden|403:Not authorized to access this sandbox|404)$/.test(r.base) &&
      /^\/v1\/(connectors\/(projects|workspaces)|p|projects|workspaces)\//.test(r.path) &&
      (r.head === 'pass' || r.head === '403:feature_disabled'),
  },
  {
    why: 'C4 reach param: a workspace-bound key reaches the billing surface of its own workspace (the account_id it names, or none); the route answers for itself.',
    match: (r) =>
      BOUND.has(r.kind) && r.path.startsWith('/v1/billing/') && fenceCheck(r.base) === 'default-deny' && !r.head.startsWith('403:token-project-scope:'),
  },
  {
    why: 'Auth stage, key expiry (C4a): a project key minting a CLI token without expires_at gets its own expiry (clampDefaultToParentExpiry) instead of 403 token_mint_exceeds_parent; a later expiry is still refused.',
    match: (r) =>
      r.kind === 'project_pat' &&
      r.method === 'POST' &&
      /^\/v1\/(projects|workspaces)\/:workspaceId\/cli-token$/.test(r.path) &&
      r.base === '403:token_mint_exceeds_parent' &&
      r.head === 'pass',
  },
  {
    why: 'A legacy-named route this branch added (C5): the base tree has no handler (404); the head serves it and its own gate answers.',
    match: (r) => r.base === '404' && NEW_LEGACY_ROUTES.test(r.path),
  },
  {
    why: '"Delete my account" deletes the PERSON (DEL-7, DEL-8): the /v1/account/* deletion routes act on the caller, not on an account role; a workspace-bound or machine credential is refused (person_credential_required).',
    match: (r) => /^\/v1\/account\/(cancel-deletion|deletion-status|delete-immediately|request-deletion|deletion-plan)$/.test(r.path) &&
      (r.head === 'pass' || r.head === '403:person_credential_required'),
  },
  {
    why: 'D3, no account at sign-up: a person in no workspace (no_grant, a machine) on a route that names no workspace acts on their own; the base resolved someone else\'s default account and refused it (403 not a member / no access).',
    match: (r) => ['no_grant', 'machine'].includes(r.role) && NO_WORKSPACE_IN_PATH(r.path) &&
      /^403:(You do not have access to this account|not_a_member)$/.test(r.base) &&
      (r.head === 'pass' || r.head === '403:account_role_insufficient' || r.head === '403:person_credential_required'),
  },
  {
    why: 'PROJ-48: the published CLI\'s provision into an occupied account gives a member a NEW workspace of their own instead of 403 owner/admin required.',
    match: (r) => /^\/v1\/projects\/provision(-stream)?$/.test(r.path) && r.base === '403:Owner or admin role required' && r.head === 'pass',
  },
  {
    why: 'K2: only an owner deletes a workspace; admins and managers get 403 account_role_insufficient.',
    match: (r) => r.method === 'DELETE' && /^\/v1\/(projects|workspaces)\/:workspaceId$/.test(r.path) && ['admin', 'manager'].includes(r.role) &&
      r.base === 'pass' && r.head === '403:account_role_insufficient',
  },
  {
    why: 'A non-member no longer reads another account\'s subscription connections (the base legacy route answered 200; a closing gap, finding 30).',
    match: (r) => r.path.endsWith('/subscription-connections') && ['no_grant', 'machine'].includes(r.role) && r.base === 'pass' && r.head.startsWith('403:'),
  },
  {
    why: 'Copy only (finding 20): the same denial now says "this workspace" (no_project_membership text, account denial text).',
    match: (r) => r.base.replace(/project|account/g, 'X') === r.head.replace(/workspace/g, 'X'),
  },
];

/**
 * Differences that are not verdicts at all, excluded from the gate and counted:
 * the in-process rate limiters (429) and the 20 s request timeout depend on
 * timing; a route that serves build artifacts answers 404 in a checkout that
 * never built them (the base tree), whatever the credential.
 */
function noiseOf(r: { path: string; base: string; head: string }): string | null {
  if ([r.base, r.head].some((v) => v === '429' || v.startsWith('error:'))) return 'timing (429 rate limit or 20 s timeout)';
  // The two runs share one GoTrue session per person: a sign-out or MFA route
  // that one run reaches first ends the session for both.
  if (r.path.startsWith('/v1/auth/') && [r.base, r.head].includes('403:session_not_found')) {
    return 'shared GoTrue session (a sign-out in the other run ended it)';
  }
  if (r.path.startsWith('/v1/runtime-assets/') && [r.base, r.head].includes('404') && [r.base, r.head].includes('pass')) {
    return 'environment (runtime artifacts built in one checkout only)';
  }
  return null;
}

async function diff(args: Args): Promise<void> {
  const base = JSON.parse(readFileSync(args.base!, 'utf8')) as { results: Record<string, { verdict: string; status: number }> };
  const head = JSON.parse(readFileSync(args.head!, 'utf8')) as { results: Record<string, { verdict: string; status: number }> };
  const keys = Object.keys(head.results);
  const rows: Array<{ method: string; path: string; ctx: string; kind: string; role: string; base: string; head: string; why: string | null }> = [];
  let same = 0;
  let missing = 0;
  const verdictCounts = new Map<string, number>();
  const noiseCounts = new Map<string, number>();
  for (const key of keys) {
    const h = head.results[key]!;
    const b = base.results[key];
    verdictCounts.set(h.verdict.split(':')[0]!, (verdictCounts.get(h.verdict.split(':')[0]!) ?? 0) + 1);
    if (!b) {
      missing++;
      continue;
    }
    if (b.verdict === h.verdict) {
      same++;
      continue;
    }
    const [route, ctx, kind, role] = key.split(' | ');
    const [method, ...p] = route!.split(' ');
    const row = { method: method!, path: p.join(' '), ctx: ctx!, kind: kind!, role: role!, base: b.verdict, head: h.verdict };
    const noise = noiseOf(row);
    if (noise) {
      noiseCounts.set(noise, (noiseCounts.get(noise) ?? 0) + 1);
      continue;
    }
    const intended = INTENDED.find((i) => i.match(row));
    rows.push({ ...row, why: intended?.why ?? null });
  }
  const unexpected = rows.filter((r) => r.why === null);
  const intended = rows.filter((r) => r.why !== null);
  const lines: string[] = [];
  lines.push('# Workspace verdict parity (W3: one IAM scope, one fence)', '');
  lines.push(`Generated by \`apps/api/scripts/workspace-verdict-parity.ts diff\`. Synthetic data only.`, '');
  lines.push('| Measure | Value |', '|---|---|');
  lines.push(`| Requests compared | ${keys.length - missing} |`);
  lines.push(`| Same verdict | ${same} |`);
  lines.push(`| Different verdict (auth) | ${rows.length} |`);
  lines.push(`| Different, intended | ${intended.length} |`);
  lines.push(`| Different, UNEXPECTED | ${unexpected.length} |`);
  lines.push(`| Head-only requests (no base result) | ${missing} |`);
  for (const [why, n] of noiseCounts) lines.push(`| Not a verdict difference: ${why} | ${n} |`);
  lines.push('');
  lines.push('Head verdict classes: ' + [...verdictCounts.entries()].sort().map(([k, v]) => `\`${k}\` ${v}`).join(', '), '');
  const section = (title: string, list: typeof rows) => {
    lines.push(`## ${title} (${list.length})`, '');
    if (list.length === 0) {
      lines.push('None.', '');
      return;
    }
    lines.push('| Method | Route | Context | Credential | Role | Base | Head | Why |', '|---|---|---|---|---|---|---|---|');
    const cell = (v: string) => v.replace(/\|/g, '\\|');
    for (const r of list) {
      lines.push(
        `| ${r.method} | \`${cell(r.path)}\` | ${r.ctx} | ${r.kind} | ${r.role} | \`${cell(r.base)}\` | \`${cell(r.head)}\` | ${r.why ?? 'UNEXPECTED'} |`,
      );
    }
    lines.push('');
  };
  lines.push('## Intended differences by route', '');
  lines.push('| Method | Route | Requests | Roles | Base verdicts → head verdict |', '|---|---|---|---|---|');
  const byRoute = new Map<string, typeof rows>();
  for (const r of intended) byRoute.set(`${r.method} ${r.path}`, [...(byRoute.get(`${r.method} ${r.path}`) ?? []), r]);
  for (const [route, list] of [...byRoute.entries()].sort()) {
    const [method, ...p] = route.split(' ');
    const roles = [...new Set(list.map((r) => r.role))].sort().join(', ');
    const pairs = [...new Set(list.map((r) => `\`${r.base}\` → \`${r.head}\``))].join('; ').replace(/\|/g, '\\|');
    lines.push(`| ${method} | \`${p.join(' ')}\` | ${list.length} | ${roles} | ${pairs} |`);
  }
  lines.push('');
  section('UNEXPECTED differences', unexpected);
  section('Intended differences', intended);
  const out = args.md ?? 'workspace-parity.md';
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${lines.join('\n')}\n`);
  process.stdout.write(`compared ${keys.length - missing}: same ${same}, intended ${intended.length}, unexpected ${unexpected.length} -> ${out}\n`);
  process.exit(unexpected.length === 0 ? 0 : 1);
}

if (import.meta.main) {
  const { cmd, args } = parseArgs(process.argv.slice(2));
  const commands: Record<string, (a: Args) => Promise<void>> = { seed, run, diff };
  const fn = commands[cmd];
  if (!fn) {
    process.stderr.write('usage: workspace-verdict-parity.ts seed|run|diff [--state f] [--out f] [--base f --head f --md f]\n');
    process.exit(2);
  }
  await fn(args);
}
