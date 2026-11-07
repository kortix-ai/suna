/**
 * The workspace read model (design.md §3.2 C1, C2).
 *
 * A workspace is one row of `kortix.workspaces`: one per project row (any
 * status) plus one project-less row (`workspace_id = account_id`) for an
 * account with no live project row. Release 1 derives the table by triggers
 * from `accounts`, `projects` and `account_deletion_requests`; nothing in code
 * writes it. Every read here answers from `kortix.workspaces_expected` (the
 * primary, the one implementation of the live-row rule) and compares the table
 * row in the same statement (the shadow, `shadow.ts`).
 *
 * Writes are not here. Settings are written by their dedicated routes
 * (`/v1/workspaces/:id/iam/*`, `/branding`, `/automations`), each of which owns
 * its audit row and cache invalidation; the name by the project PATCH
 * (`projects/lib/workspace-name.ts`). The lifecycle (close, restore, set up)
 * is `lifecycle.ts`; a person's deletion is `person-deletion.ts`.
 */
import type { AccountBrandingRecord } from '@kortix/db';
import { sql } from 'drizzle-orm';

import { db } from '../shared/db';
import { asWorkspaceAccountKey, asWorkspaceId, isUuid, type WorkspaceAccountKey, type WorkspaceId } from './ids';
import { reportShadow, type WorkspaceRowJson } from './shadow';

export type WorkspaceLifecycle = 'active' | 'dormant' | 'closing' | 'tombstone';
export type WorkspaceState = 'active' | 'setup_required' | 'deleting';

