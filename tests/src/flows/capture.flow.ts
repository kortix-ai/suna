/**
 * Kortix Capture — device sign-in (RFC 8628), the credential endpoint,
 * ingestion of the Kortix Capture format (schema 2), the timeline, search,
 * policy, roles, scoping, audit, and the agent tool. Spec:
 * tests/spec/end-to-end.md § Capture. Source of truth: apps/api/src/capture/.
 *
 * Capture's tenant is the Kortix account: no step creates a project except
 * CAP-3, whose agent session (the one edge where Capture meets a project) needs
 * one to run in.
 *
 * Request and response bodies are the engine's (kortix-ai/capture at the commit
 * in tests/fixtures/capture-format-v2/SOURCE.json) and are validated against its
 * vendored JSON Schemas; the device data is its vendored fixture bucket.
 *
 * The local profile's capture store is Supabase Storage's S3 endpoint, which
 * has no STS: `POST /v1/capture/credentials` answers 503 there (CAP-1 asserts
 * it), and CAP-2/3 write as a static-credential device with the S3 protocol
 * keys. Scoped STS credentials (AWS, MinIO) and the range pipelines' model
 * calls are proved outside this profile: the session policy in
 * apps/api/src/capture/credentials.test.ts, the pipelines in
 * apps/api/src/__tests__/integration-capture.test.ts.
 *
 * CAP-4 covers the Capture Intelligence routes. The profile has no model, so the
 * workflow it reviews, drafts and publishes is written as the miner writes it
 * (one SQL insert); the model-made episodes and workflows are measured by the
 * eval harness in apps/api/scripts/capture-intelligence/ against ground truth.
 */
import { flow } from '../core/flow';
import { waitFor } from '../core/poll';
import type { FlowContext, Principal } from '../core/types';
import { AgentPrincipalsWorld, openDb } from '../fixtures/agent-principals';
import { captureSchemaErrors, deleteCaptureObjects, localCaptureStore, readCaptureObject, syntheticMachineKey, uploadCaptureObjects, vendoredDevice, type CaptureSchemaName } from '../fixtures/capture';
import { createHash } from 'node:crypto';
import { CliSandbox } from '../fixtures/cli';

const A = '/v1/accounts/:accountId/capture';
const R = {
  authorize: 'POST /v1/capture/device/authorize',
  token: 'POST /v1/capture/device/token',
  credentials: 'POST /v1/capture/credentials',
  grant: 'GET /v1/capture/device/grants/:user_code',
  approve: 'POST /v1/capture/device/grants/:user_code/approve',
  deny: 'POST /v1/capture/device/grants/:user_code/deny',
  workspace: `GET ${A}`,
  setEnabled: `PATCH ${A}`,
  members: `GET ${A}/members`,
  setRole: `PUT ${A}/members/:userId`,
  devices: `GET ${A}/devices`,
  revoke: `DELETE ${A}/devices/:deviceId`,
  sync: `POST ${A}/devices/:deviceId/sync`,
  devicePolicy: `PUT ${A}/devices/:deviceId/policy`,
  asset: `GET ${A}/devices/:deviceId/assets/:name`,
  policyGet: `GET ${A}/policy`,
  policyPut: `PUT ${A}/policy`,
  timeline: `GET ${A}/timeline`,
  items: `GET ${A}/timeline/items`,
  days: `GET ${A}/days`,
  search: `GET ${A}/search`,
  frame: `GET ${A}/frames/:frameId`,
  media: `GET ${A}/chunks/:chunkId/media`,
  ranges: `GET ${A}/ranges`,
  saveRange: `POST ${A}/ranges`,
  range: `GET ${A}/ranges/:rangeId`,
  process: `POST ${A}/ranges/:rangeId/process`,
  people: `GET ${A}/people`,
  overview: `GET ${A}/overview`,
  workflows: `GET ${A}/workflows`,
  workflow: `GET ${A}/workflows/:workflowId`,
  review: `POST ${A}/workflows/:workflowId/review`,
  skillDraft: `POST ${A}/workflows/:workflowId/skill-draft`,
  skill: `POST ${A}/workflows/:workflowId/skill`,
  episodes: `GET ${A}/episodes`,
  episode: `GET ${A}/episodes/:episodeId`,
  ask: `POST ${A}/ask`,
  exportsCreate: `POST ${A}/exports`,
  exportsList: `GET ${A}/exports`,
  exportGet: `GET ${A}/exports/:exportId`,
  run: `POST ${A}/intelligence/run`,
  fileContent: 'GET /v1/projects/:projectId/files/content',
  meSearch: 'GET /v1/capture/me/search',
  meTimeline: 'GET /v1/capture/me/timeline',
  meFrame: 'GET /v1/capture/me/frames/:frameId',
};
const path = (route: string) => route.split(' ')[1]!;

/** Fail the step when `value` does not match the vendored schema `name`. */
function conforms(name: CaptureSchemaName, value: unknown) {
  const errors = captureSchemaErrors(name, value);
  if (errors) throw new Error(`${name} schema: ${errors} in ${JSON.stringify(value).slice(0, 300)}`);
}

/** The body the engine sends to /device/authorize (issuer.rs `device_info`). */
const engineAuthorize = (machineKey: string, deviceId = '') => ({
  client_id: 'kortix-capture',
  device: { device_id: deviceId, machine_key_sha256: machineKey, hostname: 'fixture-host.local', computer_name: 'Fixture Computer', os: 'macos', os_version: '26.0', arch: 'aarch64', app_version: '0.1.0' },
});

/** A team account (Capture's tenant) with a plain member. No project. */
async function captureAccount(ctx: FlowContext) {
  const team = await ctx.fixtures.team();
  const member = await team.addMember('member');
  return { team, member };
}

