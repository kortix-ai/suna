/**
 * The live socket of an Artifact (KRTX-3669):
 * `GET /v1/projects/{projectId}/artifacts/{artifactId}/live?ticket=`, upgraded
 * in `inbound-dispatch.ts`, `ws.data.type = 'artifact-live'`.
 *
 * It carries presence and `changed` pings only; comments and content always
 * come through REST with their own checks. The rooms of this process live in
 * `live-rooms.ts`. This module connects them to:
 *   - the sockets (`artifactLiveWsHandlers`, wired in `index.ts`);
 *   - the other API processes, over `kortix_artifact_live` on the existing
 *     pg-broadcast connection (no new database connection). Each delta is
 *     under 8 KB; a full presence list never crosses. Without the LISTEN
 *     (`isPgBroadcastListening()` false: a transaction pooler) presence stays
 *     inside one process, and clients keep their 10 s poll;
 *   - access: every socket re-checks its view access every 60 s, at once on an
 *     IAM cache bust for its user or project, and at once when its Artifact is
 *     unshared or its sharing changes. Access lost closes it with 4403;
 *   - agent presence: `POST …/live/agent`, a delivered comment hand-off, and
 *     the session's turn ending (`kortix_session_changed`).
 */
import {
  ARTIFACT_LIVE_CLOSE,
  ARTIFACT_LIVE_LIMITS,
  artifactLiveChangeSchema,
  artifactLiveParticipantSchema,
  type ArtifactLiveAgentSignal,
  type ArtifactLivePosition,
} from '@kortix/shared/artifact-live';
import { artifactCommentThreads } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import type { Actor } from '../iam/actor';
import { registerPrincipalScopedMemo, registerProjectScopedMemo } from '../iam/cache-invalidation';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { onArtifactLive, onSessionChanged } from '../shared/pg-broadcast';
import { isUuid } from '../shared/validate';
import { artifactLiveActor, artifactLiveIdentity, artifactLiveSessionAgent, checkArtifactLiveAccess } from './live-access';
import { ARTIFACT_LIVE_NOTIFY_MAX_BYTES, ARTIFACT_LIVE_ORIGIN, sendArtifactLiveDelta, setArtifactLiveSink } from './live-publish';
import { ArtifactLiveRooms, type LiveClock, type LiveIdentity, type LiveRelay } from './live-rooms';
import { artifactLiveTicketDigest, consumeArtifactLiveTicket, markArtifactLiveTicketUsed, verifyArtifactLiveTicket } from './live-ticket';

const L = ARTIFACT_LIVE_LIMITS;
/** An IAM bust or an unshare re-checks this soon: after the write that caused it commits. */
const RECHECK_SOON_MS = 250;
/** A re-check that could not read the database runs again this soon. */
const RECHECK_RETRY_MS = 15_000;

/** What a socket's re-checks need. */
interface Binding {
  actor: Actor;
  sessionId: string | null;
  nextCheckAt: number;
  checking: boolean;
  again: boolean;
}

export interface ArtifactLiveWsData {
  type: 'artifact-live';
  projectId: string;
  artifactId: string;
  identity: LiveIdentity;
  binding: Binding;
  connId?: string;
}

type LiveWs = { data: ArtifactLiveWsData; send(data: string): unknown; close(code?: number, reason?: string): void };

