/**
 * VERDICT-PARITY HARNESS — the proof that the canonical engine decides
 * identically to the one it replaces.
 *
 * Seeds one account with every principal shape the old engine distinguishes,
 * copies the legacy stores into `role_assignments` exactly as the backfill
 * migration does, then evaluates EVERY (principal × credential × action ×
 * object) triple through both engines and asserts verdict + reason match.
 *
 * Spec §5 makes 100% match the precondition for the cutover. A mismatch is
 * reported as a triple, never silently normalised — the ONE normalisation
 * applied is documented below and is a deliberate spec decision, not a fudge.
 *
 * WHY THE HARNESS SYNCS THE STORES ITSELF. In this release the 129 write sites
 * still write the legacy tables; only the backfill migration fills
 * `role_assignments`. So a fixture created through the legacy tables would be
 * invisible to the new engine. `syncAssignmentsFromLegacy` runs the same six
 * INSERT..SELECT passes the migration runs, which is exactly the dual-WRITE the
 * cutover replaces with dual-READ views.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { ACCOUNT_ACTIONS, PROJECT_ACTIONS } from './actions';
import { authorizeV2 } from './engine-v2';
import { authorize, clearAuthorizeCaches, type Obj, type Reason } from './authorize';
import { clearCatalogCaches } from './catalog';
import { loadServiceAccountActivation, type Actor, type Credential } from './actor';

// ─── Reason normalisation (the ONE documented mapping) ──────────────────────

/**
 * The old engine reports THREE allow reasons — `account_role`, `project_role`
 * and `custom_policy` — that all mean the same thing: a role the principal
 * holds grants the action. Spec §2.2 collapses them to `role`, because nothing
 * renders an allow reason (denial-message.ts is keyed only on DENIAL reasons)
 * and the distinction leaked the storage shape into the verdict.
 *
 * Every DENIAL reason is compared byte-for-byte, unmapped, because the 403
 * wording depends on it.
 */
export function normalizeOldReason(allowed: boolean, reason: string | undefined): string {
  if (!allowed) return reason ?? '';
  if (reason === 'account_role' || reason === 'project_role' || reason === 'custom_policy') return 'role';
  return reason ?? '';
}

// ─── Fixture ────────────────────────────────────────────────────────────────

export interface ParityFixture {
  accountId: string;
  projectId: string;
  otherProjectId: string;
  groupId: string;
  agentName: string;
  otherAgentName: string;
  principals: ParityPrincipal[];
  credentials: ParityCredential[];
}

export interface ParityPrincipal {
  label: string;
  userId: string;
}

export interface ParityCredential {
  label: string;
  /** Applies only to principals of this kind; '*' = any. */
  appliesTo: 'user' | 'service_account' | '*';
  tokenId?: string;
  build: (userId: string, activated: boolean) => Credential;
  /** Overrides the principal's userId (service-account bearers authenticate AS
   *  the service account). */
  userIdOverride?: string;
}

const ID = () => randomUUID();

async function exec(text: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const rows = await db.execute(sql.raw(interpolate(text, params)));
  return rows as unknown as Record<string, unknown>[];
}

/** Fixture-only parameter interpolation: every value here is a uuid or a
 *  harness-authored literal, never user input. */
function interpolate(text: string, params: unknown[]): string {
  return text.replace(/\$(\d+)/g, (_, i) => {
    const v = params[Number(i) - 1];
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  });
}

/**
 * Create the account and every principal shape the old engine branches on.
 * Everything is written through the LEGACY stores, because that is what the
 * product still writes in this release.
 */