/** One live row of `kortix.workspaces` (never a tombstone). */
export interface WorkspaceRecord {
  workspaceId: WorkspaceId;
  /** `legacy_account_id`: the old account id, the billing and directory key. */
  accountId: WorkspaceAccountKey;
  /** = workspaceId when the workspace has its config repo (a project row), else null (before Set up). */
  projectId: WorkspaceId | null;
  lifecycle: Exclude<WorkspaceLifecycle, 'tombstone'>;
  splitPending: boolean;
  name: string;
  deletionScheduledFor: Date | null;
  // Config-repo columns (null on a project-less workspace).
  repoUrl: string | null;
  defaultBranch: string | null;
  manifestPath: string | null;
  secretDefaultStrategy: string | null;
  metadata: Record<string, unknown> | null;
  sandboxProviderGeneration: number | null;
  idempotencyKey: string | null;
  lastOpenedAt: Date | null;
  projectStatus: 'active' | 'archived' | null;
  // Settings columns (the account row).
  setupCompleteAt: Date | null;
  setupWizardStep: number;
  mfaRequired: boolean;
  sessionMaxLifetimeMinutes: number | null;
  sessionIdleTimeoutMinutes: number | null;
  patMaxLifetimeDays: number | null;
  patRequireExpiry: boolean;
  patIdleRevokeDays: number | null;
  adminsSeeAllSessions: boolean;
  automationsPausedAt: Date | null;
  automationsPausedBy: string | null;
  branding: AccountBrandingRecord;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkspaceCandidate {
  record: WorkspaceRecord;
  /** `kortix.account_is_paying(accountId)` (design.md §3.2 C6). */
  paying: boolean;
  /** The user's system account role, or null (a project grant only). */
  accountRole: 'owner' | 'admin' | 'member' | null;
}

const date = (v: unknown): Date | null => (v === null || v === undefined ? null : new Date(String(v)));
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** One `to_jsonb(kortix.workspaces)` row as a record. Pure: exported for tests. */
export function workspaceRecordFromJson(row: WorkspaceRowJson): WorkspaceRecord {
  return {
    workspaceId: asWorkspaceId(String(row.workspace_id)),
    accountId: asWorkspaceAccountKey(String(row.legacy_account_id)),
    projectId: row.project_id ? asWorkspaceId(String(row.project_id)) : null,
    lifecycle: String(row.lifecycle) as WorkspaceRecord['lifecycle'],
    splitPending: row.split_pending === true,
    name: String(row.name ?? ''),
    deletionScheduledFor: date(row.deletion_scheduled_for),
    repoUrl: str(row.repo_url),
    defaultBranch: str(row.default_branch),
    manifestPath: str(row.manifest_path),
    secretDefaultStrategy: str(row.secret_default_strategy),
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    sandboxProviderGeneration: num(row.sandbox_provider_generation),
    idempotencyKey: str(row.idempotency_key),
    lastOpenedAt: date(row.last_opened_at),
    projectStatus: (str(row.project_status) as WorkspaceRecord['projectStatus']) ?? null,
    setupCompleteAt: date(row.setup_complete_at),
    setupWizardStep: Number(row.setup_wizard_step ?? 0),
    mfaRequired: row.mfa_required === true,
    sessionMaxLifetimeMinutes: num(row.session_max_lifetime_minutes),
    sessionIdleTimeoutMinutes: num(row.session_idle_timeout_minutes),
    patMaxLifetimeDays: num(row.pat_max_lifetime_days),
    patRequireExpiry: row.pat_require_expiry === true,
    patIdleRevokeDays: num(row.pat_idle_revoke_days),
    adminsSeeAllSessions: row.admins_see_all_sessions === true,
    automationsPausedAt: date(row.automations_paused_at),
    automationsPausedBy: str(row.automations_paused_by),
    branding: (row.branding as AccountBrandingRecord | null) ?? {},
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}

/**
 * The API `state` of a record (C1), never stored. Pure. `null` = never served:
 * a dormant workspace that does not pay.
 */
export function workspaceState(record: WorkspaceRecord, paying: boolean): WorkspaceState | null {
  if (record.lifecycle === 'active') return 'active';
  if (record.lifecycle === 'closing') return 'deleting';
  if (record.lifecycle === 'dormant' && paying) return 'setup_required';
  return null;
}

interface LivePair {
  expected: WorkspaceRowJson | null;
  stored: WorkspaceRowJson | null;
}

/**
 * The live rows (never tombstones) of `accountIdsSql`'s accounts, expected and
 * stored side by side, in ONE statement. Reports every mismatch.
 * `accountIdsSql` is a subquery that yields one `id uuid` column.
 */
async function livePairs(accountIdsSql: ReturnType<typeof sql>): Promise<LivePair[]> {
  const rows = await db.execute<{ expected: WorkspaceRowJson | null; stored: WorkspaceRowJson | null }>(sql`
    WITH ids AS (${accountIdsSql}),
    e AS (
      SELECT x.workspace_id, to_jsonb(x) AS j
        FROM ids, LATERAL kortix.workspaces_expected(ids.id) x
       WHERE x.lifecycle <> 'tombstone'
    ),
    s AS (
      SELECT w.workspace_id, to_jsonb(w) AS j
        FROM kortix.workspaces w
       WHERE w.legacy_account_id IN (SELECT ids.id FROM ids) AND w.lifecycle <> 'tombstone'
    )
    SELECT e.j AS expected, s.j AS stored
      FROM e FULL JOIN s ON s.workspace_id = e.workspace_id`);
  for (const row of rows) reportShadow(row.expected, row.stored);
  return rows.map((row) => ({ expected: row.expected, stored: row.stored }));
}

/**
 * The live records (primary) of the accounts `accountIdsSql` yields (a
 * subquery with one `id uuid` column), shadow-checked. For the resolvers.
 */
export async function liveRecordsOf(accountIdsSql: ReturnType<typeof sql>): Promise<WorkspaceRecord[]> {
  const pairs = await livePairs(accountIdsSql);
  return pairs.flatMap((pair) => (pair.expected ? [workspaceRecordFromJson(pair.expected)] : []));
}

/** The account of a workspace id: its project row's account, or the account itself (a project-less workspace). */
const accountOfWorkspaceId = (id: string) => sql`
  SELECT p.account_id AS id FROM kortix.projects p WHERE p.project_id = ${id}::uuid
  UNION
  SELECT a.account_id FROM kortix.accounts a WHERE a.account_id = ${id}::uuid`;

/** The workspace, or `null` when `workspaceId` is no live workspace (unknown, a tombstone, a deleted account). */
export async function getWorkspace(workspaceId: string): Promise<WorkspaceRecord | null> {
  if (!isUuid(workspaceId)) return null;
  const id = workspaceId.toLowerCase();
  const pairs = await livePairs(accountOfWorkspaceId(id));
  const hit = pairs.find((pair) => pair.expected && String(pair.expected.workspace_id) === id);
  return hit?.expected ? workspaceRecordFromJson(hit.expected) : null;
}

/** Every live workspace of one account (several only while `split_pending`). */
export async function listAccountWorkspaces(accountId: string): Promise<WorkspaceRecord[]> {
  if (!isUuid(accountId)) return [];
  return liveRecordsOf(sql`SELECT ${accountId.toLowerCase()}::uuid AS id`);
}

/**
 * The live id of an account: its one live workspace when that is not
 * `split_pending`. `null` for an unknown or deleted account and for a
 * `split_pending` one (ambiguous). The same answer as the SQL
 * `kortix.workspace_id_of_account`, computed from the primary.
 */
export async function workspaceIdOfAccount(accountId: string): Promise<WorkspaceId | null> {
  const live = await listAccountWorkspaces(accountId);
  if (live.length !== 1 || live[0]!.splitPending) return null;
  return live[0]!.workspaceId;
}

/**
 * Every live row of every account where the user has a membership or a
 * direct grant, with the account's paying flag and the user's system account
 * role. One query. Unfiltered: the caller applies authorization
 * (`listAccessible`) and `workspaceState`.
 */
export async function listUserWorkspaceCandidates(userId: string): Promise<WorkspaceCandidate[]> {
  if (!isUuid(userId)) return [];
  const uid = userId.toLowerCase();
  const ids = sql`
    SELECT m.account_id AS id FROM kortix.account_memberships m WHERE m.user_id = ${uid}::uuid
    UNION
    SELECT ra.account_id FROM kortix.role_assignments ra
     WHERE ra.principal_type = 'user' AND ra.principal_id = ${uid}::uuid
       AND ra.account_id IS NOT NULL
       AND (ra.expires_at IS NULL OR ra.expires_at > now())`;
  const live = await liveRecordsOf(ids);
  if (live.length === 0) return [];
  const accountIds = [...new Set(live.map((record) => record.accountId))];
  const facts = await db.execute<{ account_id: string; paying: boolean; account_role: string | null }>(sql`
    SELECT a.id::text AS account_id,
           kortix.account_is_paying(a.id) AS paying,
           (SELECT m.account_role::text FROM kortix.account_members m
             WHERE m.account_id = a.id AND m.user_id = ${uid}::uuid LIMIT 1) AS account_role
      FROM (SELECT jsonb_array_elements_text(${JSON.stringify(accountIds)}::jsonb)::uuid AS id) a`);
  const byAccount = new Map(facts.map((row) => [row.account_id, row]));
  return live.map((record) => {
    const fact = byAccount.get(record.accountId);
    const role = fact?.account_role;
    return {
      record,
      paying: fact?.paying === true,
      accountRole: role === 'owner' || role === 'admin' || role === 'member' ? role : null,
    };
  });
}

/** `kortix.account_is_paying` (C6). The billing stream exports the public wrapper `isPayingAccount`. */
export async function accountIsPaying(accountId: string): Promise<boolean> {
  if (!isUuid(accountId)) return false;
  const [row] = await db.execute<{ paying: boolean }>(
    sql`SELECT kortix.account_is_paying(${accountId.toLowerCase()}::uuid) AS paying`,
  );
  return row?.paying === true;
}

/**
 * The raw facts the IAM engine reads per account (iam/workspace-facts.ts owns
 * the memo and the derivation): up to two of its active project rows with
 * their `split_pending` flag, and whether an account deletion request is open
 * (`pending` or `processing`, the `closing` lifecycle).
 */
export async function readAccountEngineFacts(
  accountId: string,
): Promise<{ activeProjects: Array<{ projectId: string; splitPending: boolean }>; deletionOpen: boolean }> {
  const [row] = await db.execute<{
    active_projects: Array<{ projectId: string; splitPending: boolean }> | null;
    deletion_open: boolean;
  }>(sql`
    SELECT
      COALESCE((
        SELECT json_agg(json_build_object('projectId', p.project_id, 'splitPending', p.split_pending))
        FROM (
          SELECT project_id, split_pending FROM kortix.projects
          WHERE account_id = ${accountId}::uuid AND status = 'active'
          LIMIT 2
        ) p
      ), '[]'::json) AS active_projects,
      EXISTS (
        SELECT 1 FROM kortix.account_deletion_requests r
        WHERE r.account_id = ${accountId}::uuid AND r.status IN ('pending', 'processing')
      ) AS deletion_open
  `);
  return { activeProjects: row?.active_projects ?? [], deletionOpen: row?.deletion_open === true };
}