const clock: LiveClock = {
  now: () => Date.now(),
  later: (run, ms) => {
    const timer = setTimeout(run, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
    return () => clearTimeout(timer);
  },
};

/** An `up` delta that does not fit pg_notify drops, in order, the avatar, the selection and the cursor. */
function relay(message: LiveRelay): void {
  if (sendArtifactLiveDelta(message)) return;
  if (message.k !== 'up') return;
  let participant = message.p;
  for (const strip of [{ avatar_url: null }, { selection: null }, { cursor: null }] as const) {
    participant = { ...participant, ...strip };
    if (sendArtifactLiveDelta({ ...message, p: participant })) return;
  }
  logger.warn('[artifact-live] a participant delta exceeds pg_notify', { bytes: ARTIFACT_LIVE_NOTIFY_MAX_BYTES });
}

// replica-local: the rooms of the sockets this process holds; other processes
// reach them through `kortix_artifact_live`.
const rooms = new ArtifactLiveRooms<Binding>({ clock, relay, origin: ARTIFACT_LIVE_ORIGIN });

export function artifactLiveRoomCount(): number {
  return rooms.size;
}

// ── The upgrade ──────────────────────────────────────────────────────────────

export type ArtifactLiveUpgrade =
  | { ok: true; data: ArtifactLiveWsData }
  | { ok: false; status: 401 | 403 | 404 | 503; body: { error: string; code: string } };

/**
 * Check the ticket (401: none, forged, expired, used, or for another
 * Artifact), consume it, then run the view check (404, or 403 with the flag
 * off). The JWT never reaches this URL: only the ticket does.
 */
export async function prepareArtifactLiveUpgrade(input: {
  projectId: string;
  artifactId: string;
  ticket: string | null;
  ip: string | null;
}): Promise<ArtifactLiveUpgrade> {
  const { projectId, artifactId, ticket } = input;
  if (!isUuid(projectId) || !isUuid(artifactId)) return { ok: false, status: 404, body: { error: 'Artifact not found', code: 'not_found' } };
  const verified = verifyArtifactLiveTicket(ticket, { projectId, artifactId });
  if (!verified || !ticket || !consumeArtifactLiveTicket(ticket, verified.expiresAt)) {
    return { ok: false, status: 401, body: { error: 'A valid, unused live ticket is required', code: 'artifact_live_ticket_invalid' } };
  }
  sendArtifactLiveDelta({ k: 'used', h: artifactLiveTicketDigest(ticket), x: verified.expiresAt });
  const { claims } = verified;
  try {
    const access = await checkArtifactLiveAccess({ actor: await artifactLiveActor(claims, input.ip), sessionId: claims.s, projectId, artifactId });
    if (!access.ok) return { ok: false, status: access.status, body: { error: access.error, code: access.code } };
    const identity = await artifactLiveIdentity(access.actor, claims.s, projectId);
    const binding: Binding = { actor: access.actor, sessionId: claims.s, nextCheckAt: Date.now() + L.accessRecheckMs, checking: false, again: false };
    return { ok: true, data: { type: 'artifact-live', projectId, artifactId, identity, binding } };
  } catch (error) {
    logger.warn('[artifact-live] upgrade check failed', { error: error instanceof Error ? error.message : String(error) });
    return { ok: false, status: 503, body: { error: 'Live presence is unavailable; try again shortly', code: 'artifact_live_unavailable' } };
  }
}

export const artifactLiveWsHandlers = {
  open(ws: LiveWs) {
    const { data } = ws;
    data.connId = rooms.join({ artifactId: data.artifactId, projectId: data.projectId, socket: ws, identity: data.identity, meta: data.binding }).id;
  },
  message(ws: LiveWs, raw: string | Uint8Array) {
    if (ws.data.connId) rooms.receive(ws.data.artifactId, ws.data.connId, raw);
  },
  close(ws: LiveWs) {
    if (ws.data.connId) rooms.leave(ws.data.artifactId, ws.data.connId);
  },
};

// ── Access re-checks ─────────────────────────────────────────────────────────

let soonCancel: (() => void) | null = null;

function scheduleSoon(): void {
  if (soonCancel) return;
  soonCancel = clock.later(() => {
    soonCancel = null;
    void runDueRechecks();
  }, RECHECK_SOON_MS);
}

/** Re-check every matching socket soon. One running now runs again when it ends. */
function requestRecheck(match: (binding: Binding, artifactId: string, projectId: string) => boolean): void {
  const soon = Date.now() + RECHECK_SOON_MS;
  let any = false;
  for (const conn of rooms.connections()) {
    if (!match(conn.meta, conn.artifactId, conn.projectId)) continue;
    conn.meta.nextCheckAt = Math.min(conn.meta.nextCheckAt, soon);
    if (conn.meta.checking) conn.meta.again = true;
    any = true;
  }
  if (any) scheduleSoon();
}

function actorKey(binding: Binding): string {
  const { actor } = binding;
  const token = 'tokenId' in actor.credential ? actor.credential.tokenId : '';
  return `${actor.userId}|${actor.credential.kind}|${token}|${binding.sessionId ?? ''}|${actor.ctx.ip ?? ''}`;
}

type DueConn = { artifactId: string; projectId: string; id: string; meta: Binding };

/** One check per actor and Artifact; its verdict applies to each of that actor's sockets there. */
async function recheckGroup(group: DueConn[]): Promise<void> {
  const first = group[0]!;
  for (const conn of group) {
    conn.meta.checking = true;
    conn.meta.again = false;
  }
  let verdict: 'ok' | 'lost' | 'retry' = 'retry';
  let actor: Actor | null = null;
  try {
    const access = await checkArtifactLiveAccess({ actor: first.meta.actor, sessionId: first.meta.sessionId, projectId: first.projectId, artifactId: first.artifactId });
    verdict = access.ok ? 'ok' : 'lost';
    if (access.ok) actor = access.actor;
  } catch (error) {
    // A failed read keeps the socket: only a definite "no" closes it.
    logger.warn('[artifact-live] access re-check failed', { error: error instanceof Error ? error.message : String(error) });
  }
  const now = Date.now();
  let again = false;
  for (const conn of group) {
    conn.meta.checking = false;
    if (verdict === 'lost') {
      rooms.close(conn.artifactId, conn.id, ARTIFACT_LIVE_CLOSE.accessLost, 'access lost');
      continue;
    }
    if (actor) conn.meta.actor = actor;
    again ||= conn.meta.again;
    conn.meta.nextCheckAt = conn.meta.again ? now : now + (verdict === 'ok' ? L.accessRecheckMs : RECHECK_RETRY_MS);
  }
  if (again) scheduleSoon();
}

async function runDueRechecks(): Promise<void> {
  const now = Date.now();
  const groups = new Map<string, DueConn[]>();
  for (const conn of rooms.connections()) {
    if (conn.meta.checking || conn.meta.nextCheckAt > now) continue;
    const key = `${actorKey(conn.meta)}|${conn.artifactId}`;
    groups.set(key, [...(groups.get(key) ?? []), conn]);
  }
  await Promise.all([...groups.values()].map(recheckGroup));
}

/** Expiry, keepalive and the due access re-checks. `replica/artifact-live.ts` runs it every few seconds. */
export async function sweepArtifactLive(): Promise<void> {
  rooms.sweep();
  await runDueRechecks();
}

// ── Agent presence ───────────────────────────────────────────────────────────

export class ArtifactLiveAgentError extends Error {
  constructor(readonly status: 404, message: string, readonly code: string) {
    super(message);
    this.name = 'ArtifactLiveAgentError';
  }
}

/** `POST …/live/agent` from a session-bound token: the session's agent names its place. */
export async function signalArtifactLiveAgent(
  artifact: { artifactId: string; projectId: string },
  sessionId: string,
  signal: ArtifactLiveAgentSignal,
): Promise<void> {
  if (signal.thread_id) {
    const [thread] = await db
      .select({ id: artifactCommentThreads.threadId })
      .from(artifactCommentThreads)
      .where(and(eq(artifactCommentThreads.threadId, signal.thread_id), eq(artifactCommentThreads.artifactId, artifact.artifactId)))
      .limit(1);
    if (!thread) throw new ArtifactLiveAgentError(404, 'Comment thread not found', 'not_found');
  }
  const agentName = await artifactLiveSessionAgent(artifact.projectId, sessionId);
  if (!agentName) throw new ArtifactLiveAgentError(404, 'Session not found', 'not_found');
  rooms.agentSignal({ artifactId: artifact.artifactId, projectId: artifact.projectId, sessionId, agentName, signal });
}

/** A delivered comment hand-off (`live-publish.ts`). */
export function artifactLiveAgentDelivered(input: {
  artifactId: string;
  projectId: string;
  sessionId: string;
  agentName: string;
  threadId: string;
  cursor: ArtifactLivePosition | null;
}): void {
  rooms.agentDelivered(input);
}

/** The session replied (`live-publish.ts`). */
export function artifactLiveAgentWrote(artifactId: string, sessionId: string): void {
  rooms.agentWrote(artifactId, sessionId);
}

// ── Wiring ───────────────────────────────────────────────────────────────────

const optionalAt = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? { at: value } : {});