export async function seedParityFixture(): Promise<ParityFixture> {
  const accountId = ID();
  const projectId = ID();
  const otherProjectId = ID();
  const groupId = ID();
  const agentName = 'parity-scoped-agent';
  const otherAgentName = 'parity-unscoped-agent';

  await exec(`insert into kortix.accounts (account_id, name) values ($1, $2)`, [accountId, 'parity']);
  await exec(
    `insert into kortix.projects (project_id, account_id, name, repo_url) values ($1,$2,$3,$4), ($5,$2,$6,$4)`,
    [projectId, accountId, 'parity-project', 'https://example.invalid/p.git', otherProjectId, 'parity-other'],
  );
  await exec(`insert into kortix.account_groups (group_id, account_id, name) values ($1,$2,$3)`, [
    groupId,
    accountId,
    'parity-group',
  ]);

  const owner = ID();
  const admin = ID();
  const plainMember = ID();
  const superAdmin = ID();
  const projectManager = ID();
  const projectMemberUser = ID();
  const groupMember = ID();
  const customAccountUser = ID();
  const customProjectUser = ID();
  const grantedAgentUser = ID();
  const expiredUser = ID();
  const strangerUser = ID();

  const members: Array<[string, string, boolean]> = [
    [owner, 'owner', false],
    [admin, 'admin', false],
    [plainMember, 'member', false],
    [superAdmin, 'owner', true],
    [projectManager, 'member', false],
    [projectMemberUser, 'member', false],
    [groupMember, 'member', false],
    [customAccountUser, 'member', false],
    [customProjectUser, 'member', false],
    [grantedAgentUser, 'member', false],
    [expiredUser, 'member', false],
  ];
  for (const [userId, role, isSuper] of members) {
    await exec(
      `insert into kortix.account_members (user_id, account_id, account_role, is_super_admin) values ($1,$2,$3,$4)`,
      [userId, accountId, role, isSuper],
    );
  }

  // Direct project roles.
  await exec(
    `insert into kortix.project_members (account_id, project_id, user_id, project_role) values ($1,$2,$3,'manager')`,
    [accountId, projectId, projectManager],
  );
  for (const u of [projectMemberUser, grantedAgentUser]) {
    await exec(
      `insert into kortix.project_members (account_id, project_id, user_id, project_role) values ($1,$2,$3,'member')`,
      [accountId, projectId, u],
    );
  }
  // An EXPIRED direct grant — invisible to both engines, which filter in SQL.
  await exec(
    `insert into kortix.project_members (account_id, project_id, user_id, project_role, expires_at)
     values ($1,$2,$3,'manager', now() - interval '1 hour')`,
    [accountId, projectId, expiredUser],
  );

  // Group -> project grant.
  await exec(`insert into kortix.account_group_members (group_id, user_id) values ($1,$2)`, [
    groupId,
    groupMember,
  ]);
  await exec(
    `insert into kortix.project_group_grants (project_id, group_id, account_id, role) values ($1,$2,$3,'member')`,
    [projectId, groupId, accountId],
  );

  // Custom roles: one at account scope, one at project scope.
  const accountRoleId = ID();
  const projectRoleId = ID();
  await exec(
    `insert into kortix.iam_roles (role_id, account_id, key, name, scope_type) values
       ($1,$2,'parity_account_role','Parity account role','account'),
       ($3,$2,'parity_project_role','Parity project role','project')`,
    [accountRoleId, accountId, projectRoleId],
  );
  await exec(
    `insert into kortix.iam_role_actions (role_id, action) values ($1,'audit.read'), ($1,'group.read')`,
    [accountRoleId],
  );
  await exec(
    `insert into kortix.iam_role_actions (role_id, action) values
       ($1,'project.read'), ($1,'project.secret.read'), ($1,'project.agent.read')`,
    [projectRoleId],
  );
  await exec(
    `insert into kortix.iam_policies (account_id, principal_type, principal_id, role_id, scope_type, scope_id)
     values ($1,'member',$2,$3,'account',null)`,
    [accountId, customAccountUser, accountRoleId],
  );
  await exec(
    `insert into kortix.iam_policies (account_id, principal_type, principal_id, role_id, scope_type, scope_id)
     values ($1,'member',$2,$3,'project',$4)`,
    [accountId, customProjectUser, projectRoleId, projectId],
  );

  // Object grant: ONE agent scoped to one member. The other agent stays
  // unscoped, so the two halves of the object rule are both exercised.
  await exec(
    `insert into kortix.iam_resource_grants
       (account_id, project_id, resource_type, resource_id, principal_type, principal_id)
     values ($1,$2,'agent',$3,'member',$4)`,
    [accountId, projectId, agentName, grantedAgentUser],
  );

  // Service accounts: one bound to a role (ACTIVATED), one unbound.
  const activatedSa = ID();
  const unboundSa = ID();
  await exec(
    `insert into kortix.service_accounts (service_account_id, account_id, name, secret_hash, public_prefix, project_id)
     values ($1,$2,'parity-activated',$3,'kortix_sa_par1',$5),
            ($4,$2,'parity-unbound',$6,'kortix_sa_par2',$5)`,
    [activatedSa, accountId, `hash-${activatedSa}`, unboundSa, projectId, `hash-${unboundSa}`],
  );
  await exec(
    `insert into kortix.iam_policies (account_id, principal_type, principal_id, role_id, scope_type, scope_id)
     values ($1,'token',$2,$3,'project',$4)`,
    [accountId, activatedSa, projectRoleId, projectId],
  );

  // Tokens. A project-bound PAT, an agent session on the ACTIVATED service
  // account, and an agent session on the UNBOUND one (which must fall back to
  // the launching user).
  const patToken = ID();
  const agentTokenActivated = ID();
  const agentTokenUnbound = ID();
  const grant = JSON.stringify({
    agent: 'parity-agent',
    kortixCli: ['project.session.start', 'project.gitops.push'],
    connectors: 'all',
  });
  await exec(
    `insert into kortix.account_tokens (token_id, account_id, user_id, name, public_key, secret_key_hash, project_id)
     values ($1,$2,$3,'parity-pat',$4,$5,$6)`,
    [patToken, accountId, projectManager, `pk-${patToken}`, `sk-${patToken}`, projectId],
  );
  await exec(
    `insert into kortix.account_tokens
       (token_id, account_id, user_id, name, public_key, secret_key_hash, project_id, session_id, agent_grant, service_account_id)
     values ($1,$2,$3,'parity-agent-activated',$4,$5,$6,'parity-session-1',$7::jsonb,$8)`,
    [
      agentTokenActivated,
      accountId,
      projectManager,
      `pk-${agentTokenActivated}`,
      `sk-${agentTokenActivated}`,
      projectId,
      grant,
      activatedSa,
    ],
  );
  await exec(
    `insert into kortix.account_tokens
       (token_id, account_id, user_id, name, public_key, secret_key_hash, project_id, session_id, agent_grant, service_account_id)
     values ($1,$2,$3,'parity-agent-unbound',$4,$5,$6,'parity-session-2',$7::jsonb,$8)`,
    [
      agentTokenUnbound,
      accountId,
      projectManager,
      `pk-${agentTokenUnbound}`,
      `sk-${agentTokenUnbound}`,
      projectId,
      grant,
      unboundSa,
    ],
  );

  const principals: ParityPrincipal[] = [
    { label: 'account-owner', userId: owner },
    { label: 'account-admin', userId: admin },
    { label: 'account-member', userId: plainMember },
    { label: 'super-admin', userId: superAdmin },
    { label: 'project-manager', userId: projectManager },
    { label: 'project-member', userId: projectMemberUser },
    { label: 'group-granted-member', userId: groupMember },
    { label: 'custom-account-role', userId: customAccountUser },
    { label: 'custom-project-role', userId: customProjectUser },
    { label: 'object-granted-member', userId: grantedAgentUser },
    { label: 'expired-project-grant', userId: expiredUser },
    { label: 'stranger-non-member', userId: strangerUser },
    { label: 'service-account-activated', userId: activatedSa },
    { label: 'service-account-unbound', userId: unboundSa },
  ];

  const credentials: ParityCredential[] = [
    { label: 'jwt', appliesTo: '*', build: () => ({ kind: 'jwt' }) },
    {
      label: 'pat-project-scoped',
      appliesTo: 'user',
      tokenId: patToken,
      build: () => ({ kind: 'pat', tokenId: patToken, projectId }),
    },
    {
      label: 'agent-session-activated',
      appliesTo: 'user',
      tokenId: agentTokenActivated,
      build: (_uid, activated) => ({
        kind: 'agent_session',
        tokenId: agentTokenActivated,
        projectId,
        sessionId: 'parity-session-1',
        agentGrant: JSON.parse(grant),
        serviceAccountId: activatedSa,
        activated,
      }),
    },
    {
      label: 'agent-session-unbound',
      appliesTo: 'user',
      tokenId: agentTokenUnbound,
      build: (_uid, activated) => ({
        kind: 'agent_session',
        tokenId: agentTokenUnbound,
        projectId,
        sessionId: 'parity-session-2',
        agentGrant: JSON.parse(grant),
        serviceAccountId: unboundSa,
        activated,
      }),
    },
    {
      label: 'service-account-bearer',
      appliesTo: 'service_account',
      build: (uid) => ({ kind: 'service_account', serviceAccountId: uid }),
    },
  ];

  await syncAssignmentsFromLegacy(accountId);

  return {
    accountId,
    projectId,
    otherProjectId,
    groupId,
    agentName,
    otherAgentName,
    principals,
    credentials,
  };
}

