// V1 → V2 IAM migration.
//
// For each account, reads iam_policies + iam_roles and writes the
// equivalent V2 state into account_members.account_role, project_members,
// and project_group_grants. Then optionally flips accounts.iam_v2_enabled
// once validation confirms parity.
//
// Usage:
//   bun run src/scripts/migrate-iam-to-v2.ts [options]
//
// Options:
//   --account-id <uuid>   Limit to one account (default: every account)
//   --dry-run             Don't write — log what would change
//   --enable-flag         After successful migration + validation, flip
//                         accounts.iam_v2_enabled=true for that account
//   --verbose             Print every policy mapping decision
//
// Idempotent. Re-running is safe — upserts on conflict.

import { and, eq, isNull } from 'drizzle-orm';
import {
  accountGroupMembers,
  accountMembers,
  accounts,
  iamPolicies,
  iamRolePermissions,
  iamRoles,
  projectGroupGrants,
  projectGroupMembers,
  projectMembers,
  projects,
} from '@kortix/db';
import { db } from '../shared/db';
import { authorize as authorizeV1 } from '../iam/engine';
import { authorizeV2 } from '../iam/engine-v2';
import { invalidateIamV2Flag } from '../iam/dispatcher';
import {
  ACCOUNT_ROLE_PERMS,
  PROJECT_ROLE_PERMS,
  type AccountRole,
  type ProjectRole,
} from '../iam/role-perms';
import { ACCOUNT_ACTIONS, PROJECT_ACTIONS } from '../iam/actions';

// ─── Args ──────────────────────────────────────────────────────────────────

interface Args {
  accountId?: string;
  dryRun: boolean;
  enableFlag: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, enableFlag: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--account-id') args.accountId = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--enable-flag') args.enableFlag = true;
    else if (a === '--verbose') args.verbose = true;
    else if (a === '--help' || a === '-h') {
      // eslint-disable-next-line no-console
      console.log(
        'usage: migrate-iam-to-v2 [--account-id <uuid>] [--dry-run] [--enable-flag] [--verbose]',
      );
      process.exit(0);
    }
  }
  return args;
}

// ─── Logging ───────────────────────────────────────────────────────────────

const log = {
  info: (msg: string) => console.log(`[v2-migrate] ${msg}`),
  warn: (msg: string) => console.warn(`[v2-migrate] WARN  ${msg}`),
  err: (msg: string) => console.error(`[v2-migrate] ERROR ${msg}`),
};

// ─── Role mapping ──────────────────────────────────────────────────────────

/**
 * Pick the V2 account role that covers as much of a custom/legacy role's
 * action set as possible without granting extra dangerous actions.
 * Returns null when the role isn't account-scoped.
 */
function mapToAccountRole(
  roleKey: string | null,
  actions: ReadonlySet<string>,
): AccountRole | null {
  // Fast paths for system role keys.
  if (roleKey === 'super_administrator' || roleKey === 'administrator') return 'admin';
  if (
    roleKey === 'administrator_read_only' ||
    roleKey === 'member' ||
    roleKey === 'auditor' ||
    roleKey === 'billing_manager'
  )
    return 'member';

  // Heuristic for custom roles: pick the smallest role whose action set
  // is a superset of the custom role's. If none is a superset, pick the
  // smallest role whose action set has the most overlap.
  const candidates: AccountRole[] = ['member', 'admin', 'owner'];
  // Strict supersets (V2 grants ≥ everything V1 did)
  for (const r of candidates) {
    if (subsetOf(actions, ACCOUNT_ROLE_PERMS[r])) return r;
  }
  // Fall back to least-bad: highest coverage at the lowest tier.
  let best: { role: AccountRole; covered: number } = { role: 'member', covered: -1 };
  for (const r of candidates) {
    let covered = 0;
    for (const a of actions) if (ACCOUNT_ROLE_PERMS[r].has(a)) covered++;
    if (covered > best.covered) best = { role: r, covered };
  }
  return best.role;
}