/** One delta from another process. Anything malformed is dropped. */
function onNotify(payload: string): void {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(payload);
  } catch {
    return;
  }
  if (!m || typeof m !== 'object' || typeof m.o !== 'string' || m.o === ARTIFACT_LIVE_ORIGIN) return;
  const origin = m.o;
  if (m.k === 'used') {
    if (typeof m.h === 'string' && typeof m.x === 'number') markArtifactLiveTicketUsed(m.h, m.x);
    return;
  }
  if (!isUuid(m.a)) return;
  const a = m.a;
  switch (m.k) {
    case 'ch': {
      const what = artifactLiveChangeSchema.safeParse(m.w);
      if (what.success) rooms.changed(a, what.data, typeof m.v === 'string' && m.v.length <= 512 ? m.v : null);
      return;
    }
    case 'chk':
      return requestRecheck((_binding, artifactId) => artifactId === a);
    case 'up': {
      const participant = artifactLiveParticipantSchema.safeParse(m.p);
      if (participant.success) rooms.remote(origin, { k: 'up', a, p: participant.data, ...optionalAt(m.at) });
      return;
    }
    case 'rm':
      if (typeof m.id === 'string' && m.id.length <= 128) rooms.remote(origin, { k: 'rm', a, id: m.id, ...optionalAt(m.at) });
      return;
    case 'sync':
      return rooms.remote(origin, { k: 'sync', a });
    case 'aw':
      if (isUuid(m.s)) rooms.remote(origin, { k: 'aw', a, s: m.s });
      return;
  }
}