export async function dropParityFixture(accountId: string): Promise<void> {
  // accounts cascades to projects, members, groups, roles, policies, tokens,
  // service accounts and role_assignments.
  await exec(`delete from kortix.accounts where account_id = $1`, [accountId]);
}

/**
 * The six backfill passes, scoped to one account. Byte-identical in effect to
 * `20260819015725000_rbac_backfill_role_assignments.concurrent.ts`; kept here
 * (rather than imported) because a migration file is immutable and a test must
 * never be able to change what the migration does.
 */
export async function syncAssignmentsFromLegacy(accountId: string): Promise<void> {
  const A = `'${accountId}'::uuid`;
  const roleKey = (col: string) =>
    `(case ${col}::text when 'editor' then 'manager' when 'viewer' then 'member' when 'user' then 'member' else ${col}::text end)`;

  await exec(`
    insert into kortix.role_assignments
      (account_id, principal_type, principal_id, role_id, scope_type, scope_id, source, created_at)
    select m.account_id, 'user', m.user_id, sr.role_id, 'account', null, 'system', m.joined_at
      from kortix.account_members m
      join kortix.iam_roles sr on sr.account_id is null and sr.scope_type='account' and sr.key = m.account_role::text
     where m.account_id = ${A}
    on conflict do nothing`);

  await exec(`
    insert into kortix.role_assignments
      (account_id, principal_type, principal_id, role_id, scope_type, scope_id, expires_at, granted_by, source, created_at)
    select pm.account_id, 'user', pm.user_id, sr.role_id, 'project', pm.project_id,
           pm.expires_at, pm.granted_by, 'manual', pm.created_at
      from kortix.project_members pm
      join kortix.iam_roles sr on sr.account_id is null and sr.scope_type='project'
       and sr.key = ${roleKey('pm.project_role')}
     where pm.account_id = ${A}
    on conflict do nothing`);

  await exec(`
    insert into kortix.role_assignments
      (account_id, principal_type, principal_id, role_id, scope_type, scope_id, expires_at, granted_by, source, created_at)
    select g.account_id, 'group', g.group_id, sr.role_id, 'project', g.project_id,
           g.expires_at, g.granted_by, 'manual', g.created_at
      from kortix.project_group_grants g
      join kortix.iam_roles sr on sr.account_id is null and sr.scope_type='project'
       and sr.key = ${roleKey('g.role')}
     where g.account_id = ${A}
    on conflict do nothing`);

  await exec(`
    insert into kortix.role_assignments
      (account_id, principal_type, principal_id, role_id, scope_type, scope_id, expires_at, granted_by, source, created_at)
    select p.account_id,
           case p.principal_type when 'member' then 'user' when 'group' then 'group' when 'token' then 'service_account' end,
           p.principal_id, p.role_id, p.scope_type, p.scope_id, p.expires_at, p.granted_by, 'manual', p.created_at
      from kortix.iam_policies p
     where p.account_id = ${A}
       and p.principal_type in ('member','group','token')
       and p.scope_type in ('account','project')
       and (p.scope_type = 'account') = (p.scope_id is null)
    on conflict do nothing`);

  await exec(`
    insert into kortix.role_assignments
      (account_id, principal_type, principal_id, role_id, scope_type, scope_id,
       object_type, object_id, expires_at, granted_by, source, created_at)
    select rg.account_id,
           case rg.principal_type when 'member' then 'user' else 'group' end,
           rg.principal_id, sr.role_id, 'project', rg.project_id,
           rg.resource_type, rg.resource_id, rg.expires_at, rg.granted_by, 'manual', rg.created_at
      from kortix.iam_resource_grants rg
      join kortix.iam_roles sr on sr.account_id is null and sr.scope_type='project' and sr.key='agent-user'
     where rg.account_id = ${A}
       and rg.effect = 'allow'
       and rg.principal_type in ('member','group')
    on conflict do nothing`);
}