function mapToProjectRole(
  roleKey: string | null,
  actions: ReadonlySet<string>,
): ProjectRole | null {
  if (roleKey === 'project_admin') return 'manager';
  if (roleKey === 'project_editor') return 'editor';
  if (roleKey === 'project_deployer') return 'editor'; // deployer's action set ⊂ editor
  if (roleKey === 'project_viewer') return 'viewer';

  const candidates: ProjectRole[] = ['viewer', 'editor', 'manager'];
  for (const r of candidates) {
    if (subsetOf(actions, PROJECT_ROLE_PERMS[r])) return r;
  }
  let best: { role: ProjectRole; covered: number } = { role: 'viewer', covered: -1 };
  for (const r of candidates) {
    let covered = 0;
    for (const a of actions) if (PROJECT_ROLE_PERMS[r].has(a)) covered++;
    if (covered > best.covered) best = { role: r, covered };
  }
  return best.role;
}

function subsetOf(
  small: ReadonlySet<string>,
  big: ReadonlySet<string>,
): boolean {
  for (const x of small) if (!big.has(x)) return false;
  return true;
}

function rankAccountRole(r: AccountRole): number {
  return r === 'owner' ? 3 : r === 'admin' ? 2 : 1;
}

function rankProjectRole(r: ProjectRole): number {
  return r === 'manager' ? 3 : r === 'editor' ? 2 : 1;
}

// ─── Loaders ───────────────────────────────────────────────────────────────

interface PolicyRow {
  policyId: string;
  principalType: 'member' | 'group' | 'token';
  principalId: string;
  scopeType: string;
  scopeId: string | null;
  effect: 'allow' | 'deny';
  conditions: unknown;
  expiresAt: Date | null;
  roleKey: string | null;
  roleActions: Set<string>;
}

async function loadAccountPolicies(accountId: string): Promise<PolicyRow[]> {
  const rows = await db
    .select({
      policyId: iamPolicies.policyId,
      principalType: iamPolicies.principalType,
      principalId: iamPolicies.principalId,
      scopeType: iamPolicies.scopeType,
      scopeId: iamPolicies.scopeId,
      effect: iamPolicies.effect,
      conditions: iamPolicies.conditions,
      expiresAt: iamPolicies.expiresAt,
      roleId: iamPolicies.roleId,
      roleKey: iamRoles.key,
    })
    .from(iamPolicies)
    .leftJoin(iamRoles, eq(iamRoles.roleId, iamPolicies.roleId))
    .where(eq(iamPolicies.accountId, accountId));

  // Bulk-load every action set referenced.
  const roleIds = Array.from(new Set(rows.map((r) => r.roleId)));
  const actionMap = new Map<string, Set<string>>();
  if (roleIds.length > 0) {
    const allActions = await db
      .select({
        roleId: iamRolePermissions.roleId,
        action: iamRolePermissions.action,
      })
      .from(iamRolePermissions);
    for (const a of allActions) {
      if (!actionMap.has(a.roleId)) actionMap.set(a.roleId, new Set());
      actionMap.get(a.roleId)!.add(a.action);
    }
  }

  return rows.map((r) => ({
    policyId: r.policyId,
    principalType: r.principalType as PolicyRow['principalType'],
    principalId: r.principalId,
    scopeType: r.scopeType,
    scopeId: r.scopeId,
    effect: r.effect as 'allow' | 'deny',
    conditions: r.conditions,
    expiresAt: r.expiresAt,
    roleKey: r.roleKey,
    roleActions: actionMap.get(r.roleId) ?? new Set(),
  }));
}

async function projectsInGroup(projectGroupId: string): Promise<string[]> {
  const rows = await db
    .select({ projectId: projectGroupMembers.projectId })
    .from(projectGroupMembers)
    .where(eq(projectGroupMembers.groupId, projectGroupId));
  return rows.map((r) => r.projectId);
}

async function groupMembers(groupId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: accountGroupMembers.userId })
    .from(accountGroupMembers)
    .where(eq(accountGroupMembers.groupId, groupId));
  return rows.map((r) => r.userId);
}

// ─── Writers (skip when dryRun) ────────────────────────────────────────────