onArtifactLive(onNotify);

setArtifactLiveSink({
  changed: (artifactId, what, version) => rooms.changed(artifactId, what, version),
  recheck: (artifactId) => requestRecheck((_binding, id) => id === artifactId),
});

// An IAM bust for a user or a project (any replica's: the bust crosses on
// `kortix_iam_cache_bust`) re-checks the sockets it may have revoked. The
// registries call `invalidateByPrefix('<id>|')`.
registerPrincipalScopedMemo({
  invalidateByPrefix: (prefix) => {
    const userId = prefix.endsWith('|') ? prefix.slice(0, -1) : prefix;
    requestRecheck((binding) => binding.actor.userId === userId);
  },
});
registerProjectScopedMemo({
  invalidateByPrefix: (prefix) => {
    const projectId = prefix.endsWith('|') ? prefix.slice(0, -1) : prefix;
    requestRecheck((_binding, _artifactId, id) => id === projectId);
  },
});

// A session's box changed (turn start or end, stop): an agent it showed here
// leaves when a turn it was in has ended.
onSessionChanged((sessionId) => {
  if (!rooms.holdsAgent(sessionId)) return;
  void import('../projects/surface')
    .then(({ sessionHoldsLiveTurn }) => sessionHoldsLiveTurn(sessionId))
    .then((live) => rooms.sessionTurn(sessionId, live))
    .catch(() => {});
});
