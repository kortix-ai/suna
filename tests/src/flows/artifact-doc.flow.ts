/**
 * ART-10: the live document of a doc Artifact (KRTX-3670). Real HTTP against
 * the local API: seed, push, pull after a seq, the file-writer lease, the
 * flush record, the size and format refusals, the flag and type gates, and a
 * live socket that hears `changed {what:"doc"}` after a push.
 *
 * The Artifacts are seeded rows with no Files storage, as ART-8 does: the doc
 * routes never read the file. The Yjs updates are fixed bytes made once with
 * yjs@13.6.33 (the server only validates and relays them): a seed paragraph
 * "Launch plan", then three edits from a second client that make
 * "Launch plan for Q3" and "Owner: Ada.". Generic fixtures only.
 */
import { randomUUID } from 'node:crypto';
import { flow } from '../core/flow';
import type { FlowContext } from '../core/types';
import { waitFor } from '../core/poll';
import { withDb } from '../fixtures/chat';

const ARTIFACT = '/v1/workspaces/:projectId/artifacts/:artifactId';
const DOC = `${ARTIFACT}/doc`;
const SEED = `${DOC}/seed`;
const UPDATES = `${DOC}/updates`;
const LEASE = `${DOC}/lease`;
const FLUSHED = `${DOC}/flushed`;
const RESET = `${DOC}/reset`;
const LIVE = `${ARTIFACT}/live`;
const TICKET = `${LIVE}/ticket`;
const FEATURES = '/v1/workspaces/:projectId/features';

const SEED_UPDATE = 'AQPpBwAHAQdkZWZhdWx0AwlwYXJhZ3JhcGgHAOkHAAYEAOkHAQtMYXVuY2ggcGxhbgA=';
const EDITS = ['AQHSDwCE6QcMByBmb3IgUTMA', 'AQPSDweH6QcAAwlwYXJhZ3JhcGgHANIPBwYEANIPCApPd25lcjogQWRhAA==', 'AQHSDxOE0g8SAS4A'];
const SEED_MARKDOWN = 'Launch plan\n';
const FLUSHED_MARKDOWN = 'Launch plan for Q3\n\nOwner: Ada\n';
/** 17 bytes: one item whose origin is its own future clock. It decodes, and `Y.applyUpdate` throws on every client. */
const POISON = 'AQGVmu86AISVmu86yAEBeAA=';
/** The seed merged with the first edit: the structs of two clients in one push. */
const TWO_CLIENTS = 'AgHSDwCE6QcMByBmb3IgUTMD6QcABwEHZGVmYXVsdAMJcGFyYWdyYXBoBwDpBwAGBADpBwELTGF1bmNoIHBsYW4A';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Strix's 27 bytes: an XML text placed by its origin (client 4131944473, clock 0), then text inside it. This doc never had that origin. */
const ORIGIN_PLACED_TEXT = 'AQKj4fJVAIeZ8KGyDwAGBACj4fJVAANwd24A';
/** Client 3003, clock 0: an XML text placed by its origin right after the seed's paragraph (1001:0), so at the root. */
const TEXT_AFTER_ROOT_PARAGRAPH = Buffer.from([1, 1, 0xbb, 0x17, 0, 0x87, 0xe9, 0x07, 0, 6, 0]).toString('base64');
/** A ContentDoc item (a Yjs sub-document): valid Yjs, content the editor never emits. */
const SUBDOC = Buffer.from([1, 1, 77, 0, 9, 1, 0, 0, 118, 0, 0]).toString('base64');

/** A seed of one paragraph holding `size` bytes of text (paragraph at the root, an XML text in it, the text in that). */
function bigTextUpdate(size: number): string {
  const varUint = (n: number) => {
    const out: number[] = [];
    while (n > 0x7f) {
      out.push(0x80 | (n & 0x7f));
      n = Math.floor(n / 128);
    }
    out.push(n);
    return out;
  };
  const str = (text: string) => [...varUint(Buffer.byteLength(text)), ...Buffer.from(text)];
  const head = [
    1, 3, 77, 0,
    7, 1, ...str('default'), 3, ...str('paragraph'), // 77:0, a paragraph at the root
    7, 0, 77, 0, 6, // 77:1, an XML text inside 77:0
    4, 0, 77, 1, ...varUint(size), // 77:2, the text inside 77:1
  ];
  return Buffer.concat([Buffer.from(head), Buffer.alloc(size, 0x61), Buffer.from([0])]).toString('base64');
}