/** The account owner turns Capture on for the account. */
async function enableCapture(ctx: FlowContext, accountId: string) {
  (await ctx.client.as(ctx.P.OWNER).patch(path(R.setEnabled), { enabled: true }, { params: { accountId } }))
    .status(200)
    .body()
    .has('$.enabled', true)
    .has('$.role', 'admin');
}

/** The whole device sign-in, approved by `who` into `accountId`. */
async function signInDevice(ctx: FlowContext, who: Principal, accountId: string, machineKey: string) {
  const anon = ctx.client.as(ctx.P.ANON);
  const started = await anon.post(path(R.authorize), engineAuthorize(machineKey));
  started.status(200);
  const grant = started.json<{ device_code: string; user_code: string; interval: number }>();
  (await ctx.client.as(who).post(path(R.approve), { account_id: accountId }, { params: { user_code: grant.user_code } })).status(200);
  const token = await anon.post(path(R.token), { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: grant.device_code, client_id: 'kortix-capture' });
  token.status(200);
  return token.json<{ device_token: string; prefix: string; device_id: string }>();
}

flow(
  'CAP-1',
  {
    domain: 'capture',
    requires: ['database'],
    timeoutMs: 120_000,
    routes: [R.authorize, R.token, R.credentials, R.grant, R.approve, R.deny, R.workspace, R.setEnabled, R.devices, R.revoke],
  },
  async (ctx) => {
    const { team, member } = await captureAccount(ctx);
    const anon = ctx.client.as(ctx.P.ANON);
    const asMember = ctx.client.as(member);
    const accountId = team.id;
    const machineKey = syntheticMachineKey(ctx.fixtures.name('cap1'));
    let grant = { device_code: '', user_code: '' };

    await ctx.step('a sign-in without a sha256 machine key → 400 invalid_request', async () => {
      (await anon.post(path(R.authorize), { machine_key_sha256: 'not-a-key' })).status(400).body().has('$.error', 'invalid_request');
    });

    await ctx.step('the device starts a sign-in with the engine’s body → 200 matching issuer-device-authorization: XXXX-0000 user code, approval URL, interval 5, 900 s', async () => {
      const r = await anon.post(path(R.authorize), engineAuthorize(machineKey));
      r.status(200).body().has('$.interval', 5).has('$.expires_in', 900);
      conforms('issuer-device-authorization', r.json());
      grant = r.json();
      if (!/^[A-Z]{4}-\d{4}$/.test(grant.user_code)) throw new Error(`user code ${grant.user_code}`);
      if (!r.json<{ verification_uri_complete: string }>().verification_uri_complete.endsWith(`/capture/authorize?user_code=${grant.user_code}`)) {
        throw new Error(`verification URL ${r.text()}`);
      }
    });

    await ctx.step('polling before approval → authorization_pending; polling again at once → slow_down', async () => {
      const pending = await anon.post(path(R.token), { device_code: grant.device_code });
      pending.status(400).body().has('$.error', 'authorization_pending');
      conforms('issuer-device-token', pending.json());
      (await anon.post(path(R.token), { device_code: grant.device_code })).status(400).body().has('$.error', 'slow_down');
    });

    await ctx.step('the approval page reads the grant for a signed-in member; anonymous → 401', async () => {
      (await asMember.get(path(R.grant), { params: { user_code: grant.user_code } }))
        .status(200)
        .body()
        .has('$.status', 'pending')
        .has('$.device.name', 'Fixture Computer');
      (await anon.get(path(R.grant), { params: { user_code: grant.user_code } })).status(401);
    });

    await ctx.step('Capture is off for a new account: the member reads the workspace (off, role member, cannot manage); approving and reading → 403 capture_disabled; a member cannot turn it on', async () => {
      (await asMember.get(path(R.workspace), { params: { accountId } }))
        .status(200)
        .body()
        .has('$.enabled', false)
        .has('$.role', 'member')
        .has('$.can_manage', false);
      (await asMember.post(path(R.approve), { account_id: accountId }, { params: { user_code: grant.user_code } }))
        .status(403)
        .body()
        .has('$.code', 'capture_disabled');
      (await asMember.get(path(R.devices), { params: { accountId } })).status(403).body().has('$.code', 'capture_disabled');
      (await asMember.patch(path(R.setEnabled), { enabled: true }, { params: { accountId } })).status(403).body().has('$.code', 'capture_forbidden');
      // The grant read lists only accounts with Capture on: none yet.
      (await asMember.get(path(R.grant), { params: { user_code: grant.user_code } })).status(200).body().has('$.accounts', []);
    });

    await enableCapture(ctx, accountId);
    let device = { device_token: '', prefix: '', device_id: '' };

    await ctx.step('the grant read now lists the account; approving without naming it picks the member’s one account with Capture on → approved; a second decision → 409', async () => {
      (await asMember.get(path(R.grant), { params: { user_code: grant.user_code } }))
        .status(200)
        .body()
        .has('$.accounts[0].account_id', accountId);
      (await asMember.post(path(R.approve), {}, { params: { user_code: grant.user_code } }))
        .status(200)
        .body()
        .has('$.status', 'approved')
        .has('$.account_id', accountId);
      (await asMember.post(path(R.deny), {}, { params: { user_code: grant.user_code } })).status(409);
    });

    await ctx.step('the device exchanges the code once → device token, prefix orgs/<account>, device id; again → invalid_grant', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5_100));
      const r = await anon.post(path(R.token), { device_code: grant.device_code });
      r.status(200).body().has('$.token_type', 'Bearer').has('$.member.email', member.email!);
      conforms('issuer-device-token', r.json());
      device = r.json();
      if (!device.device_token.startsWith('kortix_cap_')) throw new Error('device token prefix');
      if (device.prefix !== `orgs/${accountId}`) throw new Error(`prefix ${device.prefix}`);
      (await anon.post(path(R.token), { device_code: grant.device_code })).status(400).body().has('$.error', 'invalid_grant');
    });

    await ctx.step('credentials: a bad token → 401; the device token on a store without STS → 503 capture_credentials_unavailable', async () => {
      (await anon.withBearer('kortix_cap_nope').post(path(R.credentials))).status(401).body().has('$.code', 'capture_device_unauthorized');
      (await anon.withBearer(device.device_token).post(path(R.credentials))).status(503).body().has('$.code', 'capture_credentials_unavailable');
    });

    await ctx.step('signing in again on the same machine reuses the device (same device_id) and retires the old token', async () => {
      const again = await signInDevice(ctx, member, accountId, machineKey);
      if (again.device_id !== device.device_id) throw new Error(`device ${again.device_id} != ${device.device_id}`);
      (await anon.withBearer(device.device_token).post(path(R.credentials))).status(401);
      device = again;
      const listed = await asMember.get(path(R.devices), { params: { accountId } });
      listed.status(200).body().has('$.devices[0].device_id', device.device_id).has('$.devices[0].name', 'Fixture Computer');
      // Capture keeps no link to the computer agent.
      if ('machine_id' in listed.json<{ devices: Record<string, unknown>[] }>().devices[0]!) throw new Error('machine_id on a capture device');
    });

    await ctx.step('a denied sign-in → the device reads access_denied', async () => {
      const r = await anon.post(path(R.authorize), engineAuthorize(syntheticMachineKey(ctx.fixtures.name('cap1-deny'))));
      const denied = r.json<{ device_code: string; user_code: string }>();
      (await asMember.post(path(R.deny), {}, { params: { user_code: denied.user_code } })).status(200).body().has('$.status', 'denied');
      const refused = await anon.post(path(R.token), { device_code: denied.device_code });
      refused.status(400).body().has('$.error', 'access_denied');
      conforms('issuer-device-token', refused.json());
    });

    await ctx.step('the owner (Capture admin) sees no device of their own, and the member’s with scope=account; the member revokes it and the token → 401', async () => {
      (await ctx.client.as(ctx.P.OWNER).get(path(R.devices), { params: { accountId } })).status(200).body().has('$.devices', []);
      (await ctx.client.as(ctx.P.OWNER).get(path(R.devices), { params: { accountId }, query: { scope: 'account' } }))
        .status(200)
        .body()
        .has('$.devices[0].device_id', device.device_id);
      (await asMember.del(path(R.revoke), { params: { accountId, deviceId: device.device_id } })).status(200);
      (await anon.withBearer(device.device_token).post(path(R.credentials))).status(401);
    });
  },
);

