#!/usr/bin/env bun
/**
 * Prod-shaped seed for the workspace migrations and the split (Workspaces
 * design.md §7 "Prod-shaped data" (a)). Synthetic and PII-free: every name is
 * generated, every email is `@example.test`, every id is a hash of this
 * script's own namespace. No row comes from a real deployment.
 *
 * It reproduces the measured prod shape of 2026-11-05 (README.md "The data
 * agrees") at 1/--scale (default 1/20):
 *
 *   | prod                                   | at 1/20 |
 *   |----------------------------------------|---------|
 *   | 8,049 accounts with exactly 1 project  | 402     |
 *   | 401 accounts with 2+ projects, max 23  | 20 (2–23 projects; the tail is kept, so the
 *   |                                        |  project count is ~1/15, not 1/20) |
 *   | 40,618 accounts with 0 projects        | 2,031   |
 *   | 58 people in 2+ accounts               | 3       |
 *
 * The legacy accounts carry what the split must move (split-runbook.md "What
 * one move does"):
 *   - the 23-project account: account-wide secrets with a grant, 2 groups with
 *     members, a custom project role with a grant, an admin, a pending invite
 *     that spans 3 projects, a GitHub installation and user token, an app with a
 *     static site (blob uploaded to this stack's Supabase Storage), an
 *     account token with no project, an archived project;
 *   - rotating subscription logins in the 23-project account: a ChatGPT login
 *     a moving project's session used last, an OpenCode Console login the
 *     keeper used last, and a static OpenCode API key (the split hands each
 *     login to one side and copies the static key to both);
 *   - an account default model and a moving project's own default model;
 *   - one paying account (a paid plan, a completed purchase, a Stripe
 *     customer): the split holds it until its owner confirms a keeper, then
 *     comps the keeper's plan to each split-off;
 *   - one account with a stale Stripe subscription id on Free (149 in prod):
 *     it pays nothing, so the split does not hold it;
 *   - every account: credits, an owner grant, sessions, project secrets.
 * 1:1 account names differ from their project names, as in prod, so the M2
 * name backfill has work to do.
 *
 * It runs before or after the workspace migrations: when
 * `kortix.projects.split_pending` exists, the legacy projects are written with
 * it set (the unique index `uq_projects_workspace_account` refuses them
 * otherwise).
 *
 * SAFE BY CONSTRUCTION
 *   - Refuses any DATABASE_URL host but 127.0.0.1 / localhost, and refuses
 *     INTERNAL_KORTIX_ENV=prod.
 *   - Idempotent: `--reset` deletes exactly the ids this script generates
 *     (accounts cascade), then seeds again.
 *
 * USAGE (from apps/api, against a worktree's own `--db` database)
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/kortix_wt_<slug> \
 *     dotenvx run -q -f .env -- bun scripts/seed-prod-shape.ts [--scale 20] [--reset] [--no-storage]
 *
 * Prints one JSON summary of what it wrote (counts only).
 */
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../src/shared/db';
import { encryptAccountSecret } from '../src/secrets/account-resource';
import { encryptProjectSecret } from '../src/projects/secrets';
import { pendingPrincipalId } from '../src/iam/actor';
import { supabaseSiteStorage } from '../src/apps/static-site';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const option = (name: string, fallback: number) => {
  const at = argv.indexOf(`--${name}`);
  const value = at >= 0 ? Number(argv[at + 1]) : fallback;
  if (!Number.isFinite(value) || value < 1) throw new Error(`--${name} must be a positive number`);
  return value;
};

const SCALE = option('scale', 20);
const NAMESPACE = 'w7-prod-shape';
const PROD = { oneToOne: 8_049, legacy: 401, empty: 40_618, multiAccountPeople: 58 };

const url = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid');
if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
  console.error(`refusing: DATABASE_URL host ${url.hostname} is not local`);
  process.exit(2);
}
if (process.env.INTERNAL_KORTIX_ENV === 'prod') {
  console.error('refusing: INTERNAL_KORTIX_ENV=prod');
  process.exit(2);
}