async function upsertAccountRole(
  accountId: string,
  userId: string,
  role: AccountRole,
  dryRun: boolean,
): Promise<void> {
  // Only elevate, never demote — a user may have a higher role from another
  // policy mapping. Read current, compare, upsert if higher.
  const [existing] = await db
    .select({ accountRole: accountMembers.accountRole })
    .from(accountMembers)
    .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)))
    .limit(1);
  const current = (existing?.accountRole as AccountRole | undefined) ?? null;
  if (current && rankAccountRole(current) >= rankAccountRole(role)) return;
  log.info(
    `  account_role  user=${userId} ${current ?? '(none)'} → ${role}${dryRun ? ' [dry-run]' : ''}`,
  );
  if (dryRun) return;
  if (existing) {
    await db
      .update(accountMembers)
      .set({ accountRole: role })
      .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)));
  } else {
    // The user isn't a member yet — policy without membership is odd
    // but possible (orphaned). Don't materialise; just log.
    log.warn(
      `    skipped: user ${userId} has policy on account ${accountId} but no account_members row`,
    );
  }
}

async function upsertProjectMember(
  accountId: string,
  projectId: string,
  userId: string,
  role: ProjectRole,
  dryRun: boolean,
): Promise<void> {
  const [existing] = await db
    .select({ role: projectMembers.projectRole })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .limit(1);
  const current = (existing?.role as ProjectRole | undefined) ?? null;
  if (current && rankProjectRole(current) >= rankProjectRole(role)) return;
  log.info(
    `  project_member project=${projectId} user=${userId} ${current ?? '(none)'} → ${role}${dryRun ? ' [dry-run]' : ''}`,
  );
  if (dryRun) return;
  if (existing) {
    await db
      .update(projectMembers)
      .set({ projectRole: role, updatedAt: new Date() })
      .where(
        and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)),
      );
  } else {
    await db.insert(projectMembers).values({
      accountId,
      projectId,
      userId,
      projectRole: role,
    });
  }
}

async function upsertProjectGroupGrant(
  accountId: string,
  projectId: string,
  groupId: string,
  role: ProjectRole,
  dryRun: boolean,
): Promise<void> {
  const [existing] = await db
    .select({ role: projectGroupGrants.role })
    .from(projectGroupGrants)
    .where(
      and(eq(projectGroupGrants.projectId, projectId), eq(projectGroupGrants.groupId, groupId)),
    )
    .limit(1);
  const current = (existing?.role as ProjectRole | undefined) ?? null;
  if (current && rankProjectRole(current) >= rankProjectRole(role)) return;
  log.info(
    `  group_grant   project=${projectId} group=${groupId} ${current ?? '(none)'} → ${role}${dryRun ? ' [dry-run]' : ''}`,
  );
  if (dryRun) return;
  if (existing) {
    await db
      .update(projectGroupGrants)
      .set({ role, updatedAt: new Date() })
      .where(
        and(
          eq(projectGroupGrants.projectId, projectId),
          eq(projectGroupGrants.groupId, groupId),
        ),
      );
  } else {
    await db.insert(projectGroupGrants).values({
      accountId,
      projectId,
      groupId,
      role,
    });
  }
}

// ─── Per-account migration ────────────────────────────────────────────────

/**
 * Accumulator for one account: dedup grants in memory, then apply the
 * max-role per (target, principal) tuple once. Avoids writing N times
 * when the same group has several admin policies on the same project.
 */
type PendingGrants = {
  accountRoles: Map<string, AccountRole>;
  projectMembers: Map<string, { projectId: string; userId: string; role: ProjectRole }>;
  projectGroupGrants: Map<string, { projectId: string; groupId: string; role: ProjectRole }>;
};

function emptyPending(): PendingGrants {
  return {
    accountRoles: new Map(),
    projectMembers: new Map(),
    projectGroupGrants: new Map(),
  };
}

function pushAccountRole(p: PendingGrants, userId: string, role: AccountRole) {
  const cur = p.accountRoles.get(userId);
  if (!cur || rankAccountRole(role) > rankAccountRole(cur)) {
    p.accountRoles.set(userId, role);
  }
}

function pushProjectMember(p: PendingGrants, projectId: string, userId: string, role: ProjectRole) {
  const key = `${projectId}|${userId}`;
  const cur = p.projectMembers.get(key);
  if (!cur || rankProjectRole(role) > rankProjectRole(cur.role)) {
    p.projectMembers.set(key, { projectId, userId, role });
  }
}

