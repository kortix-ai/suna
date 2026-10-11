/**
 * Kortix Capture v1, raw capture — device sign-in (RFC 8628), the credential
 * endpoint, ingestion of the Kortix Capture format (schema 2), the timeline,
 * search, media, policy, IAM scoping (`capture.read_all`, `capture.manage`),
 * audit, forget, the agent tool and the API-key data API. Spec:
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
 * keys. Scoped STS credentials (AWS, MinIO) are proved outside this profile:
 * the session policy in apps/api/src/capture/credentials.test.ts.
 *
 * Ingestion: the flows upload, then ask the API to read the device's index now
 * (`POST …/devices/:deviceId/sync`, what the index reader does every
 * KORTIX_CAPTURE_INDEX_POLL_SECONDS on a leader; the local profile runs no
 * leader loops) and wait until the timeline shows the items (`awaitIndexed`).
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
  devices: `GET ${A}/devices`,
  revoke: `DELETE ${A}/devices/:deviceId`,
  sync: `POST ${A}/devices/:deviceId/sync`,
  asset: `GET ${A}/devices/:deviceId/assets/:name`,
  policyGet: `GET ${A}/policy`,
  policyPut: `PUT ${A}/policy`,
  timeline: `GET ${A}/timeline`,
  items: `GET ${A}/timeline/items`,
  days: `GET ${A}/days`,
  search: `GET ${A}/search`,
  frame: `GET ${A}/frames/:frameId`,
  media: `GET ${A}/chunks/:chunkId/media`,
  tokens: 'POST /v1/accounts/tokens',
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

/** The account owner (IAM `capture.manage` by default) turns Capture on for the account. */
async function enableCapture(ctx: FlowContext, accountId: string) {
  (await ctx.client.as(ctx.P.OWNER).patch(path(R.setEnabled), { enabled: true }, { params: { accountId } }))
    .status(200)
    .body()
    .has('$.enabled', true)
    .has('$.can_read_all', true)
    .has('$.can_manage', true);
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

    await ctx.step('Capture is off for a new account: the member reads the workspace (off, cannot read all, cannot manage); approving and reading → 403 capture_disabled; a member cannot turn it on', async () => {
      (await asMember.get(path(R.workspace), { params: { accountId } }))
        .status(200)
        .body()
        .has('$.enabled', false)
        .has('$.can_read_all', false)
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

    await ctx.step('the owner (capture.read_all) sees no device of their own, and the member’s with scope=account; the member revokes it and the token → 401', async () => {
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
  await awaitIndexed(ctx, asMember, team.id, device.device_id, day.day, (t) => (t.chunks?.length ?? 0) >= day.expected.chunks, 'every item to index');
  return { team, member, device, store, day, asMember };
}

/**
 * Read the device's index now (the sync route queues every new item and
 * retracts every deleted one), then wait until the member's timeline of `day`
 * satisfies `until` while the job worker indexes.
 */
async function awaitIndexed(
  ctx: FlowContext,
  asMember: ReturnType<FlowContext['client']['as']>,
  accountId: string,
  deviceId: string,
  day: string,
  until: (timeline: { chunks?: Array<{ kind: string }> }) => boolean,
  description: string,
) {
  (await asMember.post(path(R.sync), {}, { params: { accountId, deviceId } })).status(200);
  return waitFor(
    async () => (await asMember.get(path(R.timeline), { params: { accountId }, query: { day } })).json<{ chunks?: Array<{ kind: string }> }>(),
    { until, timeoutMs: 90_000, intervalMs: 1_000, description },
  );
}

flow(
  'CAP-2',
  {
    domain: 'capture',
    requires: ['database'],
    timeoutMs: 180_000,
    routes: [R.devices, R.sync, R.timeline, R.days, R.items, R.search, R.frame, R.media, R.asset, R.policyGet, R.policyPut, R.workspace],
  },
  async (ctx) => {
    const { team, member, device, store, day, asMember } = await ingestedWorld(ctx, 'cap2');
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { accountId: team.id };
    const window = { day: day.day };

    await ctx.step('every item of the day is indexed once and the counts match the device output', async () => {
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

    await ctx.step('the device reads as recording from its status.json', async () => {
      (await asMember.get(path(R.devices), { params })).status(200).body().has('$.devices[0].live.state', 'recording');
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

    await ctx.step('IAM: the member holds neither capture.read_all nor capture.manage, the owner both; the member cannot read the owner or the account; the owner reads the member → 200 and a capture.member_view audit row', async () => {
      (await asMember.get(path(R.workspace), { params })).status(200).body().has('$.can_read_all', false).has('$.can_manage', false);
      (await owner.get(path(R.workspace), { params })).status(200).body().has('$.can_read_all', true).has('$.can_manage', true);
      if ('role' in (await owner.get(path(R.workspace), { params })).json<Record<string, unknown>>()) throw new Error('the workspace still names a Capture role');
      (await asMember.get(path(R.timeline), { params, query: { user_id: ctx.P.OWNER.userId! } })).status(403).body().has('$.code', 'capture_forbidden');
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

    await ctx.step('policy: a member cannot write it; the owner writes it and the device reads the same policy.json from the store', async () => {
      const policy = { layers: { screen: true, actions: false, audio: false }, retention: { local_hours: 24, remote_days: 30 }, notice: 'Synthetic notice' };
      (await asMember.put(path(R.policyPut), { policy }, { params })).status(403);
      (await owner.put(path(R.policyPut), { policy: { retention: { local_hours: 0, remote_days: -1 } } }, { params })).status(400).body().has('$.code', 'capture_policy_invalid');
      (await owner.put(path(R.policyPut), { policy }, { params })).status(200).body().has('$.policy.layers.actions', false);
      (await asMember.get(path(R.policyGet), { params })).status(200).body().has('$.policy.notice', 'Synthetic notice');
      const doc = JSON.parse((await readCaptureObject(store, `${device.prefix}/policy.json`)) ?? '{}');
      conforms('policy', doc);
      if (doc.schema !== 2 || doc.layers.actions !== false || doc.notice !== 'Synthetic notice') throw new Error(`policy.json ${JSON.stringify(doc)}`);
    });

    await ctx.step('the device forgets its audio item (objects deleted, a delete line appended) → the index reader retracts it: the audio chunk goes, the transcript no longer matches, the screen hits stay', async () => {
      const audioKey = day.manifestKeys.find((key) => /-a\d+\.manifest\.json$/.test(key))!;
      const base = audioKey.slice(device.prefix.length + 1, -'.manifest.json'.length);
      await deleteCaptureObjects(store, day.objects.filter((o) => o.key.startsWith(`${device.prefix}/${base}.`)).map((o) => o.key));
      const index = day.objects.find((o) => o.key.includes(`/${device.device_id}/index/`))!;
      const line = { op: 'delete', kind: 'audio', base, reason: 'forget', at_ms: Date.now() };
      conforms('index-line', line);
      const body = new TextEncoder().encode(`${new TextDecoder().decode(index.body)}${JSON.stringify(line)}\n`);
      await uploadCaptureObjects(store, [{ ...index, body }]);
      await awaitIndexed(ctx, asMember, team.id, device.device_id, day.day, (t) => !(t.chunks ?? []).some((c) => c.kind === 'audio'), 'the forgotten audio item to retract');
      const after = (await asMember.get(path(R.search), { params, query: { q: 'quarterly or roadmap', limit: 50 } })).status(200).json<{ hits: Hit[] }>().hits;
      if (after.some((h) => h.kind === 'audio')) throw new Error(`audio hit survived the forget: ${JSON.stringify(after).slice(0, 300)}`);
      if (!after.some((h) => h.kind === 'screen')) throw new Error('the screen hits went with it');
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

/**
 * CAP-5: the Kortix Capture data API with a Kortix API key (`kortix_pat_`), as
 * a script or an agent would use it. A member and the account owner (IAM
 * `capture.read_all`) each mint their own key; every data route runs against
 * the ingested fixture day. The member never sees the owner's data; the
 * owner's account-wide reads are audited.
 */
flow(
  'CAP-5',
  {
    domain: 'capture',
    requires: ['database'],
    timeoutMs: 180_000,
    routes: [R.tokens, R.workspace, R.setEnabled, R.search, R.items, R.frame, R.media],
  },
  async (ctx) => {
    const { team, member, day, asMember } = await ingestedWorld(ctx, 'cap5');
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { accountId: team.id };
    const keys: Record<'member' | 'owner', string> = { member: '', owner: '' };
    const as = (who: 'member' | 'owner') => ctx.client.withBearer(keys[who], `${who}-api-key`);
    const ownerId = ctx.P.OWNER.userId!;

    await ctx.step('each person mints a Kortix API key; with it, GET /v1/accounts/:id/capture answers Capture on and what IAM lets them do', async () => {
      for (const [who, client] of [['member', asMember], ['owner', owner]] as const) {
        const created = await client.post(path(R.tokens), { name: `CAP-5 ${who}` });
        created.status(201);
        keys[who] = created.json<{ secret_key: string }>().secret_key;
        if (!keys[who].startsWith('kortix_pat_')) throw new Error(`${who} key`);
      }
      (await as('member').get(path(R.workspace), { params })).status(200).body().has('$.enabled', true).has('$.can_read_all', false).has('$.can_manage', false);
      (await as('owner').get(path(R.workspace), { params })).status(200).body().has('$.can_read_all', true).has('$.can_manage', true);
    });

    await ctx.step('search: the member finds their own screen, action and audio hits (each names the member); scope=account → 403 capture_forbidden; the owner searches the account, sees the member\'s hits, and the read is audited as capture.account_view', async () => {
      type Hits = { hits: Array<{ kind: string; user_id: string }> };
      const mine = (await as('member').get(path(R.search), { params, query: { q: 'quarterly or roadmap' } })).status(200).json<Hits>();
      if (!mine.hits.length || mine.hits.some((h) => h.user_id !== member.userId)) throw new Error(JSON.stringify(mine).slice(0, 300));
      if (!['screen', 'actions', 'audio'].every((k) => mine.hits.some((h) => h.kind === k))) throw new Error(`kinds: ${mine.hits.map((h) => h.kind)}`);
      (await as('member').get(path(R.search), { params, query: { q: 'quarterly', scope: 'account' } })).status(403).body().has('$.code', 'capture_forbidden');
      const all = (await as('owner').get(path(R.search), { params, query: { q: 'quarterly', scope: 'account' } })).status(200).json<Hits>();
      if (!all.hits.some((h) => h.user_id === member.userId)) throw new Error('the owner does not see the member');
      const db = await openDb(ctx);
      try {
        // The audit log is written after the response: wait for the row.
        const n = await waitFor(
          async () => Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM kortix.audit_events WHERE account_id = $1 AND action = 'capture.account_view' AND actor_user_id = $2`, [team.id, ownerId])).rows[0]!.n),
          { until: (count) => count >= 1, timeoutMs: 15_000, intervalMs: 500, description: 'the capture.account_view row of the API-key read' },
        );
        if (n < 1) throw new Error('no capture.account_view row');
      } finally {
        await db.end();
      }
    });

    await ctx.step('timeline items, a frame (with its signed video and screenshot fields) and chunk media: the member reads their own day; naming the owner → 403', async () => {
      const window = { from: new Date(day.startMs - 60_000).toISOString(), to: new Date(day.endMs + 60_000).toISOString() };
      const t = (await as('member').get(path(R.items), { params, query: window })).status(200).json<{ frames: Array<{ frame_id: string; chunk_id: string }>; actions: unknown[]; audio: unknown[] }>();
      if (t.frames.length !== day.expected.frames || !t.actions.length || !t.audio.length) throw new Error(`items: ${t.frames.length}/${day.expected.frames} frames`);
      const frame = (await as('member').get(path(R.frame), { params: { ...params, frameId: t.frames[0]!.frame_id } })).status(200).json<{ frame: { ocr_text: string }; video: { url: string } | null; screenshot: unknown }>();
      if (!frame.frame.ocr_text || !frame.video?.url || !('screenshot' in frame)) throw new Error(JSON.stringify(frame).slice(0, 300));
      (await as('member').get(path(R.media), { params: { ...params, chunkId: t.frames[0]!.chunk_id } })).status(200).body().exists('$.video.url');
      (await as('member').get(path(R.items), { params, query: { ...window, user_id: ownerId } })).status(403);
    });

    await ctx.step('Capture off: the data routes answer 403 capture_disabled to the API key', async () => {
      (await owner.patch(path(R.setEnabled), { enabled: false }, { params })).status(200);
      (await as('member').get(path(R.search), { params, query: { q: 'quarterly' } })).status(403).body().has('$.code', 'capture_disabled');
      (await as('owner').get(path(R.search), { params, query: { q: 'quarterly', scope: 'account' } })).status(403).body().has('$.code', 'capture_disabled');
      (await owner.patch(path(R.setEnabled), { enabled: true }, { params })).status(200);
    });
  },
);
