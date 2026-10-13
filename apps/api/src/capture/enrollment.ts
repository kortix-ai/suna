/**
 * IT rollout: enrollment tokens and the computers that present them. The data
 * side of enrollment-routes.ts.
 *
 * IT installs Kortix Capture with one enrollment token. At each Windows
 * sign-in the machine service calls `POST /v1/capture/device/enroll` with the
 * token, the machine key and the Windows person (UPN, else the login name).
 * Kortix matches the person to an account member by trusted email, else by an
 * earlier admin decision for the same person, and mints a device token. A
 * computer whose person is not matched, or every computer of a token that
 * requires approval, waits in `capture_enrollments` as `pending` until an
 * admin approves it to a member or denies it. The device polls by calling
 * enroll again. A token is stored only as `hashSecretKey(token)`.
 */
import { accounts, captureDevices, captureEnrollments, captureEnrollmentTokens } from '@kortix/db';
import { and, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { lookupEmailsByUserIds } from '../accounts/core/owner-emails';
import { emailTrustedSql } from '../iam/email-trust';
import { userIdByEmailRows } from '../iam/membership-read';
import { hashSecretKey, randomAlphanumeric } from '../shared/crypto';
import { db } from '../shared/db';
import { DEVICE_TOKEN_PREFIX } from './devices';
import { accountPrefix, deviceFields } from './format';
import { ensurePolicyObject } from './policy';
import { captureEnabled, isAccountMember } from './workspace';

export const ENROLLMENT_TOKEN_PREFIX = 'kortix_enr_';
/** How long a pending computer waits between two enroll calls. */
export const ENROLL_RETRY_S = 60;

export type EnrollmentToken = typeof captureEnrollmentTokens.$inferSelect;
export type Enrollment = typeof captureEnrollments.$inferSelect;

const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Lower-case, de-duplicated email domains; `@corp.example` and `corp.example` are one. Null: one is not a domain. */
export function normalizeDomains(raw: readonly string[]): string[] | null {
  const domains = [...new Set(raw.map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean))];
  return domains.every((d) => DOMAIN.test(d)) ? domains : null;
}

/** The Windows person as one lower-case key: the UPN, else the login name. */
export function principalOf(user: { principal_name?: string | null; account_name?: string | null }): string {
  return (user.principal_name?.trim() || user.account_name?.trim() || '').toLowerCase().slice(0, 320);
}

/** The domain of an email-shaped principal, else null. */
export function emailDomain(principal: string): string | null {
  const at = principal.lastIndexOf('@');
  return at > 0 && at < principal.length - 1 && !principal.includes('\\') ? principal.slice(at + 1) : null;
}

// ─── Tokens (admin) ──────────────────────────────────────────────────────────

export interface TokenInput {
  name: string;
  emailDomains: string[];
  maxDevices: number | null;
  requireApproval: boolean;
  expiresAt: Date | null;
}

export async function createEnrollmentToken(accountId: string, input: TokenInput, createdBy: string) {
  const token = `${ENROLLMENT_TOKEN_PREFIX}${randomAlphanumeric(40)}`;
  const [row] = await db
    .insert(captureEnrollmentTokens)
    .values({
      accountId,
      name: input.name,
      tokenHash: hashSecretKey(token),
      tokenPrefix: token.slice(0, ENROLLMENT_TOKEN_PREFIX.length + 4),
      emailDomains: input.emailDomains,
      maxDevices: input.maxDevices,
      requireApproval: input.requireApproval,
      expiresAt: input.expiresAt,
      createdBy,
    })
    .returning();
  return { row: row!, token };
}

/** Computers per token: one per machine, a denied one not counted. */
async function deviceCounts(tokenIds: string[]): Promise<Map<string, number>> {
  if (tokenIds.length === 0) return new Map();
  const rows = await db
    .select({ tokenId: captureEnrollments.tokenId, n: sql<number>`count(distinct ${captureEnrollments.machineKeySha256})::int` })
    .from(captureEnrollments)
    .where(and(inArray(captureEnrollments.tokenId, tokenIds), ne(captureEnrollments.status, 'denied')))
    .groupBy(captureEnrollments.tokenId);
  return new Map(rows.map((r) => [r.tokenId, r.n]));
}

