/** Kortix for Chrome rows: connections, grants, attachments. */
import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import {
  chromeAttachments,
  chromeConnections,
  chromeGrants,
  projectSessions,
  projects,
  sessionSandboxes,
} from '@kortix/db';
import { db } from '../shared/db';
import type { ActiveSession, ChromeRow, GrantRow } from './logic';

const connectionColumns = {
  chromeId: chromeConnections.chromeId,
  name: chromeConnections.name,
  brand: chromeConnections.brand,
  os: chromeConnections.os,
  profileLabel: chromeConnections.profileLabel,
  extensionVersion: chromeConnections.extensionVersion,
  accessMode: chromeConnections.accessMode,
  tabScope: chromeConnections.tabScope,
  lastSeenAt: chromeConnections.lastSeenAt,
  relayOwnerId: chromeConnections.relayOwnerId,
  revokedAt: chromeConnections.revokedAt,
  createdAt: chromeConnections.createdAt,
};

export interface ChromeInfo {
  brand: string;
  os: string;
  profileLabel: string | null;
  extensionVersion: string | null;
}

/** The owner's browsers, newest `last_seen_at` first. Revoked rows are not listed. */
export async function listChromeConnections(userId: string): Promise<ChromeRow[]> {
  return db
    .select(connectionColumns)
    .from(chromeConnections)
    .where(and(eq(chromeConnections.userId, userId), isNull(chromeConnections.revokedAt)))
    .orderBy(sql`${chromeConnections.lastSeenAt} desc nulls last`, desc(chromeConnections.createdAt));
}

export async function getChrome(userId: string, chromeId: string): Promise<ChromeRow | null> {
  const [row] = await db
    .select(connectionColumns)
    .from(chromeConnections)
    .where(
      and(
        eq(chromeConnections.chromeId, chromeId),
        eq(chromeConnections.userId, userId),
        isNull(chromeConnections.revokedAt),
      ),
    );
  return row ?? null;
}

/** Active sessions (granted or connected attachments) per browser, with the session title. */
export async function activeSessionsFor(chromeIds: string[]): Promise<Map<string, ActiveSession[]>> {
  const out = new Map<string, ActiveSession[]>();
  if (chromeIds.length === 0) return out;
  const rows = await db
    .select({
      chromeId: chromeAttachments.chromeId,
      sessionId: chromeAttachments.sessionId,
      projectId: chromeAttachments.projectId,
      title: sql<string | null>`${projectSessions.metadata}->>'name'`,
    })
    .from(chromeAttachments)
    .leftJoin(projectSessions, eq(projectSessions.sessionId, chromeAttachments.sessionId))
    .where(
      and(
        inArray(chromeAttachments.chromeId, chromeIds),
        inArray(chromeAttachments.status, ['granted', 'connected']),
      ),
    );
  for (const r of rows) {
    const list = out.get(r.chromeId) ?? [];
    list.push({ sessionId: r.sessionId, projectId: r.projectId ?? '', title: r.title || 'Session' });
    out.set(r.chromeId, list);
  }
  return out;
}

export async function updateChromeConnection(
  userId: string,
  chromeId: string,
  patch: { name?: string; accessMode?: string; tabScope?: string },
): Promise<ChromeRow | null> {
  const [row] = await db
    .update(chromeConnections)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(
        eq(chromeConnections.chromeId, chromeId),
        eq(chromeConnections.userId, userId),
        isNull(chromeConnections.revokedAt),
      ),
    )
    .returning(connectionColumns);
  return row ?? null;
}