/** A stable uuid for (kind, index): md5 of this script's namespace. */
function sid(kind: string, ...index: Array<number | string>): string {
  const hex = createHash('md5').update(`${NAMESPACE}:${kind}:${index.join(':')}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const email = (user: string) => `${user.slice(0, 8)}@example.test`;
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const ONE = Math.round(PROD.oneToOne / SCALE);
const EMPTY = Math.round(PROD.empty / SCALE);
const LEGACY = Math.max(2, Math.round(PROD.legacy / SCALE));
const PEOPLE = Math.max(1, Math.round(PROD.multiAccountPeople / SCALE));
/** Projects per legacy account: the max-23 tail, a few mid-size, the rest 2 (prod median). */
const LEGACY_SIZES = Array.from({ length: LEGACY }, (_, i) => [23, 5, 4, 3, 3, 3][i] ?? 2);

const accountIds = {
  one: (i: number) => sid('account-one', i),
  legacy: (i: number) => sid('account-legacy', i),
  empty: (i: number) => sid('account-empty', i),
};
const allAccountIds = [
  ...Array.from({ length: ONE }, (_, i) => accountIds.one(i)),
  ...Array.from({ length: LEGACY }, (_, i) => accountIds.legacy(i)),
  ...Array.from({ length: EMPTY }, (_, i) => accountIds.empty(i)),
];

type Row = Record<string, unknown>;
/** Insert rows as one jsonb_to_recordset statement per chunk (raw SQL: no Drizzle column list, so it runs on either schema). */
async function insert(table: string, columns: Record<string, string>, rows: Row[]): Promise<number> {
  const names = Object.keys(columns);
  const recordType = names.map((name) => `"${name}" ${columns[name]}`).join(', ');
  const list = names.map((name) => `"${name}"`).join(', ');
  for (let at = 0; at < rows.length; at += 1_000) {
    const chunk = rows.slice(at, at + 1_000);
    await db.execute(sql.raw(`INSERT INTO ${table} (${list})
      SELECT ${list} FROM jsonb_to_recordset('${JSON.stringify(chunk).replace(/'/g, "''")}'::jsonb) AS r(${recordType})
      ON CONFLICT DO NOTHING`));
  }
  return rows.length;
}

async function systemRoles(): Promise<Record<string, string>> {
  const rows = await db.execute<{ key: string; scope_type: string; role_id: string }>(sql`
    SELECT key, scope_type, role_id::text FROM kortix.roles WHERE account_id IS NULL`);
  const out: Record<string, string> = {};
  for (const row of rows) out[`${row.key}/${row.scope_type}`] = row.role_id;
  for (const key of ['owner/account', 'admin/account', 'member/account', 'member/project', 'manager/project']) {
    if (!out[key]) throw new Error(`system role ${key} missing: run the migrations first`);
  }
  return out;
}

async function reset(): Promise<void> {
  const ids = JSON.stringify(allAccountIds);
  await db.execute(sql`DELETE FROM kortix.app_site_blobs WHERE account_id::text IN (SELECT jsonb_array_elements_text(${ids}::jsonb))`);
  await db.execute(sql`DELETE FROM kortix.credit_purchases WHERE account_id::text IN (SELECT jsonb_array_elements_text(${ids}::jsonb))`);
  await db.execute(sql`DELETE FROM kortix.billing_customers WHERE account_id::text IN (SELECT jsonb_array_elements_text(${ids}::jsonb))`);
  await db.execute(sql`DELETE FROM kortix.credit_accounts WHERE account_id::text IN (SELECT jsonb_array_elements_text(${ids}::jsonb))`);
  await db.execute(sql`DELETE FROM kortix.accounts WHERE account_id::text IN (SELECT jsonb_array_elements_text(${ids}::jsonb))`);
}

async function main(): Promise<void> {
  if (flag('reset')) await reset();
  const roles = await systemRoles();
  const [{ has_split_pending: hasSplitPending } = { has_split_pending: false }] = await db.execute<{ has_split_pending: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'kortix' AND table_name = 'projects' AND column_name = 'split_pending') AS has_split_pending`);

  const accounts: Row[] = [];
  const projects: Row[] = [];
  const memberships: Row[] = [];
  const grants: Row[] = [];
  const credits: Row[] = [];
  const sessions: Row[] = [];
  const projectSecrets: Row[] = [];
  const owner = (accountId: string) => sid('owner', accountId);
  const addGrant = (accountId: string, principalId: string, role: string, scopeId: string | null, principalType = 'user') =>
    grants.push({
      assignment_id: sid('grant', accountId, principalType, principalId, role, scopeId ?? 'account'),
      account_id: accountId, principal_type: principalType, principal_id: principalId,
      role_id: roles[role]!, scope_type: role.endsWith('/account') ? 'account' : 'project', scope_id: scopeId,
    });
  const addProject = (accountId: string, projectId: string, name: string, opts: { legacy: boolean; openedMinutesAgo: number | null; status?: string }) => {
    projects.push({
      project_id: projectId, account_id: accountId, name, repo_url: `https://git.example.test/${projectId.slice(0, 8)}.git`,
      status: opts.status ?? 'active', last_opened_at: opts.openedMinutesAgo === null ? null : minutesAgo(opts.openedMinutesAgo),
      ...(hasSplitPending ? { split_pending: opts.legacy && (opts.status ?? 'active') === 'active' } : {}),
    });
    const sessionId = `w7-shape-${projectId.slice(0, 13)}`;
    sessions.push({ session_id: sessionId, account_id: accountId, project_id: projectId, branch_name: 'main' });
    projectSecrets.push({
      project_id: projectId, name: 'SHAPE_TOKEN', identifier: 'SHAPE_TOKEN',
      value_enc: encryptProjectSecret(projectId, `synthetic-${projectId.slice(0, 8)}`),
    });
  };
  const addAccount = (accountId: string, name: string, balance: number) => {
    accounts.push({ account_id: accountId, name });
    memberships.push({ user_id: owner(accountId), account_id: accountId });
    addGrant(accountId, owner(accountId), 'owner/account', null);
    credits.push({ account_id: accountId, balance, lifetime_granted: balance });
  };

  // 1:1 accounts: the personal-name-vs-project-name gap prod has; 1 in 10 with a member.
  for (let i = 0; i < ONE; i += 1) {
    const accountId = accountIds.one(i);
    const projectId = sid('project-one', i);
    addAccount(accountId, i % 4 === 0 ? `Shape workspace ${i}` : `Shape personal ${i}`, 5);
    addProject(accountId, projectId, `Shape workspace ${i}`, { legacy: false, openedMinutesAgo: i % 3 === 0 ? null : 60 * (i + 1) });
    if (i % 10 === 0) {
      const member = sid('member-one', i);
      memberships.push({ user_id: member, account_id: accountId });
      addGrant(accountId, member, 'member/account', null);
      addGrant(accountId, member, 'member/project', projectId);
    }
  }

  // Legacy multi-project accounts.
  const legacyProjects: string[][] = [];
  for (let i = 0; i < LEGACY; i += 1) {
    const accountId = accountIds.legacy(i);
    addAccount(accountId, `Shape company ${i}`, 20);
    const ids = Array.from({ length: LEGACY_SIZES[i]! }, (_, p) => sid('project-legacy', i, p));
    legacyProjects.push(ids);
    ids.forEach((projectId, p) =>
      addProject(accountId, projectId, `Shape company ${i} project ${p}`, { legacy: true, openedMinutesAgo: p === ids.length - 1 ? null : 30 * (p + 1) + i }));
    // Members with per-project access (prod's per-project privacy).
    for (let m = 0; m < 1 + (i % 3); m += 1) {
      const member = sid('member-legacy', i, m);
      memberships.push({ user_id: member, account_id: accountId });
      addGrant(accountId, member, 'member/account', null);
      addGrant(accountId, member, 'member/project', ids[m % ids.length]!);
    }
  }
  // An archived project in the big account: never counted, never moved.
  addProject(accountIds.legacy(0), sid('project-legacy-archived', 0), 'Shape company 0 archived', { legacy: true, openedMinutesAgo: 9_000, status: 'archived' });

  // Dormant accounts: an owner, credits, no project.
  for (let i = 0; i < EMPTY; i += 1) addAccount(accountIds.empty(i), `Shape personal empty ${i}`, i % 2 ? 0 : 5);

  // People in several accounts: a member of a 1:1, a legacy and a dormant account.
  for (let p = 0; p < PEOPLE; p += 1) {
    const person = sid('person-multi', p);
    const oneAccount = accountIds.one(p + 1);
    const legacyIndex = 1 + (p % (LEGACY - 1));
    for (const accountId of [oneAccount, accountIds.legacy(legacyIndex), accountIds.empty(p + 1)]) {
      memberships.push({ user_id: person, account_id: accountId });
      addGrant(accountId, person, 'member/account', null);
    }
    addGrant(oneAccount, person, 'member/project', sid('project-one', p + 1));
    addGrant(accountIds.legacy(legacyIndex), person, 'member/project', legacyProjects[legacyIndex]![0]!);
  }

  // The big legacy account's directory and integrations.
  const big = accountIds.legacy(0);
  const bigProjects = legacyProjects[0]!;
  const admin = sid('admin', big);
  memberships.push({ user_id: admin, account_id: big });
  addGrant(big, admin, 'admin/account', null);
  const groups = [sid('group', big, 0), sid('group', big, 1)];
  const groupUsers = [sid('group-user', big, 0), sid('group-user', big, 1), sid('group-user', big, 2)];
  for (const user of groupUsers) memberships.push({ user_id: user, account_id: big });
  const customRole = sid('custom-role', big);
  const customUser = sid('custom-user', big);
  memberships.push({ user_id: customUser, account_id: big });

  const counts: Record<string, number> = {};
  counts.accounts = await insert('kortix.accounts', { account_id: 'uuid', name: 'text' }, accounts);
  counts.projects = await insert('kortix.projects', {
    project_id: 'uuid', account_id: 'uuid', name: 'text', repo_url: 'text', status: 'kortix.project_status', last_opened_at: 'timestamptz',
    ...(hasSplitPending ? { split_pending: 'boolean' } : {}),
  }, projects);
  counts.memberships = await insert('kortix.account_memberships', { user_id: 'uuid', account_id: 'uuid' }, memberships);
  counts.credit_accounts = await insert('kortix.credit_accounts', { account_id: 'uuid', balance: 'numeric', lifetime_granted: 'numeric' }, credits);
  counts.sessions = await insert('kortix.project_sessions', { session_id: 'text', account_id: 'uuid', project_id: 'uuid', branch_name: 'text' }, sessions);
  counts.project_secrets = await insert('kortix.project_secrets', { project_id: 'uuid', name: 'text', identifier: 'text', value_enc: 'text' }, projectSecrets);

  counts.groups = await insert('kortix.account_groups', { group_id: 'uuid', account_id: 'uuid', name: 'text' },
    groups.map((groupId, g) => ({ group_id: groupId, account_id: big, name: `Shape group ${g}` })));
  await insert('kortix.account_group_members', { group_id: 'uuid', user_id: 'uuid' },
    groupUsers.map((userId, u) => ({ group_id: groups[u % 2]!, user_id: userId })));
  counts.custom_roles = await insert('kortix.roles', { role_id: 'uuid', account_id: 'uuid', key: 'text', name: 'text', scope_type: 'text' },
    [{ role_id: customRole, account_id: big, key: 'shape_reviewer', name: 'Shape reviewer', scope_type: 'project' }]);
  await insert('kortix.role_permissions', { role_id: 'uuid', action: 'text' },
    [{ role_id: customRole, action: 'project.read' }, { role_id: customRole, action: 'project.session.read' }]);
  roles.custom = customRole;
  const invitee = 'shape-invitee@example.test';
  addGrant(big, groups[0]!, 'member/project', bigProjects[1]!, 'group');
  addGrant(big, groups[1]!, 'manager/project', bigProjects[2]!, 'group');
  grants.push({
    assignment_id: sid('grant-custom', big), account_id: big, principal_type: 'user', principal_id: customUser,
    role_id: customRole, scope_type: 'project', scope_id: bigProjects[3]!,
  });
  for (const projectId of bigProjects.slice(1, 4)) addGrant(big, pendingPrincipalId(invitee), 'member/project', projectId, 'pending');
  counts.role_assignments = await insert('kortix.role_assignments', {
    assignment_id: 'uuid', account_id: 'uuid', principal_type: 'text', principal_id: 'uuid', role_id: 'uuid', scope_type: 'text', scope_id: 'uuid',
  }, grants);
  counts.invites = await insert('kortix.account_invitations', { invite_id: 'uuid', account_id: 'uuid', email: 'text', invited_by: 'uuid', bootstrap_grants: 'jsonb' },
    [{ invite_id: sid('invite', big), account_id: big, email: invitee, invited_by: owner(big),
       bootstrap_grants: bigProjects.slice(1, 4).map((projectId) => ({ project_id: projectId, role: 'member' })) }]);

  const accountSecrets = [sid('account-secret', big, 0), sid('account-secret', big, 1)];
  counts.account_secrets = await insert('kortix.account_secret_resources', {
    secret_id: 'uuid', account_id: 'uuid', project_id: 'uuid', label: 'text', name: 'text', provider_id: 'text', value_enc: 'text',
    consumer: 'kortix.project_secret_consumer', strategy: 'kortix.project_secret_strategy', created_by: 'uuid',
  }, [
    ...accountSecrets.map((secretId, s) => ({
      secret_id: secretId, account_id: big, project_id: null, label: `Shape account key ${s}`, name: `SHAPE_ACCOUNT_KEY_${s}`,
      provider_id: 'anthropic', value_enc: encryptAccountSecret(big, `synthetic-account-${s}`), consumer: 'llm_gateway', strategy: 'runtime', created_by: owner(big),
    })),
    {
      secret_id: sid('project-scoped-secret', big), account_id: big, project_id: bigProjects[1]!, label: 'Shape project key', name: 'SHAPE_PROJECT_KEY',
      provider_id: 'openai', value_enc: encryptAccountSecret(big, 'synthetic-project'), consumer: 'llm_gateway', strategy: 'runtime', created_by: owner(big),
    },
  ]);
  await insert('kortix.account_secret_grants', { secret_id: 'uuid', account_id: 'uuid', user_id: 'uuid', granted_by: 'uuid' },
    [{ secret_id: accountSecrets[0]!, account_id: big, user_id: customUser, granted_by: owner(big) }]);
  // Subscription logins (synthetic tokens): two rotate on use, one is a static key.
  const logins = { codex: sid('login-codex', big), opencode: sid('login-opencode', big), staticKey: sid('login-static', big) };
  const inAnHour = Date.now() + 3_600_000;
  counts.rotating_logins = await insert('kortix.account_secret_resources', {
    secret_id: 'uuid', account_id: 'uuid', label: 'text', name: 'text', provider_id: 'text', value_enc: 'text',
    consumer: 'kortix.project_secret_consumer', strategy: 'kortix.project_secret_strategy', created_by: 'uuid',
  }, [
    { secret_id: logins.codex, account_id: big, label: 'Shape ChatGPT', name: 'CODEX_AUTH_JSON', provider_id: 'codex', consumer: 'llm_gateway', strategy: 'broker', created_by: owner(big),
      value_enc: encryptAccountSecret(big, JSON.stringify({ openai: { type: 'oauth', access: 'shape-access', refresh: 'shape-refresh', expires: inAnHour } })) },
    { secret_id: logins.opencode, account_id: big, label: 'Shape OpenCode', name: 'OPENCODE_API_KEY', provider_id: 'opencode', consumer: 'llm_gateway', strategy: 'runtime', created_by: owner(big),
      value_enc: encryptAccountSecret(big, JSON.stringify({ type: 'oauth', access: 'shape-oc-access', refresh: 'shape-oc-refresh', expires: inAnHour })) },
    { secret_id: logins.staticKey, account_id: big, label: 'Shape OpenCode key', name: 'OPENCODE_GO_API_KEY', provider_id: 'opencode-go', consumer: 'llm_gateway', strategy: 'runtime', created_by: owner(big),
      value_enc: encryptAccountSecret(big, 'synthetic-static-key') },
  ]) - 1;
  await insert('kortix.session_provider_secret_pools', { session_id: 'text', provider_id: 'text', secret_ids: 'jsonb', updated_at: 'timestamptz' }, [
    { session_id: `w7-shape-${bigProjects[1]!.slice(0, 13)}`, provider_id: 'anthropic', secret_ids: accountSecrets, updated_at: minutesAgo(60) },
    // A moving project used ChatGPT last; the keeper (project 0, opened most recently) used OpenCode last.
    { session_id: `w7-shape-${bigProjects[1]!.slice(0, 13)}`, provider_id: 'codex', secret_ids: [logins.codex], updated_at: minutesAgo(1) },
    { session_id: `w7-shape-${bigProjects[1]!.slice(0, 13)}`, provider_id: 'opencode', secret_ids: [logins.opencode, logins.staticKey], updated_at: minutesAgo(90) },
    { session_id: `w7-shape-${bigProjects[0]!.slice(0, 13)}`, provider_id: 'opencode', secret_ids: [logins.opencode], updated_at: minutesAgo(2) },
  ]);
  // The account default model and a moving project's own default.
  counts.model_preferences = await insert('kortix.account_model_preferences', { account_id: 'uuid', scope: 'text', scope_key: 'text', model: 'text' }, [
    { account_id: big, scope: 'account', scope_key: 'default', model: 'synthetic-shape-account-model' },
    { account_id: big, scope: 'project', scope_key: bigProjects[2]!, model: 'synthetic-shape-project-model' },
  ]);
  counts.github_installations = await insert('kortix.account_github_installations', { account_id: 'uuid', installation_id: 'text', owner_login: 'text' },
    [{ account_id: big, installation_id: '700001', owner_login: 'shape-org' }]);
  await insert('kortix.account_github_user_tokens', { account_id: 'uuid', user_id: 'uuid', github_login: 'text', value_enc: 'text' },
    [{ account_id: big, user_id: owner(big), github_login: 'shape-user', value_enc: encryptAccountSecret(big, 'synthetic-gh') }]);
  counts.account_tokens = await insert('kortix.account_tokens', { token_id: 'uuid', account_id: 'uuid', user_id: 'uuid', name: 'text', public_key: 'text', secret_key_hash: 'text' },
    [{ token_id: sid('token', big), account_id: big, user_id: owner(big), name: 'Shape CI token', public_key: `pk_shape_${big.slice(0, 8)}`, secret_key_hash: 'x'.repeat(64) }]);

  // An app with a static site on a project that moves.
  const appId = sid('app', big);
  const deploymentId = sid('deployment', big);
  const body = '<!doctype html><title>shape</title>';
  const sha = createHash('sha256').update(body).digest('hex');
  counts.apps = await insert('kortix.apps', { app_id: 'uuid', account_id: 'uuid', project_id: 'uuid', slug: 'text', name: 'text', route_key: 'text' },
    [{ app_id: appId, account_id: big, project_id: bigProjects[1]!, slug: 'shape-site', name: 'Shape site', route_key: `shape${big.slice(0, 6)}` }]);
  await insert('kortix.app_deployments', { deployment_id: 'uuid', app_id: 'uuid', version: 'int', source_kind: 'text', hosting_type: 'text', runtime_version: 'text', created_by: 'uuid' },
    [{ deployment_id: deploymentId, app_id: appId, version: 1, source_kind: 'static', hosting_type: 'static', runtime_version: 'synthetic', created_by: owner(big) }]);
  await insert('kortix.app_site_blobs', { account_id: 'uuid', sha256: 'text', size_bytes: 'bigint' }, [{ account_id: big, sha256: sha, size_bytes: body.length }]);
  await insert('kortix.app_site_files', { deployment_id: 'uuid', account_id: 'uuid', path: 'text', sha256: 'text', size_bytes: 'bigint', content_type: 'text' },
    [{ deployment_id: deploymentId, account_id: big, path: 'index.html', sha256: sha, size_bytes: body.length, content_type: 'text/html' }]);
  counts.site_blobs_uploaded = 0;
  if (!flag('no-storage')) {
    await supabaseSiteStorage.put(`${big}/${sha}`, new Blob([body]), 'text/html');
    counts.site_blobs_uploaded = 1;
  }

  // The paying legacy account: a completed purchase and a Stripe customer.
  const paying = accountIds.legacy(1);
  counts.credit_purchases = await insert('kortix.credit_purchases', { id: 'uuid', account_id: 'uuid', amount_dollars: 'numeric', status: 'text' },
    [{ id: sid('purchase', paying), account_id: paying, amount_dollars: 25, status: 'completed' }]);
  counts.billing_customers = await insert('kortix.billing_customers', { account_id: 'uuid', id: 'text' },
    [{ account_id: paying, id: `cus_shape${paying.slice(0, 8)}` }]);
  // Its plan: the paid Credits plan (each split-off gets it comped until the period ends).
  await db.execute(sql`UPDATE kortix.credit_accounts SET tier = 'credits', plan_monthly_usd = 100,
    billing_cycle_anchor = date_trunc('month', now()) WHERE account_id = ${paying}`);
  // A stale Stripe subscription id on Free: it pays nothing (C6), so it is not held.
  const stale = accountIds.legacy(2);
  await db.execute(sql`UPDATE kortix.credit_accounts SET tier = 'free', stripe_subscription_id = ${`sub_shape_stale_${stale.slice(0, 8)}`},
    stripe_subscription_status = 'canceled' WHERE account_id = ${stale}`);

  const summary = {
    scale: `1/${SCALE}`,
    split_pending_column: hasSplitPending,
    one_to_one_accounts: ONE,
    legacy_accounts: LEGACY,
    legacy_projects_active: LEGACY_SIZES.reduce((a, b) => a + b, 0),
    legacy_max_projects: Math.max(...LEGACY_SIZES),
    empty_accounts: EMPTY,
    multi_account_people: PEOPLE,
    rows: counts,
  };
  console.log(JSON.stringify(summary, null, 2));
}

try {
  await main();
  process.exit(0);
} catch (error) {
  // Drizzle wraps the database error; its cause names the constraint.
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : null;
  console.error(`seed failed: ${cause ?? (error instanceof Error ? error.message.slice(0, 300) : String(error))}`);
  process.exit(1);
}
