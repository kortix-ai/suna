/** Kortix Browser rows: connections, grants, attachments. */
import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import {
  browserAttachments,
  browserConnections,
  browserGrants,
  projectSessions,
  projects,
  sessionSandboxes,
} from '@kortix/db';
import { db } from '../shared/db';
import type { ActiveSession, BrowserRow, GrantRow } from './logic';

const connectionColumns = {
  browserId: browserConnections.browserId,
  name: browserConnections.name,
  brand: browserConnections.brand,
  os: browserConnections.os,
  profileLabel: browserConnections.profileLabel,
  extensionVersion: browserConnections.extensionVersion,
  accessMode: browserConnections.accessMode,
  tabScope: browserConnections.tabScope,
  lastSeenAt: browserConnections.lastSeenAt,
  relayOwnerId: browserConnections.relayOwnerId,
  revokedAt: browserConnections.revokedAt,
  createdAt: browserConnections.createdAt,
};

export interface BrowserInfo {
  brand: string;
  os: string;
  profileLabel: string | null;
  extensionVersion: string | null;
}

/** The owner's browsers, newest `last_seen_at` first. Revoked rows are not listed. */
export async function listBrowsers(userId: string): Promise<BrowserRow[]> {
  return db
    .select(connectionColumns)
    .from(browserConnections)
    .where(and(eq(browserConnections.userId, userId), isNull(browserConnections.revokedAt)))
    .orderBy(sql`${browserConnections.lastSeenAt} desc nulls last`, desc(browserConnections.createdAt));
}

export async function getBrowser(userId: string, browserId: string): Promise<BrowserRow | null> {
  const [row] = await db
    .select(connectionColumns)
    .from(browserConnections)
    .where(
      and(
        eq(browserConnections.browserId, browserId),
        eq(browserConnections.userId, userId),
        isNull(browserConnections.revokedAt),
      ),
    );
  return row ?? null;
}

/** Active sessions (granted or connected attachments) per browser, with the session title. */
export async function activeSessionsFor(browserIds: string[]): Promise<Map<string, ActiveSession[]>> {
  const out = new Map<string, ActiveSession[]>();
  if (browserIds.length === 0) return out;
  const rows = await db
    .select({
      browserId: browserAttachments.browserId,
      sessionId: browserAttachments.sessionId,
      projectId: browserAttachments.projectId,
      title: sql<string | null>`${projectSessions.metadata}->>'name'`,
    })
    .from(browserAttachments)
    .leftJoin(projectSessions, eq(projectSessions.sessionId, browserAttachments.sessionId))
    .where(
      and(
        inArray(browserAttachments.browserId, browserIds),
        inArray(browserAttachments.status, ['granted', 'connected']),
      ),
    );
  for (const r of rows) {
    const list = out.get(r.browserId) ?? [];
    list.push({ sessionId: r.sessionId, projectId: r.projectId ?? '', title: r.title || 'Session' });
    out.set(r.browserId, list);
  }
  return out;
}

export async function updateBrowser(
  userId: string,
  browserId: string,
  patch: { name?: string; accessMode?: string; tabScope?: string },
): Promise<BrowserRow | null> {
  const [row] = await db
    .update(browserConnections)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(
        eq(browserConnections.browserId, browserId),
        eq(browserConnections.userId, userId),
        isNull(browserConnections.revokedAt),
      ),
    )
    .returning(connectionColumns);
  return row ?? null;
}

/** Revoke a browser and end its open attachments. Returns false when it is not the caller's. */
export async function revokeBrowser(userId: string, browserId: string): Promise<boolean> {
  const now = new Date();
  const [row] = await db
    .update(browserConnections)
    .set({ revokedAt: now, updatedAt: now })
    .where(
      and(
        eq(browserConnections.browserId, browserId),
        eq(browserConnections.userId, userId),
        isNull(browserConnections.revokedAt),
      ),
    )
    .returning({ id: browserConnections.browserId });
  if (!row) return false;
  await db
    .update(browserAttachments)
    .set({ status: 'ended', endReason: 'revoked', updatedAt: now })
    .where(
      and(
        eq(browserAttachments.browserId, browserId),
        inArray(browserAttachments.status, ['pending', 'granted', 'connected']),
      ),
    );
  return true;
}

/**
 * First-frame auth result. Reuses `browserId` when it is the caller's live
 * row; otherwise creates a new row. The row is marked seen by this replica.
 */