/** Revoke a browser and end its open attachments. Returns false when it is not the caller's. */
export async function revokeChrome(userId: string, chromeId: string): Promise<boolean> {
  const now = new Date();
  const [row] = await db
    .update(chromeConnections)
    .set({ revokedAt: now, updatedAt: now })
    .where(
      and(
        eq(chromeConnections.chromeId, chromeId),
        eq(chromeConnections.userId, userId),
        isNull(chromeConnections.revokedAt),
      ),
    )
    .returning({ id: chromeConnections.chromeId });
  if (!row) return false;
  await db
    .update(chromeAttachments)
    .set({ status: 'ended', endReason: 'revoked', updatedAt: now })
    .where(
      and(
        eq(chromeAttachments.chromeId, chromeId),
        inArray(chromeAttachments.status, ['pending', 'granted', 'connected']),
      ),
    );
  return true;
}

/**
 * First-frame auth result. Reuses `chromeId` when it is the caller's live
 * row; otherwise creates a new row. The row is marked seen by this replica.
 */
export async function upsertConnection(input: {
  userId: string;
  accountId: string;
  chromeId: string | null;
  info: ChromeInfo;
  relayOwnerId: string;
}): Promise<ChromeRow> {
  const now = new Date();
  const { info } = input;
  if (input.chromeId) {
    const [row] = await db
      .update(chromeConnections)
      .set({
        brand: info.brand,
        os: info.os,
        profileLabel: info.profileLabel,
        extensionVersion: info.extensionVersion,
        relayOwnerId: input.relayOwnerId,
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(chromeConnections.chromeId, input.chromeId),
          eq(chromeConnections.userId, input.userId),
          isNull(chromeConnections.revokedAt),
        ),
      )
      .returning(connectionColumns);
    if (row) return row;
  }
  const [row] = await db
    .insert(chromeConnections)
    .values({
      userId: input.userId,
      accountId: input.accountId,
      name: defaultChromeName(info),
      brand: info.brand,
      os: info.os,
      profileLabel: info.profileLabel,
      extensionVersion: info.extensionVersion,
      relayOwnerId: input.relayOwnerId,
      lastSeenAt: now,
    })
    .returning(connectionColumns);
  return row;
}

/** "Chrome · Work (macOS)" style default name. */
export function defaultChromeName(info: ChromeInfo): string {
  // "Chrome · Work" when Chrome names the profile, else "Chrome on macOS".
  const name = info.profileLabel ? `${info.brand} · ${info.profileLabel}` : `${info.brand} on ${info.os}`;
  return name.slice(0, 255);
}

export async function touchChrome(chromeId: string, relayOwnerId: string): Promise<void> {
  await db
    .update(chromeConnections)
    .set({ lastSeenAt: new Date(), relayOwnerId })
    .where(and(eq(chromeConnections.chromeId, chromeId), isNull(chromeConnections.revokedAt)));
}

/**
 * The control socket closed (sign-out, Chrome quit): offline at once, not after
 * the ping window. Only while this replica still owns it, so a reconnect that
 * landed on another replica stays online.
 */
export async function markOffline(chromeId: string, relayOwnerId: string): Promise<void> {
  await db
    .update(chromeConnections)
    .set({ relayOwnerId: null })
    .where(and(eq(chromeConnections.chromeId, chromeId), eq(chromeConnections.relayOwnerId, relayOwnerId)));
}

// ── Grants ──────────────────────────────────────────────────────────────────

export async function listGrants(chromeId: string, projectId: string, sessionId: string): Promise<GrantRow[]> {
  return db
    .select({ projectId: chromeGrants.projectId, sessionId: chromeGrants.sessionId, decision: chromeGrants.decision })
    .from(chromeGrants)
    .where(
      and(
        eq(chromeGrants.chromeId, chromeId),
        sql`(${chromeGrants.sessionId} = ${sessionId} or (${chromeGrants.sessionId} is null and ${chromeGrants.projectId} = ${projectId}))`,
      ),
    );
}

/**
 * Record a decision for a session. The session's older grants go in the same
 * transaction, so an attach never sees the gap between the delete and the insert.
 * `grantSessionId` null is a project-wide allow.
 */