interface Hit {
  kind: string;
  id: string;
  snippet: string;
  chunk_id: string;
}

async function ingestedWorld(ctx: FlowContext, label: string) {
  const { team, member } = await captureAccount(ctx);
  await enableCapture(ctx, team.id);
  const machineKey = syntheticMachineKey(ctx.fixtures.name(label));
  const device = await signInDevice(ctx, member, team.id, machineKey);
  const store = await localCaptureStore();
  // Audio is off by default: turn it on first, so the audio item indexes too.
  (await ctx.client.as(ctx.P.OWNER).put(path(R.policyPut), { policy: { layers: { screen: true, actions: true, audio: true } } }, { params: { accountId: team.id } })).status(200);
  const day = vendoredDevice({ prefix: device.prefix, deviceId: device.device_id, machineKeySha256: machineKey });
  await uploadCaptureObjects(store, day.objects);
  const asMember = ctx.client.as(member);
  // "Sync now": read the device's index and status at once (the local profile runs no leader readers).
  (await asMember.post(path(R.sync), {}, { params: { accountId: team.id, deviceId: device.device_id } }))
    .status(200)
    .body()
    .has('$.enqueued', day.manifestKeys.length);
  await waitFor(
    async () => (await asMember.get(path(R.timeline), { params: { accountId: team.id }, query: { day: day.day } })).json<{ chunks?: unknown[] }>(),
    { until: (t) => (t.chunks?.length ?? 0) >= day.expected.chunks, timeoutMs: 60_000, intervalMs: 1_000, description: 'the job worker to ingest every queued item' },
  );
  return { team, member, device, store, day, asMember };
}