export function tokenState(row: EnrollmentToken, now = Date.now()): 'active' | 'revoked' | 'expired' {
  if (row.revokedAt) return 'revoked';
  return row.expiresAt && row.expiresAt.getTime() <= now ? 'expired' : 'active';
}

export function tokenView(row: EnrollmentToken, deviceCount: number) {
  return {
    token_id: row.tokenId,
    name: row.name,
    token_prefix: row.tokenPrefix,
    state: tokenState(row),
    email_domains: row.emailDomains,
    max_devices: row.maxDevices,
    device_count: deviceCount,
    require_approval: row.requireApproval,
    expires_at: row.expiresAt?.toISOString() ?? null,
    revoked_at: row.revokedAt?.toISOString() ?? null,
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
  };
}

export async function listEnrollmentTokens(accountId: string) {
  const rows = await db
    .select()
    .from(captureEnrollmentTokens)
    .where(eq(captureEnrollmentTokens.accountId, accountId))
    .orderBy(desc(captureEnrollmentTokens.createdAt));
  const counts = await deviceCounts(rows.map((r) => r.tokenId));
  return rows.map((row) => tokenView(row, counts.get(row.tokenId) ?? 0));
}

export async function tokenViewById(tokenId: string) {
  const [row] = await db.select().from(captureEnrollmentTokens).where(eq(captureEnrollmentTokens.tokenId, tokenId)).limit(1);
  return row ? tokenView(row, (await deviceCounts([tokenId])).get(tokenId) ?? 0) : null;
}

/** Revoke a token of the account. Computers it enrolled keep recording; new ones are refused. Null: no such token. */
export async function revokeEnrollmentToken(accountId: string, tokenId: string, by: string) {
  const [row] = await db
    .update(captureEnrollmentTokens)
    .set({ revokedAt: sql`coalesce(${captureEnrollmentTokens.revokedAt}, now())`, revokedBy: sql`coalesce(${captureEnrollmentTokens.revokedBy}, ${by}::uuid)` })
    .where(and(eq(captureEnrollmentTokens.tokenId, tokenId), eq(captureEnrollmentTokens.accountId, accountId)))
    .returning();
  return row ? tokenViewById(row.tokenId) : null;
}

// ─── Enroll (device) ─────────────────────────────────────────────────────────

export interface EnrollInput {
  token: string;
  machineKey: string;
  principalName: string | null;
  accountName: string | null;
  deviceInfo: Record<string, string>;
}

export type EnrollOutcome =
  | { kind: 'invalid_token' | 'capture_disabled' | 'bad_principal' }
  | { kind: 'domain_not_allowed' | 'limit_reached'; tokenId: string; accountId: string }
  | { kind: 'denied'; tokenId: string; accountId: string; enrollmentId: string }
  | { kind: 'pending'; reason: 'no_member' | 'approval_required'; tokenId: string; accountId: string; enrollmentId: string }
  | {
      kind: 'enrolled';
      tokenId: string;
      accountId: string;
      enrollmentId: string;
      token: string;
      prefix: string;
      deviceId: string;
      userId: string;
      accountName: string;
      memberEmail: string | null;
    };

async function tokenRow(token: string): Promise<EnrollmentToken | null> {
  if (!token.startsWith(ENROLLMENT_TOKEN_PREFIX)) return null;
  const [row] = await db.select().from(captureEnrollmentTokens).where(eq(captureEnrollmentTokens.tokenHash, hashSecretKey(token))).limit(1);
  return row ?? null;
}

/** The account member a trusted email names, or null. */
async function memberByEmail(accountId: string, email: string): Promise<string | null> {
  const rows = await userIdByEmailRows(email, accountId, emailTrustedSql(sql`u`, accountId));
  const userId = (rows[0] as { id: string } | undefined)?.id ?? null;
  return userId && (await isAccountMember(accountId, userId)) ? userId : null;
}