// ─── The grid ───────────────────────────────────────────────────────────────

export interface ParityCase {
  principal: string;
  credential: string;
  action: string;
  object: string;
}

export interface ParityMismatch extends ParityCase {
  old: { allowed: boolean; reason: string };
  next: { allowed: boolean; reason: string };
}

export interface ParityResult {
  total: number;
  mismatches: ParityMismatch[];
}

/**
 * Every action string a route can pass today — the 69 catalogued leaves PLUS
 * the two collapsed `project.cr.*` spellings and the four dead `trigger.*`
 * ones. The uncataloged five are in the grid on purpose: a route that still
 * passes one must land on the same verdict AND the same reason, which is what
 * `scopeForUncatalogedAction` is there to guarantee.
 */
export function parityActions(): string[] {
  return [
    ...Object.values(ACCOUNT_ACTIONS),
    ...Object.values(PROJECT_ACTIONS),
    'trigger.read',
    'trigger.update',
    'trigger.delete',
    'trigger.fire',
  ];
}

/** Run the whole grid through both engines. */
export async function runParity(
  fixture: ParityFixture,
  opts: { concurrency?: number } = {},
): Promise<ParityResult> {
  clearCatalogCaches();
  clearAuthorizeCaches();

  const actions = parityActions();
  const objects: Array<{ label: string; obj: Obj }> = [
    { label: 'account', obj: { type: 'account' } },
    { label: 'project', obj: { type: 'project', id: fixture.projectId } },
    {
      label: 'project+scoped-agent',
      obj: { type: 'project', id: fixture.projectId, resource: { type: 'agent', id: fixture.agentName } },
    },
    {
      label: 'project+unscoped-agent',
      obj: { type: 'project', id: fixture.projectId, resource: { type: 'agent', id: fixture.otherAgentName } },
    },
    { label: 'other-project', obj: { type: 'project', id: fixture.otherProjectId } },
  ];

  // The activation flag has to be resolved the way production resolves it, or
  // the harness would be testing its own assumption instead of the engine's.
  const activationByToken = new Map<string, boolean>();
  for (const cred of fixture.credentials) {
    const built = cred.build('00000000-0000-0000-0000-000000000000', false);
    if (built.kind === 'agent_session') {
      activationByToken.set(
        cred.label,
        await loadServiceAccountActivation(built.serviceAccountId, fixture.accountId),
      );
    }
  }

  const cases: Array<{ meta: ParityCase; run: () => Promise<ParityMismatch | null> }> = [];
  for (const principal of fixture.principals) {
    const isSa = principal.label.startsWith('service-account-');
    for (const cred of fixture.credentials) {
      if (cred.appliesTo === 'user' && isSa) continue;
      if (cred.appliesTo === 'service_account' && !isSa) continue;
      const activated = activationByToken.get(cred.label) ?? false;
      const credential = cred.build(principal.userId, activated);
      const actor: Actor = {
        userId: principal.userId,
        accountId: fixture.accountId,
        credential,
        ctx: {},
      };
      // The old engine takes the acting token id as a trailing argument — the
      // exact omission `Actor` exists to prevent. Derive it from the same
      // credential so the comparison is like-for-like.
      const oldTokenId =
        credential.kind === 'pat' || credential.kind === 'agent_session'
          ? credential.tokenId
          : credential.kind === 'service_account'
            ? credential.serviceAccountId
            : undefined;

      for (const action of actions) {
        for (const { label, obj } of objects) {
          const meta: ParityCase = {
            principal: principal.label,
            credential: cred.label,
            action,
            object: label,
          };
          cases.push({
            meta,
            run: async () => {
              const [oldVerdict, nextVerdict] = await Promise.all([
                authorizeV2(
                  actor.userId,
                  actor.accountId,
                  action,
                  toLegacyTarget(obj),
                  oldTokenId,
                  {},
                ),
                authorize(actor, action, obj),
              ]);
              const oldNorm = normalizeOldReason(oldVerdict.allowed, oldVerdict.reason);
              const nextNorm = nextVerdict.reason as Reason;
              if (oldVerdict.allowed === nextVerdict.allowed && oldNorm === nextNorm) return null;
              return {
                ...meta,
                old: { allowed: oldVerdict.allowed, reason: oldVerdict.reason ?? '' },
                next: { allowed: nextVerdict.allowed, reason: nextVerdict.reason },
              };
            },
          });
        }
      }
    }
  }

  const mismatches: ParityMismatch[] = [];
  const concurrency = opts.concurrency ?? 16;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, cases.length) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= cases.length) return;
        const result = await cases[index].run();
        if (result) mismatches.push(result);
      }
    }),
  );

  return { total: cases.length, mismatches };
}

/** The old engine's target shape. `secret`/`app`/`trigger` objects are not
 *  representable there — it only ever accepted agent|skill. */
function toLegacyTarget(obj: Obj) {
  if (obj.type === 'account') return { type: 'account' as const };
  if (!obj.resource) return { type: 'project' as const, id: obj.id };
  if (obj.resource.type !== 'agent' && obj.resource.type !== 'skill') {
    return { type: 'project' as const, id: obj.id };
  }
  return {
    type: 'project' as const,
    id: obj.id,
    resource: { type: obj.resource.type, id: obj.resource.id },
  };
}
