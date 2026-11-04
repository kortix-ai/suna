/**
 * The live socket's lifecycle in one process (KRTX-3669): the credential
 * behind a socket ends it (4401), lost view access ends it (4403), and one
 * person cannot hold more than SOCKETS_PER_ACTOR sockets on an Artifact. The
 * view check itself (`live-access.ts`) is replaced: it needs a database.
 */
import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ARTIFACT_LIVE_CLOSE } from '@kortix/shared/artifact-live';
import type { ArtifactLiveAccess } from './live-access';

const USER = '60000000-0000-4000-8000-000000000001';
const ACCOUNT = '60000000-0000-4000-8000-000000000002';
const PROJECT = '60000000-0000-4000-8000-000000000003';
const actor = { userId: USER, accountId: ACCOUNT, credential: { kind: 'jwt' as const }, ctx: {} };
let verdict: ArtifactLiveAccess = { ok: true, actor, credentialExpiresAt: null };

mock.module('./live-access', () => ({
  artifactLiveActor: async () => actor,
  artifactLiveIdentity: async () => ({ who: { kind: 'user', user_id: USER }, name: 'Person', avatar_url: null }),
  artifactLiveSessionAgent: async () => 'agent',
  checkArtifactLiveAccess: async () => verdict,
}));

const hub = await import('./live-hub');
const { mintArtifactLiveTicket } = await import('./live-ticket');
const { SOCKETS_PER_ACTOR } = await import('./live-rooms');

const T0 = Date.parse('2026-11-04T10:00:00.000Z');

class FakeWs {
  frames: Array<{ t: string }> = [];
  closed: number | null = null;
  constructor(readonly data: any) {}
  send(raw: string) { this.frames.push(JSON.parse(raw)); }
  close(code?: number) { this.closed = code ?? 1000; }
  getBufferedAmount() { return 0; }
}

async function openSocket(artifactId: string, credentialExpiresAt: number | null = T0 + 3_600_000): Promise<FakeWs> {
  const { ticket } = mintArtifactLiveTicket({ p: PROJECT, a: artifactId, u: USER, c: ACCOUNT, k: 'jwt', t: null, s: null, m: null, q: 'browser_session', g: null, x: credentialExpiresAt });
  const prepared = await hub.prepareArtifactLiveUpgrade({ projectId: PROJECT, artifactId, ticket, ip: null });
  if (!prepared.ok) throw new Error(`upgrade refused: ${prepared.status} ${prepared.body.code}`);
  const ws = new FakeWs(prepared.data);
  hub.artifactLiveWsHandlers.open(ws as never);
  return ws;
}

const ping = (ws: FakeWs) => hub.artifactLiveWsHandlers.message(ws as never, JSON.stringify({ v: 1, t: 'ping' }));

beforeEach(() => {
  setSystemTime(new Date(T0));
  verdict = { ok: true, actor, credentialExpiresAt: null };
});
afterEach(() => setSystemTime());

describe('the credential behind a live socket (Strix: revoked or expired sessions)', () => {
  test('a socket closes with 4401 when its credential expires, without a database read', async () => {
    const ws = await openSocket(randomUUID(), T0 + 30_000);
    expect(ws.frames[0]?.t).toBe('welcome');
    setSystemTime(new Date(T0 + 29_000));
    await hub.sweepArtifactLive();
    expect(ws.closed).toBeNull();
    setSystemTime(new Date(T0 + 30_001));
    await hub.sweepArtifactLive();
    expect(ws.closed).toBe(ARTIFACT_LIVE_CLOSE.unauthorized);
  });

  test('a socket lives at most an hour on one ticket, whatever the credential', async () => {
    const ws = await openSocket(randomUUID(), null);
    for (let minute = 1; minute <= 60; minute++) {
      setSystemTime(new Date(T0 + minute * 60_000 - 20_000));
      ping(ws);
      setSystemTime(new Date(T0 + minute * 60_000 + 1));
      await hub.sweepArtifactLive();
    }
    expect(ws.closed).toBe(ARTIFACT_LIVE_CLOSE.unauthorized);
  });

  test('a signed-out session or a revoked token closes the socket with 4401 at the next re-check', async () => {
    const ws = await openSocket(randomUUID());
    setSystemTime(new Date(T0 + 30_000));
    ping(ws);
    verdict = { ok: false, status: 401, error: 'Your session ended', code: 'credential_revoked' };
    setSystemTime(new Date(T0 + 60_001));
    await hub.sweepArtifactLive();
    expect(ws.closed).toBe(ARTIFACT_LIVE_CLOSE.unauthorized);
  });

  test('lost view access still closes with 4403', async () => {
    const ws = await openSocket(randomUUID());
    setSystemTime(new Date(T0 + 30_000));
    ping(ws);
    verdict = { ok: false, status: 404, error: 'Artifact not found', code: 'not_found' };
    setSystemTime(new Date(T0 + 60_001));
    await hub.sweepArtifactLive();
    expect(ws.closed).toBe(ARTIFACT_LIVE_CLOSE.accessLost);
  });

  test('an upgrade whose credential is gone is refused with 401', async () => {
    verdict = { ok: false, status: 401, error: 'Your session ended', code: 'credential_revoked' };
    const artifactId = randomUUID();
    const { ticket } = mintArtifactLiveTicket({ p: PROJECT, a: artifactId, u: USER, c: ACCOUNT, k: 'jwt', t: null, s: null, m: null, q: 'browser_session', g: null, x: null });
    const prepared = await hub.prepareArtifactLiveUpgrade({ projectId: PROJECT, artifactId, ticket, ip: null });
    expect(prepared.ok ? 101 : prepared.status).toBe(401);
  });
});