function pushProjectGroupGrant(p: PendingGrants, projectId: string, groupId: string, role: ProjectRole) {
  const key = `${projectId}|${groupId}`;
  const cur = p.projectGroupGrants.get(key);
  if (!cur || rankProjectRole(role) > rankProjectRole(cur.role)) {
    p.projectGroupGrants.set(key, { projectId, groupId, role });
  }
}

async function migrateAccount(accountId: string, args: Args): Promise<{ skipped: number; errors: number }> {
  log.info(`account ${accountId}: loading policies...`);
  const policies = await loadAccountPolicies(accountId);
  log.info(`  ${policies.length} policy row(s) total`);

  const pending = emptyPending();
  let skipped = 0;
  let errors = 0;

  for (const p of policies) {
    // Skip policies we can't honour in V2.
    if (p.effect === 'deny') {
      log.warn(
        `  drop: deny policy ${p.policyId} (principal=${p.principalType}:${p.principalId} scope=${p.scopeType}:${p.scopeId ?? '*'}) — V2 has no deny`,
      );
      skipped++;
      continue;
    }
    if (p.expiresAt && p.expiresAt < new Date()) {
      if (args.verbose) log.info(`  skip: policy ${p.policyId} expired ${p.expiresAt.toISOString()}`);
      skipped++;
      continue;
    }
    if (p.conditions && Object.keys(p.conditions as object).length > 0) {
      log.warn(
        `  drop conditions: policy ${p.policyId} had ${Object.keys(p.conditions as object).join(',')} — V2 has no per-policy conditions`,
      );
      // Continue — write the grant without the condition; admin can re-add via account-wide MFA toggle if needed.
    }
    if (p.principalType === 'token') {
      if (args.verbose) log.info(`  skip: token policy ${p.policyId} — V2 PATs use project_id column`);
      skipped++;
      continue;
    }

    try {
      await stagePolicy(accountId, p, pending, args);
    } catch (err) {
      log.err(`  failed to stage policy ${p.policyId}: ${(err as Error).message}`);
      errors++;
    }
  }

  // Apply the deduped set in one pass.
  for (const [userId, role] of pending.accountRoles) {
    await upsertAccountRole(accountId, userId, role, args.dryRun);
  }
  for (const { projectId, userId, role } of pending.projectMembers.values()) {
    await upsertProjectMember(accountId, projectId, userId, role, args.dryRun);
  }
  for (const { projectId, groupId, role } of pending.projectGroupGrants.values()) {
    await upsertProjectGroupGrant(accountId, projectId, groupId, role, args.dryRun);
  }

  return { skipped, errors };
}

async function stagePolicy(
  _accountId: string,
  p: PolicyRow,
  pending: PendingGrants,
  args: Args,
): Promise<void> {
  // ── Account-scope policies ──
  if (p.scopeType === 'account') {
    const role = mapToAccountRole(p.roleKey, p.roleActions);
    if (!role) {
      log.warn(`  no account-role mapping for role=${p.roleKey ?? 'custom'} (policy ${p.policyId})`);
      return;
    }
    if (p.principalType === 'member') {
      pushAccountRole(pending, p.principalId, role);
    } else if (p.principalType === 'group') {
      // Elevate every group member to that account role (no group-level
      // account_role concept in V2). This is lossy — log it.
      const members = await groupMembers(p.principalId);
      if (args.verbose) {
        log.warn(
          `  group→account role expansion: group=${p.principalId} role=${role} affects ${members.length} user(s)`,
        );
      }
      for (const uid of members) pushAccountRole(pending, uid, role);
    }
    return;
  }

  // ── Project-scope policies ──
  if (p.scopeType === 'project') {
    const role = mapToProjectRole(p.roleKey, p.roleActions);
    if (!role || !p.scopeId) {
      log.warn(`  no project-role mapping for policy ${p.policyId}`);
      return;
    }
    if (p.principalType === 'member') {
      pushProjectMember(pending, p.scopeId, p.principalId, role);
    } else if (p.principalType === 'group') {
      pushProjectGroupGrant(pending, p.scopeId, p.principalId, role);
    }
    return;
  }

  // ── project_group-scope policies (fan out to per-project) ──
  if (p.scopeType === 'project_group') {
    const role = mapToProjectRole(p.roleKey, p.roleActions);
    if (!role || !p.scopeId) {
      log.warn(`  no project-role mapping for policy ${p.policyId} (project_group scope)`);
      return;
    }
    const projectIds = await projectsInGroup(p.scopeId);
    if (args.verbose) {
      log.info(`  fan-out: project_group=${p.scopeId} → ${projectIds.length} project(s) at ${role}`);
    }
    for (const pid of projectIds) {
      if (p.principalType === 'member') {
        pushProjectMember(pending, pid, p.principalId, role);
      } else if (p.principalType === 'group') {
        pushProjectGroupGrant(pending, pid, p.principalId, role);
      }
    }
    return;
  }

  // Sandbox/trigger/channel/member/group scopes — V2 collapses these into
  // project scope for sandboxes/triggers/channels, and has no policies on
  // member/group resources themselves. Log + skip.
  log.warn(
    `  drop: policy ${p.policyId} scope=${p.scopeType} — not modeled in V2`,
  );
}