/** The member an admin approved this person to before, on any computer. */
async function memberByDecision(accountId: string, principal: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: captureEnrollments.userId })
    .from(captureEnrollments)
    .where(
      and(
        eq(captureEnrollments.accountId, accountId),
        eq(captureEnrollments.principal, principal),
        isNotNull(captureEnrollments.decidedBy),
        isNotNull(captureEnrollments.userId),
        inArray(captureEnrollments.status, ['approved', 'enrolled']),
      ),
    )
    .orderBy(desc(captureEnrollments.decidedAt))
    .limit(1);
  return row?.userId && (await isAccountMember(accountId, row.userId)) ? row.userId : null;
}

/** Record that this computer + person asked, and return its row (the poll state). */
async function upsertEnrollment(token: EnrollmentToken, input: EnrollInput, principal: string): Promise<Enrollment> {
  const [row] = await db
    .insert(captureEnrollments)
    .values({
      accountId: token.accountId,
      tokenId: token.tokenId,
      machineKeySha256: input.machineKey,
      principal,
      principalName: input.principalName,
      accountName: input.accountName,
      deviceInfo: input.deviceInfo,
    })
    .onConflictDoUpdate({
      target: [captureEnrollments.accountId, captureEnrollments.machineKeySha256, captureEnrollments.principal],
      set: {
        tokenId: token.tokenId,
        principalName: input.principalName,
        accountName: input.accountName,
        deviceInfo: input.deviceInfo,
        lastSeenAt: sql`now()`,
      },
    })
    .returning();
  return row!;
}

async function machineIsNewToToken(token: EnrollmentToken, machineKey: string): Promise<boolean> {
  const [row] = await db
    .select({ id: captureEnrollments.enrollmentId })
    .from(captureEnrollments)
    .where(and(eq(captureEnrollments.tokenId, token.tokenId), eq(captureEnrollments.machineKeySha256, machineKey), ne(captureEnrollments.status, 'denied')))
    .limit(1);
  return !row;
}

async function setPending(row: Enrollment, reason: 'no_member' | 'approval_required', userId: string | null) {
  await db
    .update(captureEnrollments)
    .set({ status: 'pending', reason, userId })
    .where(eq(captureEnrollments.enrollmentId, row.enrollmentId));
}

/** The device row of (account, machine, member), revoked or not. */
async function deviceOf(accountId: string, machineKey: string, userId: string) {
  const [row] = await db
    .select()
    .from(captureDevices)
    .where(and(eq(captureDevices.accountId, accountId), eq(captureDevices.machineKeySha256, machineKey), eq(captureDevices.userId, userId)))
    .limit(1);
  return row ?? null;
}

/**
 * One enroll call, which is also the poll. Idempotent for the same token,
 * machine and person; an `enrolled` answer always mints a new device token
 * (the previous one stops working), same device id.
 */