export async function replaceSessionGrant(input: {
  chromeId: string;
  projectId: string;
  sessionId: string;
  grantSessionId: string | null;
  decision: 'allow' | 'deny';
}): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(chromeGrants)
      .where(and(eq(chromeGrants.chromeId, input.chromeId), eq(chromeGrants.sessionId, input.sessionId)));
    await tx.insert(chromeGrants).values({
      chromeId: input.chromeId,
      projectId: input.projectId,
      sessionId: input.grantSessionId,
      decision: input.decision,
    });
  });
}

// ── Attachments ─────────────────────────────────────────────────────────────

export interface AttachmentRow {
  attachmentId: string;
  chromeId: string;
  userId: string | null;
  projectId: string | null;
  sessionId: string;
  status: string;
}

const attachmentColumns = {
  attachmentId: chromeAttachments.attachmentId,
  chromeId: chromeAttachments.chromeId,
  userId: chromeAttachments.userId,
  projectId: chromeAttachments.projectId,
  sessionId: chromeAttachments.sessionId,
  status: chromeAttachments.status,
};

export async function insertAttachment(input: {
  chromeId: string;
  userId: string;
  projectId: string;
  sessionId: string;
  status: 'pending' | 'granted';
}): Promise<AttachmentRow> {
  const [row] = await db.insert(chromeAttachments).values(input).returning(attachmentColumns);
  return row;
}

export async function getAttachment(attachmentId: string): Promise<AttachmentRow | null> {
  const [row] = await db
    .select(attachmentColumns)
    .from(chromeAttachments)
    .where(eq(chromeAttachments.attachmentId, attachmentId));
  return row ?? null;
}

/** Move an attachment to `status`, only from one of the `from` statuses. */
export async function setAttachmentStatus(
  attachmentId: string,
  status: string,
  from: string[],
  endReason: string | null = null,
): Promise<boolean> {
  const rows = await db
    .update(chromeAttachments)
    .set({ status, endReason, updatedAt: new Date() })
    .where(and(eq(chromeAttachments.attachmentId, attachmentId), inArray(chromeAttachments.status, from)))
    .returning({ id: chromeAttachments.attachmentId });
  return rows.length > 0;
}

/** Open attachments of a session, other than `exceptId`. */
export async function openAttachmentsOfSession(sessionId: string, exceptId: string): Promise<AttachmentRow[]> {
  return db
    .select(attachmentColumns)
    .from(chromeAttachments)
    .where(
      and(
        eq(chromeAttachments.sessionId, sessionId),
        ne(chromeAttachments.attachmentId, exceptId),
        inArray(chromeAttachments.status, ['pending', 'granted', 'connected']),
      ),
    );
}

/** Ids of a browser's open attachments. */
export async function openAttachmentIdsOfChrome(chromeId: string): Promise<string[]> {
  const rows = await db
    .select({ id: chromeAttachments.attachmentId })
    .from(chromeAttachments)
    .where(
      and(
        eq(chromeAttachments.chromeId, chromeId),
        inArray(chromeAttachments.status, ['pending', 'granted', 'connected']),
      ),
    );
  return rows.map((r) => r.id);
}

// ── The session an attach belongs to ────────────────────────────────────────

export interface SessionContext {
  externalId: string | null;
  title: string;
  projectName: string;
}

export async function loadSessionContext(sessionId: string, projectId: string): Promise<SessionContext> {
  const [row] = await db
    .select({
      externalId: sessionSandboxes.externalId,
      title: sql<string | null>`${projectSessions.metadata}->>'name'`,
      projectName: projects.name,
    })
    .from(sessionSandboxes)
    .leftJoin(projectSessions, eq(projectSessions.sessionId, sessionSandboxes.sessionId))
    .leftJoin(projects, eq(projects.projectId, sessionSandboxes.projectId))
    .where(and(eq(sessionSandboxes.sessionId, sessionId), eq(sessionSandboxes.projectId, projectId)))
    .limit(1);
  return {
    externalId: row?.externalId ?? null,
    title: row?.title || 'Session',
    projectName: row?.projectName ?? '',
  };
}