// ─── Validation ────────────────────────────────────────────────────────────

/**
 * For every member of the account, verify that V2 allows at least every
 * (action, target) V1 allowed. Returns the number of diffs found.
 */
async function validateAccount(accountId: string): Promise<number> {
  const members = await db
    .select({ userId: accountMembers.userId })
    .from(accountMembers)
    .where(eq(accountMembers.accountId, accountId));

  const accountProjects = await db
    .select({ projectId: projects.projectId })
    .from(projects)
    .where(eq(projects.accountId, accountId));

  const projectIds = accountProjects.map((p) => p.projectId);
  const projectActionList = Object.values(PROJECT_ACTIONS);
  const accountActionList = Object.values(ACCOUNT_ACTIONS);

  let diffs = 0;
  for (const m of members) {
    // Account-level actions
    for (const action of accountActionList) {
      const v1 = await authorizeV1(m.userId, accountId, action);
      const v2 = await authorizeV2(m.userId, accountId, action);
      if (v1.allowed && !v2.allowed) {
        log.err(
          `  VALIDATION DIFF: user=${m.userId} action=${action} V1=allow V2=deny (${v2.reason})`,
        );
        diffs++;
      }
    }
    // Project-level actions
    for (const pid of projectIds) {
      for (const action of projectActionList) {
        const v1 = await authorizeV1(m.userId, accountId, action, {
          type: 'project',
          id: pid,
        });
        const v2 = await authorizeV2(m.userId, accountId, action, {
          type: 'project',
          id: pid,
        });
        if (v1.allowed && !v2.allowed) {
          log.err(
            `  VALIDATION DIFF: user=${m.userId} project=${pid} action=${action} V1=allow V2=deny (${v2.reason})`,
          );
          diffs++;
        }
      }
    }
  }
  return diffs;
}

// ─── Entry ─────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const accountIds = args.accountId
    ? [args.accountId]
    : (await db.select({ accountId: accounts.accountId }).from(accounts)).map(
        (a) => a.accountId,
      );

  log.info(`migrating ${accountIds.length} account(s)${args.dryRun ? ' (dry-run)' : ''}`);

  let totalDiffs = 0;
  for (const accountId of accountIds) {
    const { skipped, errors } = await migrateAccount(accountId, args);
    log.info(`account ${accountId}: ${skipped} skipped, ${errors} errors`);
    if (errors > 0) continue; // skip validation + flag-flip if write phase had errors

    log.info(`account ${accountId}: validating V1 ⊆ V2 ...`);
    const diffs = await validateAccount(accountId);
    totalDiffs += diffs;
    if (diffs > 0) {
      log.err(`account ${accountId}: ${diffs} validation diff(s) — NOT enabling V2 flag`);
      continue;
    }
    log.info(`account ${accountId}: validation passed (V2 allows ≥ V1)`);

    if (args.enableFlag && !args.dryRun) {
      await db
        .update(accounts)
        .set({ iamV2Enabled: true })
        .where(eq(accounts.accountId, accountId));
      invalidateIamV2Flag(accountId);
      log.info(`account ${accountId}: iam_v2_enabled = true`);
    }
  }

  log.info(`done. total validation diffs: ${totalDiffs}`);
  if (totalDiffs > 0) process.exit(1);
}

main().catch((err) => {
  log.err(err.stack ?? String(err));
  process.exit(1);
});