type Doc = {
  seeded: boolean;
  epoch: string | null;
  latest_seq: number;
  updates: Array<{ seq: number; update: string }>;
  has_more: boolean;
  flushed: { seq: number; version: string | null; markdown?: string } | null;
  lease: { holder: string; expires_at: string } | null;
};
type Lease = { leader: boolean; holder: string | null; expires_at: string | null };

/** A live socket that keeps every frame it receives. */
async function openLive(ctx: FlowContext, projectId: string, artifactId: string, ticket: string) {
  const url = `${ctx.env.apiUrl.replace(/^http/, 'ws')}/projects/${projectId}/artifacts/${artifactId}/live?ticket=${encodeURIComponent(ticket)}`;
  const ws = new WebSocket(url);
  const frames: Array<Record<string, any>> = [];
  ws.onmessage = (event) => frames.push(JSON.parse(String(event.data)));
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('live socket did not open'));
  });
  ws.send(JSON.stringify({ v: 1, t: 'hello', view: 'doc', version: null, hidden: false }));
  const take = async (match: (frame: Record<string, any>) => boolean, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const at = frames.findIndex(match);
      if (at >= 0) return frames.splice(at, 1)[0]!;
      if (ws.readyState === WebSocket.CLOSED) throw new Error('live socket closed while waiting');
      if (Date.now() >= deadline) throw new Error(`no matching frame in ${timeoutMs} ms; got ${JSON.stringify(frames.map((f) => [f.t, f.what]))}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  return { take, close: () => ws.close() };
}

flow('ART-10', {
  domain: 'artifacts',
  requires: ['database', 'supabaseAdmin'],
  timeoutMs: 180_000,
  routes: [`PATCH ${FEATURES}`, `GET ${DOC}`, `POST ${SEED}`, `POST ${UPDATES}`, `POST ${LEASE}`, `POST ${FLUSHED}`, `POST ${RESET}`, `PUT ${ARTIFACT}`, `POST ${TICKET}`, `GET ${LIVE}`],
}, async (ctx) => {
  const team = await ctx.fixtures.team({ enterprise: true });
  const project = await team.project({ managedGit: true });
  const member = await team.addMember('member');
  await team.grantProjectRole(project.id, member.userId!, 'member');
  // A second person who may write the doc (a manager reaches /Company in Files).
  const writer = await team.addMember('member');
  await team.grantProjectRole(project.id, writer.userId!, 'manager');
  const asWriter = ctx.client.as(writer);
  const owner = ctx.client.as(ctx.P.OWNER);
  const asMember = ctx.client.as(member);
  const anon = ctx.client.as(ctx.P.ANON);
  const docId = randomUUID();
  const pageId = randomUUID();
  const driveId = randomUUID();
  const params = { projectId: project.id, artifactId: docId };
  const pageParams = { projectId: project.id, artifactId: pageId };
  const read = async (query: Record<string, string> = {}, client = owner) => (await client.get(DOC, { params, query })).status(200).json<Doc>();
  const lease = async (body: Record<string, unknown>) => (await owner.post(LEASE, body, { params })).status(200).json<Lease>();
  const sockets: Array<{ close(): void }> = [];
  let epoch = '';
  let live: Awaited<ReturnType<typeof openLive>> | undefined;
  const auditCount = (action: string, statusClause = 'true') => withDb(ctx, async (db) => Number((await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM kortix.audit_events WHERE project_id = $1 AND action = $2 AND ${statusClause}`, [project.id, action])).rows[0]!.n));

  try {
    await ctx.step('seed a project doc and a project page without Files storage; turn on artifacts only', async () => {
      await withDb(ctx, async (db) => {
        await db.query(
          `INSERT INTO kortix.drives (drive_id, account_id, kind, name, project_id, platinum_volume_name)
           VALUES ($1, $2, 'project', 'Artifact doc sync', $3, $4)`,
          [driveId, team.id, project.id, `ke2e-doc-${driveId}`],
        );
        for (const [id, type, entry] of [[docId, 'doc', 'index.md'], [pageId, 'html', 'index.html']] as const) {
          await db.query(
            `INSERT INTO kortix.artifacts
               (artifact_id, project_id, account_id, drive_id, root, entry, folder, title, type, visibility, created_by_user_id)
             VALUES ($1, $2, $3, $4, $5, $6, true, 'Launch plan', $7, 'project', $8)`,
            [id, project.id, team.id, driveId, `/Company/Artifacts/${id}`, entry, type, ctx.P.OWNER.userId],
          );
        }
      });
      (await owner.patch(FEATURES, { feature: 'artifacts', enabled: true }, { params: { projectId: project.id } })).status(200);
    });

    await ctx.step('artifact_comments off → every doc route answers 403 feature_disabled, as the comment routes do; ANON → 401', async () => {
      (await owner.get(DOC, { params })).status(403).body().has('$.code', 'feature_disabled');
      (await owner.post(SEED, { update: SEED_UPDATE, markdown: SEED_MARKDOWN, version: 'v1' }, { params })).status(403).body().has('$.code', 'feature_disabled');
      (await owner.post(UPDATES, { update: EDITS[0] }, { params })).status(403).body().has('$.code', 'feature_disabled');
      (await owner.post(LEASE, { holder: 'tab-a' }, { params })).status(403).body().has('$.code', 'feature_disabled');
      (await owner.post(FLUSHED, { holder: 'tab-a', seq: 1, version: 'v1', markdown: '' }, { params })).status(403).body().has('$.code', 'feature_disabled');
      (await owner.post(RESET, { holder: 'tab-a' }, { params })).status(403).body().has('$.code', 'feature_disabled');
      (await anon.get(DOC, { params })).status(401);
      (await owner.patch(FEATURES, { feature: 'artifact_comments', enabled: true }, { params: { projectId: project.id } })).status(200);
    });

    await ctx.step('an html Artifact → 400 not_a_doc on every doc route', async () => {
      (await owner.get(DOC, { params: pageParams })).status(400).body().has('$.code', 'not_a_doc');
      (await owner.post(SEED, { update: SEED_UPDATE, markdown: SEED_MARKDOWN, version: 'v1' }, { params: pageParams })).status(400).body().has('$.code', 'not_a_doc');
      (await owner.post(UPDATES, { update: EDITS[0] }, { params: pageParams })).status(400).body().has('$.code', 'not_a_doc');
      (await owner.post(LEASE, { holder: 'tab-a' }, { params: pageParams })).status(400).body().has('$.code', 'not_a_doc');
      (await owner.post(FLUSHED, { holder: 'tab-a', seq: 1, version: 'v1', markdown: '' }, { params: pageParams })).status(400).body().has('$.code', 'not_a_doc');
      (await owner.post(RESET, { holder: 'tab-a' }, { params: pageParams })).status(400).body().has('$.code', 'not_a_doc');
    });

    await ctx.step('before the seed: GET → seeded:false with no updates, flush or lease; a push or a lease → 409 doc_not_seeded', async () => {
      const empty = await read({ after: '0', base: 'true' });
      if (JSON.stringify(empty) !== JSON.stringify({ seeded: false, epoch: null, latest_seq: 0, updates: [], has_more: false, flushed: null, lease: null })) {
        throw new Error(`unseeded doc read ${JSON.stringify(empty)}`);
      }
      (await owner.post(UPDATES, { update: EDITS[0] }, { params })).status(409).body().has('$.code', 'doc_not_seeded');
      (await owner.post(LEASE, { holder: 'tab-a' }, { params })).status(409).body().has('$.code', 'doc_not_seeded');
    });

    await ctx.step('seed → 201 {seq:1, epoch}; a second seed → 409 doc_seeded; the seed reads back as seq 1 of that epoch, flushed at its version', async () => {
      const seeded = (await owner.post(SEED, { update: SEED_UPDATE, markdown: SEED_MARKDOWN, version: 'v1' }, { params })).status(201).json<{ seq: number; epoch: string }>();
      if (seeded.seq !== 1 || !UUID.test(seeded.epoch)) throw new Error(`seed answered ${JSON.stringify(seeded)}`);
      epoch = seeded.epoch;
      (await owner.post(SEED, { update: SEED_UPDATE, markdown: 'other\n', version: 'v9' }, { params })).status(409).body().has('$.code', 'doc_seeded');
      const doc = await read({ base: 'true' });
      if (!doc.seeded || doc.epoch !== epoch || doc.latest_seq !== 1 || doc.updates.length !== 1 || doc.updates[0]!.update !== SEED_UPDATE) throw new Error(`seeded doc read ${JSON.stringify(doc)}`);
      if (JSON.stringify(doc.flushed) !== JSON.stringify({ seq: 1, version: 'v1', markdown: SEED_MARKDOWN })) throw new Error(`seed flush ${JSON.stringify(doc.flushed)}`);
    });

    await ctx.step('two pushes → seq 2 then seq 3; GET after=0 returns all three in order, after=2 only seq 3, and no Markdown without base', async () => {
      (await owner.post(UPDATES, { update: EDITS[0] }, { params })).status(200).body().has('$.seq', 2);
      (await owner.post(UPDATES, { update: EDITS[1] }, { params })).status(200).body().has('$.seq', 3);
      const all = await read({ after: '0' });
      if (JSON.stringify(all.updates) !== JSON.stringify([{ seq: 1, update: SEED_UPDATE }, { seq: 2, update: EDITS[0] }, { seq: 3, update: EDITS[1] }])) {
        throw new Error(`after=0 read ${JSON.stringify(all.updates)}`);
      }
      if (all.latest_seq !== 3 || all.has_more || all.flushed?.markdown !== undefined) throw new Error(`after=0 read ${JSON.stringify({ ...all, updates: undefined })}`);
      const tail = await read({ after: '2' });
      if (JSON.stringify(tail.updates) !== JSON.stringify([{ seq: 3, update: EDITS[1] }])) throw new Error(`after=2 read ${JSON.stringify(tail.updates)}`);
      if ((await read({ after: '3' })).updates.length !== 0) throw new Error('after=3 returned updates');
      (await owner.get(DOC, { params, query: { after: '-1' } })).status(400);
    });

    await ctx.step('a member who can view but not write in Files: GET → 200, every write → 403 artifact_read_only (as the save route)', async () => {
      const seen = await read({ after: '1' }, asMember);
      if (seen.latest_seq !== 3 || seen.updates.length !== 2) throw new Error(`member read ${JSON.stringify(seen)}`);
      (await asMember.put(ARTIFACT, { files: { 'index.md': { content: 'x' } } }, { params })).status(403).body().has('$.code', 'artifact_read_only');
      (await asMember.post(UPDATES, { update: EDITS[2] }, { params })).status(403).body().has('$.code', 'artifact_read_only');
      (await asMember.post(SEED, { update: SEED_UPDATE, markdown: SEED_MARKDOWN, version: 'v1' }, { params })).status(403).body().has('$.code', 'artifact_read_only');
      (await asMember.post(LEASE, { holder: 'tab-m' }, { params })).status(403).body().has('$.code', 'artifact_read_only');
      (await asMember.post(FLUSHED, { holder: 'tab-m', seq: 3, version: 'v2', markdown: '' }, { params })).status(403).body().has('$.code', 'artifact_read_only');
      (await asMember.post(RESET, { holder: 'tab-m' }, { params })).status(403).body().has('$.code', 'artifact_read_only');
      if ((await read()).latest_seq !== 3) throw new Error('a refused write changed the doc');
    });

    await ctx.step('lease: tab-a acquires for 15 s and renews; tab-b is contested (leader:false, holder tab-a); GET names the holder', async () => {
      const acquired = await lease({ holder: 'tab-a' });
      const ttl = Date.parse(acquired.expires_at ?? '') - Date.now();
      if (!acquired.leader || acquired.holder !== 'tab-a' || ttl < 10_000 || ttl > 16_000) throw new Error(`acquire ${JSON.stringify(acquired)} (ttl ${ttl} ms)`);
      const renewed = await lease({ holder: 'tab-a' });
      if (!renewed.leader || Date.parse(renewed.expires_at!) < Date.parse(acquired.expires_at!)) throw new Error(`renew ${JSON.stringify(renewed)}`);
      const contested = await lease({ holder: 'tab-b' });
      if (contested.leader || contested.holder !== 'tab-a' || contested.expires_at !== renewed.expires_at) throw new Error(`contest ${JSON.stringify(contested)}`);
      const doc = await read();
      if (doc.lease?.holder !== 'tab-a' || doc.lease.expires_at !== renewed.expires_at) throw new Error(`lease read ${JSON.stringify(doc.lease)}`);
      (await owner.post(LEASE, { holder: 'has space' }, { params })).status(400);
    });

    await ctx.step('flushed: a non-holder → 409 not_leader; past the newest seq → 400 invalid_seq; the holder → 409 version_mismatch, because the server reads the file\'s version itself and this seeded doc has no file', async () => {
      (await owner.post(FLUSHED, { holder: 'tab-b', seq: 3, version: 'v2', markdown: FLUSHED_MARKDOWN }, { params })).status(409).body().has('$.code', 'not_leader');
      (await owner.post(FLUSHED, { holder: 'tab-a', seq: 99, version: 'v2', markdown: FLUSHED_MARKDOWN }, { params })).status(400).body().has('$.code', 'invalid_seq');
      // The local stack has no Files storage: the entry version is null, so no claimed version is the file's.
      (await owner.post(FLUSHED, { holder: 'tab-a', seq: 3, version: 'v2', markdown: FLUSHED_MARKDOWN }, { params }))
        .status(409).body().has('$.code', 'version_mismatch').has('$.current_version', null);
      const doc = await read({ after: '3', base: '1' });
      if (JSON.stringify(doc.flushed) !== JSON.stringify({ seq: 1, version: 'v1', markdown: SEED_MARKDOWN })) throw new Error(`a refused flush changed the flush: ${JSON.stringify(doc.flushed)}`);
    });

    await ctx.step('release: tab-b cannot release tab-a; tab-a releases → no lease; tab-b then acquires', async () => {
      const refused = await lease({ holder: 'tab-b', release: true });
      if (refused.leader || refused.holder !== 'tab-a') throw new Error(`foreign release ${JSON.stringify(refused)}`);
      const released = await lease({ holder: 'tab-a', release: true });
      if (released.leader || released.holder !== null || released.expires_at !== null) throw new Error(`release ${JSON.stringify(released)}`);
      if ((await read()).lease !== null) throw new Error('the lease is still listed after its release');
      if (!(await lease({ holder: 'tab-b' })).leader) throw new Error('tab-b could not take a released lease');
    });

    await ctx.step('an update over 512 KiB decoded → 413 update_too_large; a Markdown flush over 1 MiB → 413 markdown_too_large', async () => {
      const oversized = Buffer.alloc(512 * 1024 + 1, 7).toString('base64');
      (await owner.post(UPDATES, { update: oversized }, { params })).status(413).body().has('$.code', 'update_too_large');
      (await owner.post(FLUSHED, { holder: 'tab-b', seq: 3, version: 'v3', markdown: 'x'.repeat(1_048_577) }, { params })).status(413).body().has('$.code', 'markdown_too_large');
      if ((await read()).latest_seq !== 3) throw new Error('a refused update was stored');
    });

    await ctx.step('garbage → 400 invalid_update: not Yjs, truncated, not base64, empty, the self-referencing poison, two clients in one push, and anything but an element at the root (named as the parent, or placed there by an origin)', async () => {
      for (const update of [Buffer.from('not a yjs update').toString('base64'), Buffer.from(EDITS[1]!, 'base64').subarray(0, 10).toString('base64'), '%%%not-base64%%%', '']) {
        (await owner.post(UPDATES, { update }, { params })).status(400).body().has('$.code', 'invalid_update');
      }
      // The 17-byte poison decodes, but would make every client throw for ever.
      (await owner.post(UPDATES, { update: POISON }, { params })).status(400).body().has('$.code', 'invalid_update').has('$.reason', 'self_reference');
      (await owner.post(UPDATES, { update: TWO_CLIENTS }, { params })).status(400).body().has('$.code', 'invalid_update').has('$.reason', 'many_clients');
      // A Yjs sub-document: decoding one builds a whole Y.Doc. Refused byte by byte, before any decode, on a push and on a seed.
      (await owner.post(UPDATES, { update: SUBDOC }, { params })).status(400).body().has('$.code', 'invalid_update').has('$.reason', 'content_not_allowed');
      (await owner.post(SEED, { update: SUBDOC, markdown: '', version: 'v9' }, { params })).status(400).body().has('$.code', 'invalid_update').has('$.reason', 'content_not_allowed');
      // Text at the root of the doc (not inside an element): y-tiptap throws on it when a tab mounts the doc.
      (await owner.post(UPDATES, { update: Buffer.from([1, 1, 77, 0, 4, 1, 7, ...Buffer.from('default'), 1, 0x61, 0]).toString('base64') }, { params })).status(400).body().has('$.code', 'invalid_update').has('$.reason', 'root_not_element');
      // The same, placed by an origin: no parent in the bytes, so the server reads its index of root items.
      (await owner.post(UPDATES, { update: TEXT_AFTER_ROOT_PARAGRAPH }, { params })).status(400).body().has('$.code', 'invalid_update').has('$.reason', 'root_not_element');
      // An origin this doc never held: Yjs would hold the item and place it once that origin arrives, unchecked.
      (await owner.post(UPDATES, { update: ORIGIN_PLACED_TEXT }, { params })).status(400).body().has('$.code', 'invalid_update').has('$.reason', 'unknown_origin');
      // 0x4a: a Skip to applyUpdate, an Item with content ref 10 to Y.mergeUpdates. Only the forms every Yjs reader agrees on pass.
      (await owner.post(UPDATES, { update: Buffer.from([0x01, 0x01, 0x01, 0x00, 0x4a, 0x01, 0x00]).toString('base64') }, { params })).status(400).body().has('$.code', 'invalid_update').has('$.reason', 'malformed');
      if ((await read()).latest_seq !== 3) throw new Error('a refused update was stored');
    });

    await ctx.step('a live socket on the doc hears changed {what:"doc", version:"<seq>"} after a push', async () => {
      const { ticket } = (await owner.post(TICKET, {}, { params })).status(200).json<{ ticket: string }>();
      const socket = await openLive(ctx, project.id, docId, ticket);
      sockets.push(socket);
      live = socket;
      await socket.take((f) => f.t === 'welcome');
      const pushed = (await owner.post(UPDATES, { update: EDITS[2] }, { params })).status(200).json<{ seq: number }>();
      if (pushed.seq !== 4) throw new Error(`the third edit got seq ${pushed.seq}, expected 4`);
      await socket.take((f) => f.t === 'changed' && f.what === 'doc' && f.version === '4');
      const tail = await read({ after: '3' });
      if (JSON.stringify(tail.updates) !== JSON.stringify([{ seq: 4, update: EDITS[2] }])) throw new Error(`after=3 read ${JSON.stringify(tail.updates)}`);
    });

    await ctx.step('past 16 MiB of stored updates a push → 413 doc_too_large and nothing is stored', async () => {
      await withDb(ctx, (db) => db.query(`UPDATE kortix.artifact_doc_state SET bytes_total = $2 WHERE artifact_id = $1`, [docId, 16 * 1024 * 1024 - 2]));
      (await owner.post(UPDATES, { update: EDITS[0] }, { params })).status(413).body().has('$.code', 'doc_too_large');
      if ((await read()).latest_seq !== 4) throw new Error('a refused push was stored');
    });

    await ctx.step('audit: no row for a successful push or a lease renewal, one per person per 10 min for catch-up pulls; a contested lease call, every refused push and every full read keep theirs', async () => {
      const stable = async (action: string, clause?: string) => {
        let last = -1;
        return waitFor(async () => {
          const now = await auditCount(action, clause);
          const settled = now === last;
          last = now;
          return { now, settled };
        }, { until: (r) => r.settled, timeoutMs: 15_000, intervalMs: 1_000, description: `the ${action} audit rows to settle` });
      };
      const before = (await stable('project.artifact.doc.lease')).now;
      for (let i = 0; i < 3; i++) if (!(await lease({ holder: 'tab-b' })).leader) throw new Error('tab-b lost its lease');
      if ((await lease({ holder: 'tab-c' })).leader) throw new Error('tab-c took a live lease');
      const after = (await stable('project.artifact.doc.lease')).now;
      if (after !== before + 1) throw new Error(`lease audit rows went ${before} → ${after}; expected one (the contested call), none for the 3 renewals`);
      const okPushes = await auditCount('project.artifact.doc.push', 'http_status < 400');
      const refusedPushes = await auditCount('project.artifact.doc.push', 'http_status >= 400');
      if (okPushes !== 0 || refusedPushes < 5) throw new Error(`push audit rows: ${okPushes} successful, ${refusedPushes} refused`);
      // Reads: catch-up pulls write one row per person and Artifact per 10 min; a full read (from seq 0) always writes one, as a file read does.
      // The member pulled once (after=1): one row.
      const memberReads = (await stable('project.artifact.doc.read', `http_status = 200 AND actor_user_id = '${member.userId}'`)).now;
      if (memberReads !== 1) throw new Error(`the member's one catch-up pull wrote ${memberReads} doc.read rows, expected 1`);
      // OWNER's first catch-up pull was minutes ago, inside the window: this one writes none.
      const reads = (await stable('project.artifact.doc.read', 'http_status = 200')).now;
      await read({ after: '3' });
      if ((await stable('project.artifact.doc.read', 'http_status = 200')).now !== reads) throw new Error('a second catch-up pull inside 10 min wrote an audit row');
      await read({ after: '0' });
      const full = (await stable('project.artifact.doc.read', 'http_status = 200')).now;
      if (full !== reads + 1) throw new Error(`doc.read rows went ${reads} → ${full} after one full read; expected one more`);
    });

    await ctx.step('reset: another tab while tab-b holds the lease → 409 not_leader; tab-b → 200, the socket hears changed {doc, "0"}, the doc is unseeded, a new seed has a new epoch, and writes naming the old epoch → 409 epoch_mismatch', async () => {
      (await owner.post(RESET, { holder: 'tab-c' }, { params })).status(409).body().has('$.code', 'not_leader');
      (await owner.post(RESET, { holder: 'tab-b' }, { params })).status(200).body().has('$.reset', true);
      await live!.take((f) => f.t === 'changed' && f.what === 'doc' && f.version === '0');
      const gone = await read({ base: 'true' });
      if (gone.seeded || gone.epoch !== null || gone.latest_seq !== 0 || gone.lease !== null) throw new Error(`after reset ${JSON.stringify(gone)}`);
      (await owner.post(UPDATES, { update: EDITS[0] }, { params })).status(409).body().has('$.code', 'doc_not_seeded');
      const again = (await owner.post(SEED, { update: SEED_UPDATE, markdown: SEED_MARKDOWN, version: 'v3' }, { params })).status(201).json<{ seq: number; epoch: string }>();
      if (again.seq !== 1 || !UUID.test(again.epoch) || again.epoch === epoch) throw new Error(`re-seed answered ${JSON.stringify(again)} after epoch ${epoch}`);
      if ((await read()).epoch !== again.epoch) throw new Error('GET does not name the new epoch');
      // A tab still on the old epoch learns of the reset from its next write, not its next pull.
      (await owner.post(UPDATES, { update: EDITS[0], epoch }, { params })).status(409).body().has('$.code', 'epoch_mismatch').has('$.epoch', again.epoch);
      (await owner.post(LEASE, { holder: 'tab-b', epoch }, { params })).status(409).body().has('$.code', 'epoch_mismatch').has('$.epoch', again.epoch);
      (await owner.post(FLUSHED, { holder: 'tab-b', seq: 1, version: 'v3', markdown: SEED_MARKDOWN, epoch }, { params })).status(409).body().has('$.code', 'epoch_mismatch');
      (await owner.post(UPDATES, { update: EDITS[0], epoch: again.epoch }, { params })).status(200).body().has('$.seq', 2);
      if ((await read()).latest_seq !== 2) throw new Error('a stale-epoch write was stored');
    });

    await ctx.step('who wrote: two people push, the lease holder claims a flush of a version the file does not have → 409 version_mismatch and no project.artifact.doc.edit row', async () => {
      if (!(await lease({ holder: 'tab-x' })).leader) throw new Error('tab-x could not take the lease');
      (await asWriter.post(UPDATES, { update: EDITS[1] }, { params })).status(200);
      (await owner.post(UPDATES, { update: EDITS[2] }, { params })).status(200);
      const latest = (await read()).latest_seq;
      for (let i = 0; i < 3; i++) {
        (await owner.post(FLUSHED, { holder: 'tab-x', seq: latest, version: 'v5', markdown: FLUSHED_MARKDOWN }, { params })).status(409).body().has('$.code', 'version_mismatch');
      }
      // A replayed or invented flush writes no edit row. The rows a real flush writes (one per writer, once) are proved by the PostgreSQL suite.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const rows = await withDb(ctx, async (db) => Number((await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM kortix.audit_events WHERE project_id = $1 AND action = 'project.artifact.doc.edit' AND resource_id = $2`,
        [project.id, docId],
      )).rows[0]!.n));
      if (rows !== 0) throw new Error(`${rows} doc.edit rows after refused flushes, expected 0`);
    });

    await ctx.step('a seed counts against the same byte budget as pushes: four 2 MiB seeds at once from one person → a 429 among them', async () => {
      const update = bigTextUpdate(2 * 1024 * 1024 - 64);
      const answers = await Promise.all(Array.from({ length: 4 }, () => asWriter.post(SEED, { update, markdown: '', version: 'v9' }, { params })));
      const statuses = answers.map((a) => a.statusCode).sort();
      if (!statuses.includes(429) || statuses.some((s) => s !== 409 && s !== 429)) throw new Error(`seed statuses ${JSON.stringify(statuses)}, expected 409 (already seeded) and at least one 429`);
      answers.find((a) => a.statusCode === 429)!.status(429).body().has('$.code', 'rate_limited');
    });

    // Last: it empties OWNER's push bucket. The rate check runs before the
    // update is read, so these empty pushes store nothing.
    await ctx.step('pushes past a burst of 240 at more than 60 a second → 429 rate_limited with Retry-After; the doc is unchanged', async () => {
      const statuses = new Map<number, number>();
      let limited: Awaited<ReturnType<typeof owner.post>> | undefined;
      for (let batch = 0; batch < 10 && !limited; batch++) {
        const answers = await Promise.all(Array.from({ length: 100 }, () => owner.post(UPDATES, { update: '' }, { params })));
        for (const answer of answers) statuses.set(answer.statusCode, (statuses.get(answer.statusCode) ?? 0) + 1);
        limited = answers.find((answer) => answer.statusCode === 429);
      }
      if (!limited) throw new Error(`no 429 after ${[...statuses.values()].reduce((a, b) => a + b, 0)} pushes: ${JSON.stringify([...statuses])}`);
      limited.status(429).body().has('$.code', 'rate_limited');
      if (!/^[1-9]\d*$/.test(limited.header('retry-after') ?? '')) throw new Error(`Retry-After ${limited.header('retry-after')}`);
      if ([...statuses.keys()].some((status) => status !== 400 && status !== 429)) throw new Error(`unexpected statuses ${JSON.stringify([...statuses])}`);
      if ((await read()).latest_seq !== 4) throw new Error('a refused push was stored');
    });

    // Last again: it ends the live state. A reset ends every tab's session on the doc, so it is rate-limited per person.
    await ctx.step('resets past 10 a minute from one person → 429 rate_limited with Retry-After', async () => {
      const statuses: number[] = [];
      let limited: Awaited<ReturnType<typeof owner.post>> | undefined;
      for (let i = 0; i < 12 && !limited; i++) {
        const answer = await owner.post(RESET, { holder: 'tab-x' }, { params });
        statuses.push(answer.statusCode);
        if (answer.statusCode === 429) limited = answer;
      }
      if (!limited) throw new Error(`no 429 after ${statuses.length} resets: ${JSON.stringify(statuses)}`);
      limited.status(429).body().has('$.code', 'rate_limited');
      if (!/^[1-9]\d*$/.test(limited.header('retry-after') ?? '')) throw new Error(`Retry-After ${limited.header('retry-after')}`);
      if (statuses.some((s) => s !== 200 && s !== 429)) throw new Error(`reset statuses ${JSON.stringify(statuses)}`);
    });
  } finally {
    for (const socket of sockets) socket.close();
  }
});
