/**
 * ART-8: live presence on an Artifact (KRTX-3669). Real HTTP and real Bun
 * WebSockets against the local API: the ticket gate, presence between two
 * people, a `changed` ping after a REST comment, agent presence from a
 * session-bound token, and the 4403 close when view access goes.
 *
 * The Artifacts are seeded rows (HTML, no Files storage), as ART-4 does. The
 * agent sessions come from `AgentPrincipalsWorld` (a governed manifest on the
 * local bare repository). Generic fixtures only.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { flow } from '../core/flow';
import { waitFor } from '../core/poll';
import type { FlowContext } from '../core/types';
import { AgentPrincipalsWorld } from '../fixtures/agent-principals';
import { withDb } from '../fixtures/chat';

const ARTIFACT = '/v1/workspaces/:projectId/artifacts/:artifactId';
const LIVE = `${ARTIFACT}/live`;
const TICKET = `${LIVE}/ticket`;
const AGENT = `${LIVE}/agent`;
const COMMENTS = `${ARTIFACT}/comments`;
const FEATURES = '/v1/workspaces/:projectId/features';

const AGENTS = [
  'project:',
  '  name: artifact-live',
  'default_agent: writer',
  'agents:',
  '  writer:',
  '    kortix_permissions: [project.session.read, project.artifact.comment]',
  '  outsider:',
  '    kortix_permissions: [project.session.read]',
  '',
].join('\n');

type Frame = { t: string; [key: string]: any };
type Participant = { id: string; who: { kind: string; user_id?: string; session_id?: string; agent_name?: string }; status: string; focus: string | null; typing: unknown };

/** One live socket, as a browser holds it: hello on open, a ping every 10 s. */
class LiveSocket {
  frames: Frame[] = [];
  closed: { code: number; reason: string } | null = null;
  private listeners: Array<() => void> = [];
  private pinger: ReturnType<typeof setInterval> | null = null;

  private constructor(readonly ws: WebSocket) {
    ws.onmessage = (event) => {
      this.frames.push(JSON.parse(String(event.data)));
      this.listeners.forEach((listener) => listener());
    };
    ws.onclose = (event) => {
      this.closed = { code: event.code, reason: event.reason };
      if (this.pinger) clearInterval(this.pinger);
      this.listeners.forEach((listener) => listener());
    };
  }

  static open(url: string): Promise<LiveSocket> {
    const ws = new WebSocket(url);
    return new Promise((resolve, reject) => {
      ws.onopen = () => {
        const socket = new LiveSocket(ws);
        socket.send({ v: 1, t: 'hello', view: 'page', version: null, hidden: false });
        socket.pinger = setInterval(() => socket.send({ v: 1, t: 'ping' }), 10_000);
        resolve(socket);
      };
      ws.onerror = () => reject(new Error('live socket did not open'));
    });
  }