export async function enroll(input: EnrollInput): Promise<EnrollOutcome> {
  const token = await tokenRow(input.token);
  if (!token || tokenState(token) !== 'active') return { kind: 'invalid_token' };
  const ids = { tokenId: token.tokenId, accountId: token.accountId };
  if (!(await captureEnabled(token.accountId))) return { kind: 'capture_disabled' };
  const principal = principalOf({ principal_name: input.principalName, account_name: input.accountName });
  if (!principal) return { kind: 'bad_principal' };
  if (token.emailDomains.length > 0) {
    const domain = emailDomain(principal);
    if (!domain || !token.emailDomains.includes(domain)) return { kind: 'domain_not_allowed', ...ids };
  }

  const [existing] = await db
    .select()
    .from(captureEnrollments)
    .where(
      and(
        eq(captureEnrollments.accountId, token.accountId),
        eq(captureEnrollments.machineKeySha256, input.machineKey),
        eq(captureEnrollments.principal, principal),
      ),
    )
    .limit(1);
  if (existing?.status === 'denied') {
    await db.update(captureEnrollments).set({ lastSeenAt: sql`now()` }).where(eq(captureEnrollments.enrollmentId, existing.enrollmentId));
    return { kind: 'denied', ...ids, enrollmentId: existing.enrollmentId };
  }
  if (!existing && token.maxDevices !== null && (await machineIsNewToToken(token, input.machineKey))) {
    const count = (await deviceCounts([token.tokenId])).get(token.tokenId) ?? 0;
    if (count >= token.maxDevices) return { kind: 'limit_reached', ...ids };
  }
  const row = await upsertEnrollment(token, input, principal);
  const decided = row.decidedBy !== null && (row.status === 'approved' || row.status === 'enrolled');

  // Who: an admin's decision for this row, else a trusted member email, else an earlier decision for this person.
  let userId = decided && row.userId && (await isAccountMember(token.accountId, row.userId)) ? row.userId : null;
  const emailShaped = emailDomain(principal) ? principal : null;
  userId ??= (emailShaped && (await memberByEmail(token.accountId, emailShaped))) || (await memberByDecision(token.accountId, principal));
  if (!userId) {
    await setPending(row, 'no_member', null);
    return { kind: 'pending', reason: 'no_member', ...ids, enrollmentId: row.enrollmentId };
  }
  const device = await deviceOf(token.accountId, input.machineKey, userId);
  // An admin approves a computer of an approval-only token once; a revoked device only by a new approval.
  const needsApproval = (token.requireApproval && !decided) || Boolean(device?.revokedAt);
  if (needsApproval) {
    await setPending(row, 'approval_required', userId);
    return { kind: 'pending', reason: 'approval_required', ...ids, enrollmentId: row.enrollmentId };
  }
  return mintDeviceToken(token, row, userId);
}

async function mintDeviceToken(token: EnrollmentToken, row: Enrollment, userId: string): Promise<EnrollOutcome> {
  const fields = deviceFields(row.deviceInfo);
  const deviceToken = `${DEVICE_TOKEN_PREFIX}${randomAlphanumeric(40)}`;
  const deviceId = await db.transaction(async (tx) => {
    const [device] = await tx
      .insert(captureDevices)
      .values({
        accountId: token.accountId,
        userId,
        machineKeySha256: row.machineKeySha256,
        ...fields,
        deviceInfo: row.deviceInfo,
        enrollmentTokenId: token.tokenId,
        tokenHash: hashSecretKey(deviceToken),
        tokenIssuedAt: sql`now()`,
      })
      .onConflictDoUpdate({
        target: [captureDevices.accountId, captureDevices.machineKeySha256, captureDevices.userId],
        set: {
          ...fields,
          enrollmentTokenId: token.tokenId,
          tokenHash: hashSecretKey(deviceToken),
          tokenIssuedAt: sql`now()`,
          updatedAt: sql`now()`,
        },
      })
      .returning({ deviceId: captureDevices.deviceId });
    await tx
      .update(captureEnrollments)
      .set({ status: 'enrolled', reason: null, userId, deviceId: device!.deviceId })
      .where(eq(captureEnrollments.enrollmentId, row.enrollmentId));
    await tx.update(captureEnrollmentTokens).set({ lastUsedAt: sql`now()` }).where(eq(captureEnrollmentTokens.tokenId, token.tokenId));
    return device!.deviceId;
  });
  await ensurePolicyObject(token.accountId);
  const [[account], emails] = await Promise.all([
    db.select({ name: accounts.name }).from(accounts).where(eq(accounts.accountId, token.accountId)).limit(1),
    lookupEmailsByUserIds([userId]),
  ]);
  return {
    kind: 'enrolled',
    tokenId: token.tokenId,
    accountId: token.accountId,
    enrollmentId: row.enrollmentId,
    token: deviceToken,
    prefix: accountPrefix(token.accountId),
    deviceId,
    userId,
    accountName: account?.name ?? '',
    memberEmail: emails.get(userId) ?? null,
  };
}