describe('socket caps at the upgrade (Strix: unbounded live sockets per Artifact)', () => {
  test(`the ${SOCKETS_PER_ACTOR + 1}th socket of one person on one Artifact is refused with 429 before the upgrade`, async () => {
    const artifactId = randomUUID();
    for (let i = 0; i < SOCKETS_PER_ACTOR; i++) await openSocket(artifactId);
    const { ticket } = mintArtifactLiveTicket({ p: PROJECT, a: artifactId, u: USER, c: ACCOUNT, k: 'jwt', t: null, s: null, m: null, q: 'browser_session', g: null, x: null });
    const prepared = await hub.prepareArtifactLiveUpgrade({ projectId: PROJECT, artifactId, ticket, ip: null });
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect([prepared.status, prepared.body.code]).toEqual([429, 'artifact_live_too_many_sockets']);
  });
});

describe('one Artifact, one room (Strix: case-variant spellings of the Artifact UUID)', () => {
  test('every hex-case spelling of the Artifact and project ids shares one room and one per-person cap', async () => {
    const artifactId = randomUUID();
    const upper = artifactId.toUpperCase();
    const rooms = hub.artifactLiveRoomCount();
    for (let i = 0; i < SOCKETS_PER_ACTOR - 1; i++) await openSocket(artifactId);
    // A ticket minted on the lower-case id opens through an upper-case URL, into the same room.
    const { ticket } = mintArtifactLiveTicket({ p: PROJECT, a: artifactId, u: USER, c: ACCOUNT, k: 'jwt', t: null, s: null, m: null, q: 'browser_session', g: null, x: null });
    const mixed = await hub.prepareArtifactLiveUpgrade({ projectId: PROJECT.toUpperCase(), artifactId: upper, ticket, ip: null });
    expect(mixed.ok).toBe(true);
    if (!mixed.ok) return;
    expect([mixed.data.projectId, mixed.data.artifactId]).toEqual([PROJECT, artifactId]);
    hub.artifactLiveWsHandlers.open(new FakeWs(mixed.data) as never);
    expect(hub.artifactLiveRoomCount()).toBe(rooms + 1);
    // The cap counts every spelling: the next socket, under yet another spelling, is refused.
    const next = mintArtifactLiveTicket({ p: PROJECT, a: upper, u: USER, c: ACCOUNT, k: 'jwt', t: null, s: null, m: null, q: 'browser_session', g: null, x: null });
    const refused = await hub.prepareArtifactLiveUpgrade({ projectId: PROJECT, artifactId: `${upper.slice(0, 4)}${artifactId.slice(4)}`, ticket: next.ticket, ip: null });
    expect(refused.ok ? 101 : refused.status).toBe(429);
  });

  test('an agent signal through an upper-case URL shows in the room the viewers are in', async () => {
    const artifactId = randomUUID();
    const ws = await openSocket(artifactId);
    const sessionId = randomUUID();
    const rooms = hub.artifactLiveRoomCount();
    await hub.signalArtifactLiveAgent({ artifactId: artifactId.toUpperCase(), projectId: PROJECT.toUpperCase() }, sessionId.toUpperCase(), { status: 'editing' });
    // Another spelling would open a second room, which no viewer is in.
    expect(hub.artifactLiveRoomCount()).toBe(rooms);
    expect(ws.closed).toBeNull();
  });
});