flow(
  'CAP-2',
  {
    domain: 'capture',
    requires: ['database'],
    timeoutMs: 180_000,
    routes: [R.devices, R.sync, R.timeline, R.days, R.items, R.search, R.frame, R.media, R.asset, R.policyGet, R.policyPut, R.devicePolicy, R.ranges, R.saveRange, R.range, R.process, R.people, R.members, R.setRole],
  },
  async (ctx) => {
    const { team, member, device, store, day, asMember } = await ingestedWorld(ctx, 'cap2');
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { accountId: team.id };
    const window = { day: day.day };

    await ctx.step('a second sync finds nothing new; every item of the day is indexed once and the counts match the device output', async () => {
      (await asMember.post(path(R.sync), {}, { params: { ...params, deviceId: device.device_id } })).status(200).body().has('$.enqueued', 0);
      const t = (await asMember.get(path(R.timeline), { params, query: window })).status(200).json<any>();
      if (t.chunks.length !== day.expected.chunks) throw new Error(`chunks ${t.chunks.length} != ${day.expected.chunks}`);
      const frames = t.chunks.filter((c: any) => c.kind === 'chunk').reduce((n: number, c: any) => n + c.item_count, 0);
      const actions = t.chunks.filter((c: any) => c.kind === 'actions').reduce((n: number, c: any) => n + c.item_count, 0);
      const audio = t.chunks.filter((c: any) => c.kind === 'audio').reduce((n: number, c: any) => n + c.item_count, 0);
      if (frames !== day.expected.frames || actions !== day.expected.actions || audio !== day.expected.audioLines) {
        throw new Error(`frames ${frames}, actions ${actions}, audio ${audio} vs ${JSON.stringify(day.expected)}`);
      }
      const apps = t.runs.map((r: any) => r.app);
      if (!apps.includes('Editor')) throw new Error(`no Editor run in ${apps}`);
    });

    await ctx.step('the recorded days list the member’s day (newest first) with its last moment; a bad tz → 400; another member → 403', async () => {
      const tz = 'Europe/Berlin';
      const localDay = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(ms));
      const days = (await asMember.get(path(R.days), { params, query: { tz } })).status(200).json<{ tz: string; days: any[] }>();
      const expected = [...new Set([localDay(day.endMs), localDay(day.startMs)])];
      if (days.tz !== tz || JSON.stringify(days.days.map((d) => d.day)) !== JSON.stringify(expected)) throw new Error(`days ${JSON.stringify(days)}`);
      if (days.days[0].end_at !== new Date(day.endMs).toISOString()) throw new Error(`last moment ${days.days[0].end_at}`);
      if (!(days.days.reduce((n: number, d: any) => n + d.screen_seconds, 0) > 0)) throw new Error(`screen seconds ${JSON.stringify(days.days)}`);
      (await asMember.get(path(R.days), { params, query: { device_id: device.device_id } })).status(200).body().has('$.tz', 'UTC');
      (await asMember.get(path(R.days), { params, query: { tz: 'Mars/Olympus' } })).status(400).body().has('$.code', 'capture_bad_window');
      (await asMember.get(path(R.days), { params, query: { user_id: ctx.P.OWNER.userId! } })).status(403).body().has('$.code', 'capture_forbidden');
    });

    await ctx.step('the device reads as recording from its status.json; its minute of activity is one detected range', async () => {
      (await asMember.get(path(R.devices), { params })).status(200).body().has('$.devices[0].live.state', 'recording');
      const ranges = (await asMember.get(path(R.ranges), { params, query: window })).status(200).json<{ ranges: any[] }>().ranges;
      if (ranges.filter((r) => r.source === 'detected').length !== day.expected.ranges) throw new Error(`ranges ${JSON.stringify(ranges)}`);
    });

    let hits: Hit[] = [];
    await ctx.step('one search finds the fixture words on screen, in a typed action and in the audio transcript', async () => {
      const r = await asMember.get(path(R.search), { params, query: { q: 'quarterly or roadmap', limit: 50 } });
      r.status(200);
      hits = r.json<{ hits: Hit[] }>().hits;
      for (const [kind, word] of [['screen', 'quarterly roadmap'], ['actions', 'quarterly plan'], ['audio', 'roadmap on friday']] as const) {
        if (!hits.some((h) => h.kind === kind && h.snippet.toLowerCase().includes(word))) throw new Error(`no ${kind} hit: ${JSON.stringify(hits).slice(0, 400)}`);
      }
      (await asMember.get(path(R.search), { params, query: { q: '"incident review"', kinds: 'screen' } })).status(200).body().has('$.hits[0].app', 'Editor');
    });

    await ctx.step('a frame opens with its full on-screen text, a signed URL whose bytes match the uploaded video, and offset_ms = frame_index seconds', async () => {
      const frameId = hits.find((h) => h.kind === 'screen')!.id;
      const detail = (await asMember.get(path(R.frame), { params: { ...params, frameId } })).status(200).json<any>();
      if (!detail.frame.ocr_text.includes('quarterly roadmap')) throw new Error('frame text');
      // The chunk video is 1 fps, frame i at t = i s: the seek position is the frame index.
      if (detail.video.offset_ms !== detail.frame.frame_index * 1000) throw new Error(`offset_ms ${detail.video.offset_ms} for frame_index ${detail.frame.frame_index}`);
      const video = await fetch(detail.video.url);
      const uploaded = day.objects.find((o) => o.key.endsWith('.mp4') && detail.video.url.includes(o.key.split('/').pop()!))!;
      const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
      if (video.status !== 200 || sha(new Uint8Array(await video.arrayBuffer())) !== sha(uploaded.body)) throw new Error(`video GET ${video.status}`);
      (await asMember.get(path(R.media), { params: { ...params, chunkId: detail.frame.chunk_id } })).status(200).body().has('$.kind', 'chunk');
      const items = (await asMember.get(path(R.items), { params, query: { day: day.day } })).status(200).json<any>();
      const shot = items.actions.find((a: any) => a.screenshot)?.screenshot;
      const asset = (await asMember.get(path(R.asset), { params: { ...params, deviceId: device.device_id, name: shot } })).status(200).json<{ url: string }>();
      if ((await fetch(asset.url)).status !== 200) throw new Error('asset URL');
    });

    await ctx.step('scoping: the member cannot read the owner or the account; the owner reads the member → 200 and a capture.member_view audit row', async () => {
      (await asMember.get(path(R.timeline), { params, query: { user_id: ctx.P.OWNER.userId! } })).status(403).body().has('$.code', 'capture_forbidden');
      (await asMember.get(path(R.people), { params })).status(403);
      (await asMember.get(path(R.devices), { params, query: { scope: 'account' } })).status(403);
      (await owner.get(path(R.search), { params, query: { q: 'roadmap', user_id: member.userId! } })).status(200);
      const db = await openDb(ctx);
      try {
        const rows = await waitFor(
          async () => (await db.query<{ n: string }>(`SELECT count(*) AS n FROM kortix.audit_events WHERE account_id = $1 AND action = 'capture.member_view' AND actor_user_id = $2 AND resource_id = $3`, [team.id, ctx.P.OWNER.userId, member.userId])).rows[0]!.n,
          { until: (n) => Number(n) >= 1, timeoutMs: 15_000, intervalMs: 500, description: 'the member_view audit row' },
        );
        if (Number(rows) < 1) throw new Error('no audit row');
      } finally {
        await db.end();
      }
    });

    await ctx.step('the people summary (owner) gives the member active time per app; it is audited as capture.account_view', async () => {
      const people = (await owner.get(path(R.people), { params, query: window })).status(200).json<{ people: any[] }>().people;
      const row = people.find((p) => p.user_id === member.userId);
      if (!row || row.active_seconds <= 0 || !row.apps.some((a: any) => a.app === 'Editor')) throw new Error(`people ${JSON.stringify(people)}`);
      const db = await openDb(ctx);
      try {
        const n = await waitFor(
          async () => Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM kortix.audit_events WHERE account_id = $1 AND action = 'capture.account_view' AND actor_user_id = $2`, [team.id, ctx.P.OWNER.userId])).rows[0]!.n),
          { until: (count) => count >= 1, timeoutMs: 15_000, intervalMs: 500, description: 'the account_view audit row' },
        );
        if (n < 1) throw new Error('no account_view row');
      } finally {
        await db.end();
      }
    });

    await ctx.step('roles: the owner lists Capture roles (owner admin, member member); a viewer override lets the member read the owner and People, a member cannot change roles, clearing it takes the reads away', async () => {
      const members = (await owner.get(path(R.members), { params })).status(200).json<{ members: any[] }>().members;
      const roleOf = (userId: string) => members.find((m) => m.user_id === userId)?.role;
      if (roleOf(ctx.P.OWNER.userId!) !== 'admin' || roleOf(member.userId!) !== 'member') throw new Error(`roles ${JSON.stringify(members)}`);
      (await asMember.get(path(R.members), { params })).status(403);
      (await asMember.put(path(R.setRole), { role: 'admin' }, { params: { ...params, userId: member.userId! } })).status(403);
      (await owner.put(path(R.setRole), { role: 'viewer' }, { params: { ...params, userId: member.userId! } }))
        .status(200)
        .body()
        .has('$.role', 'viewer')
        .has('$.overridden', true);
      (await asMember.get(path(R.people), { params, query: window })).status(200);
      (await asMember.get(path(R.timeline), { params, query: { user_id: ctx.P.OWNER.userId! } })).status(200);
      // A viewer writes nothing.
      (await asMember.put(path(R.policyPut), { policy: { layers: { screen: true, actions: true, audio: true } } }, { params })).status(403);
      (await owner.put(path(R.setRole), { role: null }, { params: { ...params, userId: member.userId! } }))
        .status(200)
        .body()
        .has('$.role', 'member')
        .has('$.overridden', false);
      (await asMember.get(path(R.people), { params })).status(403);
    });

    await ctx.step('policy: a member cannot write it; the owner writes it and the device reads the same policy.json from the store', async () => {
      const policy = { layers: { screen: true, actions: false, audio: false }, retention: { local_hours: 24, remote_days: 30 }, notice: 'Synthetic notice' };
      (await asMember.put(path(R.policyPut), { policy }, { params })).status(403);
      (await owner.put(path(R.policyPut), { policy: { retention: { local_hours: 0, remote_days: -1 } } }, { params })).status(400).body().has('$.code', 'capture_policy_invalid');
      (await owner.put(path(R.policyPut), { policy }, { params })).status(200).body().has('$.policy.layers.actions', false);
      (await asMember.get(path(R.policyGet), { params })).status(200).body().has('$.policy.notice', 'Synthetic notice');
      const doc = JSON.parse((await readCaptureObject(store, `${device.prefix}/policy.json`)) ?? '{}');
      conforms('policy', doc);
      if (doc.schema !== 2 || doc.layers.actions !== false || doc.notice !== 'Synthetic notice') throw new Error(`policy.json ${JSON.stringify(doc)}`);
      (await owner.put(path(R.devicePolicy), { policy: { recording: { paused: true, paused_until_ms: null } } }, { params: { ...params, deviceId: device.device_id } }))
        .status(200)
        .body()
        .has('$.policy_override.recording.paused', true);
      const override = JSON.parse((await readCaptureObject(store, `${device.prefix}/${device.device_id}/policy.json`)) ?? '{}');
      conforms('policy', override);
      if (override.recording?.paused !== true) throw new Error('device policy.json');
      (await owner.put(path(R.devicePolicy), { policy: null }, { params: { ...params, deviceId: device.device_id } })).status(200).body().has('$.policy_override', null);
      if ((await readCaptureObject(store, `${device.prefix}/${device.device_id}/policy.json`)) !== null) throw new Error('override not removed');
    });

    await ctx.step('a member saves a range of their own time → 201 closed and queued; it reads back with its outputs list; reprocess → 202', async () => {
      const saved = await asMember.post(path(R.saveRange), { start_at: new Date(day.startMs).toISOString(), end_at: new Date(day.endMs).toISOString(), title: 'Budget review' }, { params });
      saved.status(201).body().has('$.source', 'saved').has('$.title', 'Budget review');
      const rangeId = saved.json<{ range_id: string }>().range_id;
      (await asMember.get(path(R.range), { params: { ...params, rangeId } })).status(200).body().has('$.range_id', rangeId);
      (await asMember.post(path(R.process), {}, { params: { ...params, rangeId } })).status(202).body().has('$.queued', true);
      (await asMember.post(path(R.saveRange), { start_at: '2026-01-02T00:00:00Z', end_at: '2026-01-01T00:00:00Z' }, { params })).status(400);
    });

    await ctx.step('the device forgets its audio item (objects deleted, a delete line appended) → sync retracts it: forgotten 1, the transcript no longer matches', async () => {
      const audioKey = day.manifestKeys.find((key) => /-a\d+\.manifest\.json$/.test(key))!;
      const base = audioKey.slice(device.prefix.length + 1, -'.manifest.json'.length);
      await deleteCaptureObjects(store, day.objects.filter((o) => o.key.startsWith(`${device.prefix}/${base}.`)).map((o) => o.key));
      const index = day.objects.find((o) => o.key.includes(`/${device.device_id}/index/`))!;
      const line = { op: 'delete', kind: 'audio', base, reason: 'forget', at_ms: Date.now() };
      conforms('index-line', line);
      const body = new TextEncoder().encode(`${new TextDecoder().decode(index.body)}${JSON.stringify(line)}\n`);
      await uploadCaptureObjects(store, [{ ...index, body }]);
      (await asMember.post(path(R.sync), {}, { params: { ...params, deviceId: device.device_id } })).status(200).body().has('$.forgotten', 1).has('$.enqueued', 0);
      const after = (await asMember.get(path(R.search), { params, query: { q: 'quarterly or roadmap', limit: 50 } })).status(200).json<{ hits: Hit[] }>().hits;
      if (after.some((h) => h.kind === 'audio')) throw new Error(`audio hit survived the forget: ${JSON.stringify(after).slice(0, 300)}`);
      if (!after.some((h) => h.kind === 'screen')) throw new Error('the screen hits went with it');
      (await asMember.post(path(R.sync), {}, { params: { ...params, deviceId: device.device_id } })).status(200).body().has('$.forgotten', 0);
    });
  },
);

flow(
  'CAP-3',
  {
    domain: 'capture',
    requires: ['database'],
    timeoutMs: 240_000,
    routes: [R.meSearch, R.meTimeline, R.meFrame, R.search],
  },
  async (ctx) => {
    const { team, member } = await ingestedWorld(ctx, 'cap3');
    // The agent edge: an agent session runs in some project of the account (it
    // needs a manifest commit, so a managed Git project). Capture itself never
    // sees the project.
    const project = await team.project({ managedGit: true });
    await team.grantProjectRole(project.id, member.userId!, 'member');
    const marker = 'quarterly';
    const world = await AgentPrincipalsWorld.open(ctx, { accountId: team.id, projectId: project.id });
    const sandbox = new CliSandbox('cap3');
    try {
      await world.writeManifest(
        'kortix_version: 2\nproject:\n  name: ke2e-capture\ndefault_agent: kortix\nagents:\n  kortix:\n    kortix_permissions: all\n',
        'ke2e: capture agent',
      );
      const own = await world.mintAgentSession({ agent: 'kortix', launcher: member });
      const shared = await world.mintAgentSession({ agent: 'kortix', launcher: member, visibility: 'project' });
      const trigger = await world.mintAgentSession({ agent: 'kortix', launcher: null });

      await ctx.step('an agent in the member’s private session searches the member’s timeline through /capture/me → their hits, audited as capture.agent_read', async () => {
        const r = await own.client.get(path(R.meSearch), { query: { q: marker } });
        r.status(200).body().has('$.user_id', member.userId!);
        if (r.json<{ hits: Hit[] }>().hits.length === 0) throw new Error('no hits for the agent');
      });

      await ctx.step('the agent cannot reach the account routes (its token is project-scoped); a shared or trigger session has no person → 403', async () => {
        (await own.client.get(path(R.search), { params: { accountId: team.id }, query: { q: marker } })).status(403);
        (await shared.client.get(path(R.meSearch), { query: { q: marker } })).status(403).body().has('$.code', 'capture_no_human');
        (await trigger.client.get(path(R.meTimeline), { query: { day: '2026-10-01' } })).status(403).body().has('$.code', 'capture_no_human');
      });

      await ctx.step('real CLI inside the session: `kortix capture search <marker> --json` exits 0 with the member’s hits; `capture frame` prints the text', async () => {
        const env = { KORTIX_TOKEN: own.secret, KORTIX_API_URL: ctx.env.apiUrl, KORTIX_PROJECT_ID: project.id, KORTIX_SESSION_ID: own.sessionId };
        const searched = await sandbox.run(['capture', 'search', marker, '--json'], { env });
        if (searched.exitCode !== 0) throw new Error(`capture search exit ${searched.exitCode}: ${searched.all.slice(0, 600)}`);
        const result = JSON.parse(searched.stdout.trim()) as { user_id: string; hits: Hit[] };
        if (result.user_id !== member.userId || result.hits.length === 0) throw new Error(`unexpected ${searched.stdout.slice(0, 400)}`);
        const frameId = result.hits.find((h) => h.kind === 'screen')!.id;
        const frame = await sandbox.run(['capture', 'frame', frameId], { env });
        if (frame.exitCode !== 0 || !frame.stdout.includes('quarterly roadmap')) throw new Error(`capture frame: ${frame.all.slice(0, 400)}`);
      });

      await ctx.step('each agent read wrote a capture.agent_read row for the member', async () => {
        const db = await openDb(ctx);
        try {
          const n = await waitFor(
            async () => Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM kortix.audit_events WHERE account_id = $1 AND action = 'capture.agent_read' AND resource_id = $2`, [team.id, member.userId])).rows[0]!.n),
            { until: (count) => count >= 2, timeoutMs: 15_000, intervalMs: 500, description: 'capture.agent_read rows' },
          );
          if (n < 2) throw new Error(`agent_read rows ${n}`);
        } finally {
          await db.end();
        }
      });
    } finally {
      sandbox.dispose();
      await world.close();
    }
  },
);