// ─── Waiting computers (admin) ───────────────────────────────────────────────

export function enrollmentView(row: Enrollment, tokenName: string | null) {
  const fields = deviceFields(row.deviceInfo);
  return {
    enrollment_id: row.enrollmentId,
    token_id: row.tokenId,
    token_name: tokenName,
    status: row.status as 'pending' | 'approved' | 'denied' | 'enrolled',
    reason: (row.reason ?? null) as 'no_member' | 'approval_required' | null,
    principal_name: row.principalName,
    account_name: row.accountName,
    device: { name: fields.name, os: fields.os, os_version: fields.osVersion, arch: fields.arch, app_version: fields.appVersion },
    user_id: row.userId,
    device_id: row.deviceId,
    decided_by: row.decidedBy,
    decided_at: row.decidedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    last_seen_at: row.lastSeenAt.toISOString(),
  };
}

export async function listEnrollments(accountId: string, status?: string) {
  const rows = await db
    .select({ row: captureEnrollments, tokenName: captureEnrollmentTokens.name })
    .from(captureEnrollments)
    .innerJoin(captureEnrollmentTokens, eq(captureEnrollmentTokens.tokenId, captureEnrollments.tokenId))
    .where(and(eq(captureEnrollments.accountId, accountId), ...(status ? [eq(captureEnrollments.status, status)] : [])))
    .orderBy(desc(captureEnrollments.lastSeenAt))
    .limit(500);
  return rows.map(({ row, tokenName }) => enrollmentView(row, tokenName));
}

export async function enrollmentInAccount(accountId: string, enrollmentId: string) {
  const [found] = await db
    .select({ row: captureEnrollments, tokenName: captureEnrollmentTokens.name })
    .from(captureEnrollments)
    .innerJoin(captureEnrollmentTokens, eq(captureEnrollmentTokens.tokenId, captureEnrollments.tokenId))
    .where(and(eq(captureEnrollments.enrollmentId, enrollmentId), eq(captureEnrollments.accountId, accountId)))
    .limit(1);
  return found ?? null;
}

/**
 * Approve a computer to a member. Its next enroll call gets a device token.
 * A device of that member on that computer an admin revoked is revived.
 */
export async function approveEnrollment(row: Enrollment, userId: string, by: string): Promise<Enrollment> {
  return db.transaction(async (tx) => {
    await tx
      .update(captureDevices)
      .set({ revokedAt: null, revokedBy: null, updatedAt: sql`now()` })
      .where(
        and(
          eq(captureDevices.accountId, row.accountId),
          eq(captureDevices.machineKeySha256, row.machineKeySha256),
          eq(captureDevices.userId, userId),
        ),
      );
    const [updated] = await tx
      .update(captureEnrollments)
      .set({ status: 'approved', reason: null, userId, decidedBy: by, decidedAt: sql`now()` })
      .where(eq(captureEnrollments.enrollmentId, row.enrollmentId))
      .returning();
    return updated!;
  });
}

/**
 * Deny a computer + person. Its enroll calls answer `enrollment_denied` until
 * an admin approves it. A device it already enrolled is revoked: its token
 * stops working at once.
 */
export async function denyEnrollment(row: Enrollment, by: string): Promise<Enrollment> {
  return db.transaction(async (tx) => {
    if (row.deviceId) {
      await tx
        .update(captureDevices)
        .set({ revokedAt: sql`coalesce(${captureDevices.revokedAt}, now())`, revokedBy: by, tokenHash: null, updatedAt: sql`now()` })
        .where(eq(captureDevices.deviceId, row.deviceId));
    }
    const [updated] = await tx
      .update(captureEnrollments)
      .set({ status: 'denied', reason: null, decidedBy: by, decidedAt: sql`now()` })
      .where(eq(captureEnrollments.enrollmentId, row.enrollmentId))
      .returning();
    return updated!;
  });
}