export async function upsertConnection(input: {
  userId: string;
  accountId: string;
  browserId: string | null;
  info: BrowserInfo;
  relayOwnerId: string;
}): Promise<BrowserRow> {
  const now = new Date();
  const { info } = input;
  if (input.browserId) {
    const [row] = await db
      .update(browserConnections)
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
          eq(browserConnections.browserId, input.browserId),
          eq(browserConnections.userId, input.userId),
          isNull(browserConnections.revokedAt),
        ),
      )
      .returning(connectionColumns);
    if (row) return row;
  }
  const [row] = await db
    .insert(browserConnections)
    .values({
      userId: input.userId,
      accountId: input.accountId,
      name: defaultBrowserName(info),
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
export function defaultBrowserName(info: BrowserInfo): string {
  // "Chrome · Work" when Chrome names the profile, else "Chrome on macOS".
  const name = info.profileLabel ? `${info.brand} · ${info.profileLabel}` : `${info.brand} on ${info.os}`;
  return name.slice(0, 255);
}

export async function touchBrowser(browserId: string, relayOwnerId: string): Promise<void> {
  await db
    .update(browserConnections)
    .set({ lastSeenAt: new Date(), relayOwnerId })
    .where(and(eq(browserConnections.browserId, browserId), isNull(browserConnections.revokedAt)));
}

/**
 * The control socket closed (sign-out, Chrome quit): offline at once, not after
 * the ping window. Only while this replica still owns it, so a reconnect that
 * landed on another replica stays online.
 */
export async function markOffline(browserId: string, relayOwnerId: string): Promise<void> {
  await db
    .update(browserConnections)
    .set({ relayOwnerId: null })
    .where(and(eq(browserConnections.browserId, browserId), eq(browserConnections.relayOwnerId, relayOwnerId)));
}

// ── Grants ──────────────────────────────────────────────────────────────────

export async function listGrants(browserId: string, projectId: string, sessionId: string): Promise<GrantRow[]> {
  return db
    .select({ projectId: browserGrants.projectId, sessionId: browserGrants.sessionId, decision: browserGrants.decision })
    .from(browserGrants)
    .where(
      and(
        eq(browserGrants.browserId, browserId),
        sql`(${browserGrants.sessionId} = ${sessionId} or (${browserGrants.sessionId} is null and ${browserGrants.projectId} = ${projectId}))`,
      ),
    );
}

/**
 * Record a decision for a session. The session's older grants go in the same
 * transaction, so an attach never sees the gap between the delete and the insert.
 * `grantSessionId` null is a project-wide allow.
 */
export async function replaceSessionGrant(input: {
  browserId: string;
  projectId: string;
  sessionId: string;
  grantSessionId: string | null;
  decision: 'allow' | 'deny';
}): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(browserGrants)
      .where(and(eq(browserGrants.browserId, input.browserId), eq(browserGrants.sessionId, input.sessionId)));
    await tx.insert(browserGrants).values({
      browserId: input.browserId,
      projectId: input.projectId,
      sessionId: input.grantSessionId,
      decision: input.decision,
    });
  });
}

// ── Attachments ─────────────────────────────────────────────────────────────

export interface AttachmentRow {
  attachmentId: string;
  browserId: string;
  userId: string | null;
  projectId: string | null;
  sessionId: string;
  status: string;
}

const attachmentColumns = {
  attachmentId: browserAttachments.attachmentId,
  browserId: browserAttachments.browserId,
  userId: browserAttachments.userId,
  projectId: browserAttachments.projectId,
  sessionId: browserAttachments.sessionId,
  status: browserAttachments.status,
};

export async function insertAttachment(input: {
  browserId: string;
  userId: string;
  projectId: string;
  sessionId: string;
  status: 'pending' | 'granted';
}): Promise<AttachmentRow> {
  const [row] = await db.insert(browserAttachments).values(input).returning(attachmentColumns);
  return row;
}

export async function getAttachment(attachmentId: string): Promise<AttachmentRow | null> {
  const [row] = await db
    .select(attachmentColumns)
    .from(browserAttachments)
    .where(eq(browserAttachments.attachmentId, attachmentId));
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
    .update(browserAttachments)
    .set({ status, endReason, updatedAt: new Date() })
    .where(and(eq(browserAttachments.attachmentId, attachmentId), inArray(browserAttachments.status, from)))
    .returning({ id: browserAttachments.attachmentId });
  return rows.length > 0;
}

/** Open attachments of a session, other than `exceptId`. */
export async function openAttachmentsOfSession(sessionId: string, exceptId: string): Promise<AttachmentRow[]> {
  return db
    .select(attachmentColumns)
    .from(browserAttachments)
    .where(
      and(
        eq(browserAttachments.sessionId, sessionId),
        ne(browserAttachments.attachmentId, exceptId),
        inArray(browserAttachments.status, ['pending', 'granted', 'connected']),
      ),
    );
}

/** Ids of a browser's open attachments. */
export async function openAttachmentIdsOfBrowser(browserId: string): Promise<string[]> {
  const rows = await db
    .select({ id: browserAttachments.attachmentId })
    .from(browserAttachments)
    .where(
      and(
        eq(browserAttachments.browserId, browserId),
        inArray(browserAttachments.status, ['pending', 'granted', 'connected']),
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