flow(
  'CAP-4',
  {
    domain: 'capture',
    requires: ['database'],
    timeoutMs: 180_000,
    routes: [R.overview, R.workflows, R.workflow, R.review, R.skillDraft, R.skill, R.episodes, R.episode, R.ask, R.exportsCreate, R.exportsList, R.exportGet, R.run, R.saveRange, R.fileContent],
  },
  async (ctx) => {
    const { team, member, day, asMember } = await ingestedWorld(ctx, 'cap4');
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { accountId: team.id };
    let episodeId = '';
    let workflowId = '';

    await ctx.step('overview and workflows are for Capture admins and viewers: the owner → 200 with zero workflows; the member → 403 capture_forbidden', async () => {
      (await owner.get(path(R.overview), { params })).status(200).body().has('$.workflows.total', 0);
      (await owner.get(path(R.workflows), { params })).status(200).body().has('$.counts.all', 0);
      (await asMember.get(path(R.overview), { params })).status(403).body().has('$.code', 'capture_forbidden');
      (await asMember.get(path(R.workflows), { params })).status(403).body().has('$.code', 'capture_forbidden');
    });

    await ctx.step('a saved range is a pinned episode: the member lists it (source saved, label = title, closed) and opens it with no steps; the owner sees it account-wide', async () => {
      (await asMember.post(path(R.saveRange), { start_at: new Date(day.startMs).toISOString(), end_at: new Date(day.endMs).toISOString(), title: 'Quarterly close' }, { params })).status(201);
      const mine = (await asMember.get(path(R.episodes), { params })).status(200).json<{ episodes: Array<{ episode_id: string; source: string; label: string; status: string; user_id: string }> }>().episodes;
      const pinned = mine.find((e) => e.source === 'saved' && e.label === 'Quarterly close');
      if (!pinned || pinned.status !== 'closed' || pinned.user_id !== member.userId) throw new Error(`pinned episode: ${JSON.stringify(mine).slice(0, 300)}`);
      episodeId = pinned.episode_id;
      (await asMember.get(path(R.episode), { params: { ...params, episodeId } })).status(200).body().has('$.episode_id', episodeId).has('$.steps', []);
      const all = (await owner.get(path(R.episodes), { params, query: { scope: 'account' } })).status(200).json<{ episodes: Array<{ episode_id: string }> }>().episodes;
      if (!all.some((e) => e.episode_id === episodeId)) throw new Error('the owner does not see the member episode account-wide');
      (await asMember.get(path(R.episodes), { params, query: { scope: 'account' } })).status(403);
    });

    await ctx.step('run the pipelines: the member → 403; the owner → 202, mining queued (the open range has nothing to trace yet)', async () => {
      (await asMember.post(path(R.run), {}, { params })).status(403);
      (await owner.post(path(R.run), {}, { params })).status(202).body().has('$.episodes_queued', 0).has('$.mining_queued', true);
      (await owner.post(path(R.run), { mining_only: true }, { params })).status(202).body().has('$.mining_queued', true);
    });

    await ctx.step('a mined workflow (as the miner writes it) lists with its stats; the detail has steps, variants and people; the member → 403', async () => {
      const db = await openDb(ctx);
      try {
        const steps = [
          { index: 1, verb: 'Open', object: 'expense report', app: 'Billing', params: null, variables: ['expense_id'], decision: null },
          { index: 2, verb: 'Read', object: 'receipts', app: 'Billing', params: null, variables: [], decision: { question: 'a receipt is missing', variant: 'B', share: 0.25 } },
          { index: 3, verb: 'Approve', object: 'expense report', app: 'Billing', params: 'Expenses', variables: ['expense_total'], decision: null },
        ];
        const variants = [
          { key: 'A', name: 'Canonical path', runs: 6, share: 0.75, steps_count: 3, differs: [], note: 'The most common path.' },
          { key: 'B', name: 'Missing receipt', runs: 2, share: 0.25, steps_count: 3, differs: [3], note: 'Rejects the report with a note.', question: 'a receipt is missing' },
        ];
        const row = await db.query<{ workflow_id: string }>(
          `INSERT INTO kortix.capture_workflows (account_id, name, goal, outcome, signature, steps, variants, apps, runs_total, runs_per_week, duration_p50_s, duration_p90_s, people_count, success_rate, determinism, automation_hours_per_week, first_seen_at, last_seen_at, model)
           VALUES ($1, 'Approve an expense report', 'Approve a colleague expense report after checking its receipts', 'The report is approved', 'open@billing read@billing approve@billing', $2, $3, '["Billing"]', 8, 4, 300, 420, 1, 1, 1, 0.33, now() - interval '7 days', now(), 'scripted') RETURNING workflow_id`,
          [team.id, JSON.stringify(steps), JSON.stringify(variants)],
        );
        workflowId = row.rows[0]!.workflow_id;
        await db.query(`UPDATE kortix.capture_episodes SET workflow_id = $1, variant_key = 'A' WHERE episode_id = $2`, [workflowId, episodeId]);
      } finally {
        await db.end();
      }
      (await owner.get(path(R.workflows), { params, query: { sort: 'hours' } })).status(200).body().has('$.counts.detected', 1).has('$.workflows[0].workflow_id', workflowId).has('$.workflows[0].runs_total', 8);
      const detail = (await owner.get(path(R.workflow), { params: { ...params, workflowId } })).status(200).json<{ steps: unknown[]; variants: unknown[]; people: Array<{ user_id: string }> }>();
      if (detail.steps.length !== 3 || detail.variants.length !== 2 || detail.people[0]?.user_id !== member.userId) throw new Error(`detail: ${JSON.stringify(detail).slice(0, 300)}`);
      (await asMember.get(path(R.workflow), { params: { ...params, workflowId } })).status(403);
    });

    await ctx.step('review renames it and marks it reviewed (member → 403); the skill draft reads the same row: its name, steps, the condition on the decision, 8 runs, clean checks', async () => {
      (await asMember.post(path(R.review), { name: 'x' }, { params: { ...params, workflowId } })).status(403);
      (await owner.post(path(R.review), { name: 'Approve a colleague expense report' }, { params: { ...params, workflowId } })).status(200).body().has('$.status', 'reviewed').has('$.name', 'Approve a colleague expense report');
      const draft = (await owner.post(path(R.skillDraft), {}, { params: { ...params, workflowId } })).status(200).json<{ name: string; markdown: string; inputs: string[]; checks: Array<{ ok: boolean; label: string }>; workflow_updated_at: string }>();
      if (draft.name !== 'approve-a-colleague-expense-report') throw new Error(`draft name ${draft.name}`);
      for (const text of ['If a receipt is missing, follow variant B (Missing receipt) below.', '3. Approve expense report ({expense_total}) in Billing › Expenses.', 'Learned from 8 recorded runs']) {
        if (!draft.markdown.includes(text)) throw new Error(`draft lacks "${text}":\n${draft.markdown}`);
      }
      if (draft.checks.some((c) => !c.ok) || !draft.workflow_updated_at) throw new Error(`draft checks: ${JSON.stringify(draft.checks)}`);
    });

    await ctx.step('publishing the skill commits skills/<name>/SKILL.md to a project of the account (the file reads back); a bad name → 400; a project of another account → 404', async () => {
      const project = await team.project({ managedGit: true });
      const markdown = '---\nname: approve-a-colleague-expense-report\ndescription: "Approve expense reports"\n---\n\n# Approve a colleague expense report\n';
      (await owner.post(path(R.skill), { project_id: project.id, name: 'Bad Name', markdown }, { params: { ...params, workflowId } })).status(400).body().has('$.code', 'capture_bad_skill_name');
      const other = await ctx.fixtures.project({ managedGit: true });
      (await owner.post(path(R.skill), { project_id: other.id, name: 'approve-a-colleague-expense-report', markdown }, { params: { ...params, workflowId } })).status(404);
      (await owner.post(path(R.skill), { project_id: project.id, name: 'approve-a-colleague-expense-report', markdown }, { params: { ...params, workflowId } }))
        .status(200)
        .body()
        .has('$.status', 'exported')
        .has('$.skill.path', 'skills/approve-a-colleague-expense-report/SKILL.md');
      const file = await waitFor(
        async () => owner.get(path(R.fileContent), { params: { projectId: project.id }, query: { path: 'skills/approve-a-colleague-expense-report/SKILL.md' } }),
        { until: (r) => r.statusCode === 200, timeoutMs: 30_000, intervalMs: 1_000, description: 'the published SKILL.md in the project' },
      );
      if (!String(file.json<{ content: string }>().content).includes('# Approve a colleague expense report')) throw new Error('SKILL.md content');
      (await owner.get(path(R.workflow), { params: { ...params, workflowId } })).status(200).body().has('$.status', 'exported');
    });

    await ctx.step('bulk export: Parquet of two tables → 400 capture_export_one_table; Parquet of workflows → a PAR1 file; the member → 403; the owner exports JSONL, polls it to done, and the signed download holds the workflow and the pinned episode', async () => {
      (await owner.post(path(R.exportsCreate), { format: 'parquet', include: ['episodes', 'workflows'] }, { params })).status(400).body().has('$.code', 'capture_export_one_table');
      const pq = (await owner.post(path(R.exportsCreate), { format: 'parquet', include: ['workflows'] }, { params })).status(202).json<{ export_id: string }>();
      const pqDone = await waitFor(
        async () => (await owner.get(path(R.exportGet), { params: { ...params, exportId: pq.export_id } })).json<{ status: string; rows: number; download: { url: string } | null }>(),
        { until: (e) => e.status === 'done' || e.status === 'failed', timeoutMs: 60_000, intervalMs: 1_000, description: 'the parquet export job' },
      );
      if (pqDone.status !== 'done' || pqDone.rows !== 1 || !pqDone.download?.url) throw new Error(`parquet export: ${JSON.stringify(pqDone)}`);
      const head = new TextDecoder().decode(new Uint8Array(await (await fetch(pqDone.download.url)).arrayBuffer()).slice(0, 4));
      if (head !== 'PAR1') throw new Error(`parquet magic: ${head}`);
      (await asMember.post(path(R.exportsCreate), { format: 'jsonl' }, { params })).status(403);
      const created = (await owner.post(path(R.exportsCreate), { format: 'jsonl' }, { params })).status(202).json<{ export_id: string }>();
      const done = await waitFor(
        async () => (await owner.get(path(R.exportGet), { params: { ...params, exportId: created.export_id } })).json<{ status: string; rows: number; download: { url: string } | null }>(),
        { until: (e) => e.status === 'done' || e.status === 'failed', timeoutMs: 60_000, intervalMs: 1_000, description: 'the export job' },
      );
      if (done.status !== 'done' || !done.download?.url) throw new Error(`export: ${JSON.stringify(done)}`);
      const lines = (await (await fetch(done.download.url)).text()).trim().split('\n').map((l) => JSON.parse(l) as { type: string; workflow_id?: string; episode_id?: string });
      if (!lines.some((l) => l.type === 'workflow' && l.workflow_id === workflowId) || !lines.some((l) => l.type === 'episode' && l.episode_id === episodeId)) throw new Error(`export lines: ${lines.length}`);
      const listed = (await owner.get(path(R.exportsList), { params })).status(200).json<{ exports: Array<{ export_id: string }> }>().exports;
      if (!listed.some((e) => e.export_id === created.export_id)) throw new Error('export not listed');
    });

    await ctx.step('ask streams server-sent events: the sources event first (the pinned episode among them), then done or a typed error (this profile has no model); a member cannot ask account-wide', async () => {
      const res = (await asMember.post(path(R.ask), { question: 'What did I do in the quarterly close?' }, { params })).status(200);
      if (!res.header('content-type')?.includes('text/event-stream')) throw new Error(`content-type ${res.header('content-type')}`);
      const events = res.text().split('\n\n').filter((f) => f.startsWith('data: ')).map((f) => JSON.parse(f.slice(6)) as { type: string; sources?: Array<{ kind: string; episode_id?: string }>; code?: string });
      if (events[0]?.type !== 'sources' || !events[0].sources?.some((s) => s.kind === 'episode' && s.episode_id === episodeId)) throw new Error(`first event: ${JSON.stringify(events[0]).slice(0, 300)}`);
      const last = events[events.length - 1]!;
      if (last.type !== 'done' && !(last.type === 'error' && last.code)) throw new Error(`last event: ${JSON.stringify(last)}`);
      (await asMember.post(path(R.ask), { question: 'Who works on what?', scope: { user_id: ctx.P.OWNER.userId! } }, { params })).status(403);
    });
  },
);