  send(frame: Frame): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  /** The first frame that matches, waiting up to `timeoutMs`. */
  async take(match: (frame: Frame) => boolean, timeoutMs = 10_000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const at = this.frames.findIndex(match);
      if (at >= 0) return this.frames.splice(at, 1)[0]!;
      if (this.closed) throw new Error(`live socket closed ${this.closed.code} ${this.closed.reason} while waiting`);
      if (Date.now() >= deadline) throw new Error(`no matching frame in ${timeoutMs} ms; got ${JSON.stringify(this.frames.map((f) => f.t))}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 200);
        this.listeners.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** A presence frame whose participants satisfy `match`. */
  presence(match: (participants: Participant[]) => boolean, timeoutMs = 10_000): Promise<Frame> {
    return this.take((frame) => frame.t === 'presence' && match(frame.participants as Participant[]), timeoutMs);
  }

  async closedWith(timeoutMs = 10_000): Promise<number> {
    await waitFor(() => this.closed, { until: (closed) => closed !== null, timeoutMs, intervalMs: 100, description: 'live socket close' });
    return this.closed!.code;
  }

  dispose(): void {
    if (this.pinger) clearInterval(this.pinger);
    try {
      this.ws.close();
    } catch {
      // Already closed.
    }
  }
}

/** The HTTP answer to a WebSocket upgrade request: 101 when it upgraded. */
function upgrade(url: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request(url.replace(/^ws/, 'http'), {
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64') },
    });
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      resolve({ status: 101, body: null });
    });
    req.on('response', (res) => {
      let text = '';
      res.on('data', (chunk) => { text += String(chunk); });
      res.on('end', () => {
        let body: unknown = text;
        try { body = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error('upgrade request timed out')));
    req.end();
  });
}

function liveUrl(ctx: FlowContext, projectId: string, artifactId: string, ticket?: string): string {
  const base = `${ctx.env.apiUrl.replace(/^http/, 'ws')}/projects/${projectId}/artifacts/${artifactId}/live`;
  return ticket === undefined ? base : `${base}?ticket=${encodeURIComponent(ticket)}`;
}

flow('ART-8', {
  domain: 'artifacts',
  requires: ['database', 'supabaseAdmin'],
  timeoutMs: 180_000,
  routes: [`PATCH ${FEATURES}`, `GET ${LIVE}`, `POST ${TICKET}`, `POST ${AGENT}`, `POST ${COMMENTS}`, `PATCH ${ARTIFACT}`],
}, async (ctx) => {
  const team = await ctx.fixtures.team({ enterprise: true });
  const project = await team.project({ managedGit: true });
  const member = await team.addMember('member');
  await team.grantProjectRole(project.id, member.userId!, 'member');
  const owner = ctx.client.as(ctx.P.OWNER);
  const asMember = ctx.client.as(member);
  const artifactId = randomUUID();
  const sharedId = randomUUID();
  const hiddenId = randomUUID();
  const driveId = randomUUID();
  const params = { projectId: project.id, artifactId };
  const sharedParams = { projectId: project.id, artifactId: sharedId };
  const ticketFor = async (client: typeof owner, at = params) => (await client.post(TICKET, {}, { params: at }))
    .status(200).json<{ ticket: string; expires_at: string }>();
  const world = await AgentPrincipalsWorld.open(ctx, { accountId: team.id, projectId: project.id });
  const sockets: LiveSocket[] = [];
  const open = async (ticket: string, at = artifactId) => {
    const socket = await LiveSocket.open(liveUrl(ctx, project.id, at, ticket));
    sockets.push(socket);
    return socket;
  };
  const isUser = (userId: string | null | undefined) => (p: Participant) => p.who.kind === 'user' && p.who.user_id === userId;

  try {
    await ctx.step('seed a project page, a page shared with the member and a private page without Files storage', async () => {
      await withDb(ctx, async (db) => {
        await db.query(
          `INSERT INTO kortix.drives (drive_id, account_id, kind, name, project_id, platinum_volume_name)
           VALUES ($1, $2, 'project', 'Artifact live', $3, $4)`,
          [driveId, team.id, project.id, `ke2e-live-${driveId}`],
        );
        for (const [id, visibility, shared] of [[artifactId, 'project', []], [sharedId, 'private', [member.userId]], [hiddenId, 'private', []]] as const) {
          await db.query(
            `INSERT INTO kortix.artifacts
               (artifact_id, project_id, account_id, drive_id, root, entry, folder, title, type, visibility, created_by_user_id, shared_with_user_ids)
             VALUES ($1, $2, $3, $4, $5, 'index.html', true, 'Launch plan', 'html', $6, $7, $8::uuid[])`,
            [id, project.id, team.id, driveId, `/Company/Artifacts/${id}`, visibility, ctx.P.OWNER.userId, shared],
          );
        }
      });
      (await owner.patch(FEATURES, { feature: 'artifacts', enabled: true }, { params: { projectId: project.id } })).status(200);
    });

    await ctx.step('artifact_comments off → the ticket route answers 403 feature_disabled; ANON → 401', async () => {
      (await owner.post(TICKET, {}, { params })).status(403).body().has('$.code', 'feature_disabled');
      (await ctx.client.as(ctx.P.ANON).post(TICKET, {}, { params })).status(401);
      (await owner.patch(FEATURES, { feature: 'artifact_comments', enabled: true }, { params: { projectId: project.id } })).status(200);
    });

    await ctx.step('a non-viewer cannot mint a ticket → 404; a ticket lives 60 s; a plain GET of the socket path → 426', async () => {
      (await asMember.post(TICKET, {}, { params: { projectId: project.id, artifactId: hiddenId } })).status(404);
      const minted = await ticketFor(owner);
      const lifetime = Date.parse(minted.expires_at) - Date.now();
      if (lifetime < 50_000 || lifetime > 61_000) throw new Error(`ticket expires in ${lifetime} ms, expected about 60 000`);
      (await owner.get(LIVE, { params })).status(426).body().has('$.code', 'websocket_required');
    });

    await ctx.step('the ticket is opaque; no ticket, a forged ticket, one changed byte and a ticket for another Artifact → 401 before the upgrade', async () => {
      const sealed = (await ticketFor(owner)).ticket;
      if (!/^[A-Za-z0-9_-]+$/.test(sealed) || /[0-9a-f]{8}-[0-9a-f]{4}-/i.test(Buffer.from(sealed, 'base64url').toString('latin1'))) {
        throw new Error('the ticket is not an opaque base64url token');
      }
      const changed = Buffer.from(sealed, 'base64url');
      changed[changed.length - 1] = changed[changed.length - 1]! ^ 0x01;
      for (const url of [
        liveUrl(ctx, project.id, artifactId),
        liveUrl(ctx, project.id, artifactId, 'forged.ticket'),
        liveUrl(ctx, project.id, artifactId, changed.toString('base64url')),
        liveUrl(ctx, project.id, sharedId, (await ticketFor(owner)).ticket),
      ]) {
        const refused = await upgrade(url);
        if (refused.status !== 401 || refused.body?.code !== 'artifact_live_ticket_invalid') {
          throw new Error(`upgrade answered ${refused.status} ${JSON.stringify(refused.body)}, expected 401 artifact_live_ticket_invalid`);
        }
      }
    });

    let ownerSocket!: LiveSocket;
    let memberSocket!: LiveSocket;
    await ctx.step('OWNER and the member each open a socket → welcome, and each sees the other in presence; a reused ticket → 401', async () => {
      const ownerTicket = (await ticketFor(owner)).ticket;
      ownerSocket = await open(ownerTicket);
      const welcome = await ownerSocket.take((f) => f.t === 'welcome');
      if (welcome.sends !== true || typeof welcome.you !== 'string') throw new Error(`welcome ${JSON.stringify(welcome)}`);
      memberSocket = await open((await ticketFor(asMember)).ticket);
      await memberSocket.take((f) => f.t === 'welcome');
      await ownerSocket.presence((ps) => ps.some(isUser(member.userId)) && ps.some(isUser(ctx.P.OWNER.userId)));
      await memberSocket.presence((ps) => ps.some(isUser(member.userId)) && ps.some(isUser(ctx.P.OWNER.userId)));
      const reused = await upgrade(liveUrl(ctx, project.id, artifactId, ownerTicket));
      if (reused.status !== 401) throw new Error(`a reused ticket answered ${reused.status}, expected 401`);
      ownerSocket.send({ v: 1, t: 'ping' });
      await ownerSocket.take((f) => f.t === 'pong');
    });

    let threadId = '';
    await ctx.step('a comment created through REST → both sockets get changed {comments} and changed {activity}', async () => {
      const created = (await owner.post(COMMENTS, { anchor: { type: 'none', version: 'v1' }, body: 'Check the launch date.' }, { params }))
        .status(201).json<{ thread: { thread_id: string } }>();
      threadId = created.thread.thread_id;
      for (const socket of [ownerSocket, memberSocket]) {
        await socket.take((f) => f.t === 'changed' && f.what === 'comments' && f.version === null);
        await socket.take((f) => f.t === 'changed' && f.what === 'activity');
      }
    });

    await ctx.step('POST …/live/agent from a session token → 204 and both sockets see the session editing at the thread; a person → 403; a session without view → 404', async () => {
      await world.writeManifest(AGENTS, 'ke2e: artifact live agents');
      const writer = await world.mintAgentSession({ agent: 'writer', launcher: ctx.P.OWNER, visibility: 'project' });
      const outsider = await world.mintAgentSession({ agent: 'outsider', launcher: ctx.P.OWNER, visibility: 'project' });
      (await writer.client.post(AGENT, { status: 'editing', thread_id: threadId }, { params })).status(204);
      const isWriter = (p: Participant) => p.who.kind === 'session' && p.who.session_id === writer.sessionId;
      for (const socket of [ownerSocket, memberSocket]) {
        await socket.presence((ps) => ps.some((p) => isWriter(p) && p.status === 'editing' && p.focus === threadId && p.who.agent_name === 'writer'));
      }
      (await writer.client.post(AGENT, { status: 'writing', thread_id: threadId }, { params })).status(204);
      await memberSocket.presence((ps) => ps.some((p) => isWriter(p) && p.status === 'writing' && JSON.stringify(p.typing) === JSON.stringify({ thread_id: threadId })));
      (await writer.client.post(AGENT, { status: 'dancing' }, { params })).status(400);
      (await writer.client.post(AGENT, { status: 'editing', thread_id: randomUUID() }, { params })).status(404);
      (await owner.post(AGENT, { status: 'editing' }, { params })).status(403).body().has('$.code', 'artifact_live_session_only');
      (await outsider.client.post(AGENT, { status: 'editing' }, { params })).status(404);
      (await writer.client.post(AGENT, { status: 'idle' }, { params })).status(204);
      await ownerSocket.presence((ps) => !ps.some(isWriter) && ps.some(isUser(member.userId)));
    });

    await ctx.step('a ticket minted before the share was removed → 404 at the upgrade; a socket open when it is removed closes with 4403', async () => {
      const early = (await ticketFor(asMember, sharedParams)).ticket;
      (await owner.patch(ARTIFACT, { shared_with_user_ids: [] }, { params: sharedParams })).status(200);
      const refused = await upgrade(liveUrl(ctx, project.id, sharedId, early));
      if (refused.status !== 404) throw new Error(`the upgrade after unsharing answered ${refused.status} ${JSON.stringify(refused.body)}, expected 404`);
      (await owner.patch(ARTIFACT, { shared_with_user_ids: [member.userId] }, { params: sharedParams })).status(200);
      const socket = await open((await ticketFor(asMember, sharedParams)).ticket, sharedId);
      await socket.take((f) => f.t === 'welcome');
      (await owner.patch(ARTIFACT, { shared_with_user_ids: [] }, { params: sharedParams })).status(200);
      const code = await socket.closedWith(10_000);
      if (code !== 4403) throw new Error(`the socket closed with ${code}, expected 4403`);
      // The project page's sockets stay open.
      if (ownerSocket.closed || memberSocket.closed) throw new Error('a socket on another Artifact closed');
    });

    await ctx.step('bye closes a socket and the other socket sees it leave', async () => {
      memberSocket.send({ v: 1, t: 'bye' });
      await memberSocket.closedWith(5_000);
      await ownerSocket.presence((ps) => !ps.some(isUser(member.userId)) && ps.some(isUser(ctx.P.OWNER.userId)));
    });
  } finally {
    for (const socket of sockets) socket.dispose();
    await world.close();
  }
});
