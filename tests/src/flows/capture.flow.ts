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
 * Request and response bodies are the engine's (apps/capture) and are validated against its
 * JSON Schemas (apps/capture/schemas); the device data is its fixture bucket.
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
import { captureSchemaErrors, deleteCaptureObjects, FIXTURE_DISPLAYS, localCaptureStore, readCaptureObject, syntheticMachineKey, uploadCaptureObjects, vendoredDevice, type CaptureSchemaName } from '../fixtures/capture';
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
  enroll: 'POST /v1/capture/device/enroll',
  enrollTokens: `GET ${A}/enrollment-tokens`,
  enrollTokenCreate: `POST ${A}/enrollment-tokens`,
  enrollTokenRevoke: `DELETE ${A}/enrollment-tokens/:tokenId`,
  enrollments: `GET ${A}/enrollments`,
  enrollApprove: `POST ${A}/enrollments/:enrollmentId/approve`,
  enrollDeny: `POST ${A}/enrollments/:enrollmentId/deny`,
  link: `PUT ${A}/devices/:deviceId/link`,
  inbox: 'GET /v1/notifications',
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

/**
 * A computer's own network address, from its machine key. Each real computer signs in from its own
 * address; without one, every flow would share the API's single `unknown` rate-limit bucket.
 */
const fromComputer = (machineKey: string) => ({
  headers: {
    'x-real-ip': `10.${parseInt(machineKey.slice(0, 2), 16)}.${parseInt(machineKey.slice(2, 4), 16)}.${parseInt(machineKey.slice(4, 6), 16)}`,
  },
});

/** The whole device sign-in, approved by `who` into `accountId`. */
async function signInDevice(ctx: FlowContext, who: Principal, accountId: string, machineKey: string) {
  const anon = ctx.client.as(ctx.P.ANON);
  const started = await anon.post(path(R.authorize), engineAuthorize(machineKey), fromComputer(machineKey));
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
      const r = await anon.post(path(R.authorize), engineAuthorize(machineKey), fromComputer(machineKey));
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
      const denyKey = syntheticMachineKey(ctx.fixtures.name('cap1-deny'));
      const r = await anon.post(path(R.authorize), engineAuthorize(denyKey), fromComputer(denyKey));
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

    await ctx.step('the member signs the computer in again after their own revoke → same device; after the owner revokes it, the member’s approval → 403 capture_device_revoked', async () => {
      const again = await signInDevice(ctx, member, accountId, machineKey);
      if (again.device_id !== device.device_id) throw new Error('a new sign-in on the same computer made a new device');
      (await ctx.client.as(ctx.P.OWNER).del(path(R.revoke), { params: { accountId, deviceId: again.device_id } })).status(200);
      const started = (await anon.post(path(R.authorize), engineAuthorize(machineKey), fromComputer(machineKey))).status(200).json<{ user_code: string }>();
      (await asMember.post(path(R.approve), { account_id: accountId }, { params: { user_code: started.user_code } }))
        .status(403)
        .body()
        .has('$.code', 'capture_device_revoked');
    });
  },
);

interface Hit {
  kind: string;
  id: string;
  snippet: string;
  chunk_id: string;
}

async function ingestedWorld(ctx: FlowContext, label: string, displays: 1 | 2 = 1) {
  const { team, member } = await captureAccount(ctx);
  await enableCapture(ctx, team.id);
  const machineKey = syntheticMachineKey(ctx.fixtures.name(label));
  const device = await signInDevice(ctx, member, team.id, machineKey);
  const store = await localCaptureStore();
  // Audio is off by default: turn it on first, so the audio item indexes too.
  (await ctx.client.as(ctx.P.OWNER).put(path(R.policyPut), { policy: { layers: { screen: true, actions: true, audio: true } } }, { params: { accountId: team.id } })).status(200);
  const day = vendoredDevice({ prefix: device.prefix, deviceId: device.device_id, machineKeySha256: machineKey, displays });
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
      (await asMember.get(path(R.days), { params, query: { tz: 'Mars/Olympus' } })).status(400).body().has('$.code', 'capture_bad_query');
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

      await ctx.step('real CLI inside the session: `kortix capture search <marker> --json` exits 0 with the member’s hits; `capture frame` prints the text; `capture timeline --day` prints the day (runs, displays, focus)', async () => {
        const env = { KORTIX_TOKEN: own.secret, KORTIX_API_URL: ctx.env.apiUrl, KORTIX_PROJECT_ID: project.id, KORTIX_SESSION_ID: own.sessionId };
        const searched = await sandbox.run(['capture', 'search', marker, '--json'], { env });
        if (searched.exitCode !== 0) throw new Error(`capture search exit ${searched.exitCode}: ${searched.all.slice(0, 600)}`);
        const result = JSON.parse(searched.stdout.trim()) as { user_id: string; hits: Hit[] };
        if (result.user_id !== member.userId || result.hits.length === 0) throw new Error(`unexpected ${searched.stdout.slice(0, 400)}`);
        const frameId = result.hits.find((h) => h.kind === 'screen')!.id;
        const frame = await sandbox.run(['capture', 'frame', frameId], { env });
        if (frame.exitCode !== 0 || !frame.stdout.includes('quarterly roadmap')) throw new Error(`capture frame: ${frame.all.slice(0, 400)}`);
        const day = await sandbox.run(['capture', 'timeline', '--day', '2026-10-01', '--json'], { env });
        if (day.exitCode !== 0) throw new Error(`capture timeline exit ${day.exitCode}: ${day.all.slice(0, 600)}`);
        const timeline = JSON.parse(day.stdout.trim()) as { runs: unknown[]; displays: unknown[]; focus: unknown[] };
        if (!timeline.runs.length || !Array.isArray(timeline.displays) || !Array.isArray(timeline.focus)) throw new Error(`capture timeline: ${day.stdout.slice(0, 400)}`);
        const table = await sandbox.run(['capture', 'timeline', '--day', '2026-10-01'], { env });
        if (table.exitCode !== 0 || !table.stdout.includes('START (UTC)')) throw new Error(`capture timeline table: ${table.all.slice(0, 400)}`);
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

flow(
  'CAP-6',
  {
    domain: 'capture',
    requires: ['database'],
    timeoutMs: 180_000,
    routes: [R.devices, R.sync, R.timeline, R.items, R.search, R.frame, R.policyPut],
  },
  async (ctx) => {
    // A dual-monitor device: every screen item once per display, display 1 focused.
    const { team, member, device, day, asMember } = await ingestedWorld(ctx, 'cap6', 2);
    const params = { accountId: team.id };
    const [main, external] = FIXTURE_DISPLAYS;
    const perDisplay = day.expected.frames / 2;

    await ctx.step('the timeline lists both displays (main first, with their layout), a screen item per display, and focus spans on display 1; runs follow the focused display', async () => {
      const t = (await asMember.get(path(R.timeline), { params, query: { day: day.day } })).status(200).json<any>();
      if (JSON.stringify(t.displays.map((d: any) => [d.id, d.name, d.main, d.x])) !== JSON.stringify([[main.id, main.name, true, 0], [external.id, external.name, false, external.x]])) {
        throw new Error(`displays ${JSON.stringify(t.displays)}`);
      }
      const screens = t.chunks.filter((c: any) => c.kind === 'chunk');
      if (screens.filter((c: any) => c.display_id === 1).length !== 2 || screens.filter((c: any) => c.display_id === 2).length !== 2) throw new Error(`screen items ${JSON.stringify(screens.map((c: any) => c.display_id))}`);
      if (!t.focus.length || t.focus.some((f: any) => f.display_id !== 1)) throw new Error(`focus ${JSON.stringify(t.focus)}`);
      const runFrames = t.runs.reduce((n: number, r: any) => n + r.frames, 0);
      if (runFrames !== perDisplay) throw new Error(`runs count ${runFrames} frames, the focused display has ${perDisplay}`);
    });

    await ctx.step('display_id=2 narrows the screen items and runs to the external display and keeps the action and audio items', async () => {
      const t = (await asMember.get(path(R.timeline), { params, query: { day: day.day, display_id: '2' } })).status(200).json<any>();
      const screens = t.chunks.filter((c: any) => c.kind === 'chunk');
      if (screens.length !== 2 || screens.some((c: any) => c.display_id !== 2)) throw new Error(`screen items ${JSON.stringify(screens)}`);
      if (!t.chunks.some((c: any) => c.kind === 'actions')) throw new Error('action items dropped');
      if (t.runs.reduce((n: number, r: any) => n + r.frames, 0) !== perDisplay) throw new Error('display 2 runs');
      if (t.displays.length !== 2) throw new Error('the displays list must not narrow');
    });

    await ctx.step('items: the default is the focused display, display_id=2 the external one (focused false), display_id=all both; display_id=x → 400', async () => {
      const items = async (display_id?: string) =>
        (await asMember.get(path(R.items), { params, query: { day: day.day, ...(display_id ? { display_id } : {}) } })).status(200).json<any>().frames as any[];
      const focused = await items();
      if (focused.length !== perDisplay || focused.some((f) => f.display_id !== 1 || f.focused !== true)) throw new Error(`default ${JSON.stringify(focused.map((f) => [f.display_id, f.focused]))}`);
      const second = await items('2');
      if (second.length !== perDisplay || second.some((f) => f.display_id !== 2 || f.focused !== false)) throw new Error('display 2 frames');
      if ((await items('all')).length !== day.expected.frames) throw new Error('all displays');
      (await asMember.get(path(R.items), { params, query: { day: day.day, display_id: 'x' } })).status(400);
    });

    await ctx.step('the device lists its displays from device.json; a frame of display 2 opens with that display; a screen search hit names its display', async () => {
      const devices = (await asMember.get(path(R.devices), { params })).status(200).json<any>().devices;
      const listed = devices.find((d: any) => d.device_id === device.device_id);
      if (listed?.displays?.length !== 2) throw new Error(`device displays ${JSON.stringify(listed?.displays)}`);
      const frame = (await asMember.get(path(R.items), { params, query: { day: day.day, display_id: '2' } })).json<any>().frames[0];
      (await asMember.get(path(R.frame), { params: { ...params, frameId: frame.frame_id } })).status(200).body().has('$.display.id', 2).has('$.display.name', external.name);
      const hits = (await asMember.get(path(R.search), { params, query: { q: 'quarterly', kinds: 'screen', limit: 50 } })).status(200).json<any>().hits;
      if (!hits.some((h: any) => h.display_id === 2 && h.display_name === external.name)) throw new Error(`hits ${JSON.stringify(hits.map((h: any) => [h.display_id, h.display_name]))}`);
    });
  },
);

/** The body the machine service sends to /device/enroll: the token, the machine, the Windows person. */
const engineEnroll = (token: string, machineKey: string, principalName: string | null, accountName = 'CORP\\fixture') => ({
  enrollment_token: token,
  machine_key_sha256: machineKey,
  user: { principal_name: principalName, account_name: accountName },
  device: { hostname: 'fixture-pc', computer_name: 'Fixture PC', os: 'windows', os_version: '10.0.26100', arch: 'x86_64', app_version: '0.1.0' },
});

flow(
  'CAP-7',
  {
    domain: 'capture',
    requires: ['database'],
    timeoutMs: 300_000,
    routes: [R.enroll, R.enrollTokens, R.enrollTokenCreate, R.enrollTokenRevoke, R.enrollments, R.enrollApprove, R.enrollDeny, R.link, R.devices, R.revoke, R.credentials, R.setEnabled, R.sync, R.timeline, R.search, R.policyPut],
  },
  async (ctx) => {
    const { team, member } = await captureAccount(ctx);
    const anon = ctx.client.as(ctx.P.ANON);
    const owner = ctx.client.as(ctx.P.OWNER);
    const asMember = ctx.client.as(member);
    const params = { accountId: team.id };
    const domain = member.email!.split('@')[1]!.toLowerCase();
    const stranger = `${ctx.fixtures.name('cap7-stranger')}@${domain}`.toLowerCase();
    const machine = (label: string) => syntheticMachineKey(ctx.fixtures.name(`cap7-${label}`));
    const [pcA, pcB, pcC, pcD, pcE, pcF] = [machine('a'), machine('b'), machine('c'), machine('d'), machine('e'), machine('f')];
    // `proof`: the computer's current device token, sent as Bearer like the app does.
    const enroll = (token: string, machineKey: string, principal: string | null, proof?: string) =>
      (proof ? anon.withBearer(proof) : anon).post(path(R.enroll), engineEnroll(token, machineKey, principal));
    let token = { token_id: '', token: '', created_by: '' };
    let deviceA = { device_token: '', device_id: '' };
    let deviceB = { device_token: '', device_id: '' };
    let enrollmentB = '';
    let dayB: ReturnType<typeof vendoredDevice> = null as never;
    let strictToken = '';

    await enableCapture(ctx, team.id);

    await ctx.step('only capture.manage manages the rollout: the member lists or creates tokens → 403 capture_forbidden; a bad email domain → 400', async () => {
      (await asMember.get(path(R.enrollTokens), { params })).status(403).body().has('$.code', 'capture_forbidden');
      (await asMember.post(path(R.enrollTokenCreate), { name: 'x' }, { params })).status(403).body().has('$.code', 'capture_forbidden');
      (await owner.post(path(R.enrollTokenCreate), { name: 'x', email_domains: ['not a domain'] }, { params })).status(400).body().has('$.code', 'capture_enrollment_invalid');
    });

    await ctx.step('the owner creates a token for the member’s domain, 2 computers → 201 with the kortix_enr_ secret once; the list shows it without the secret, 0 computers, expiring in 30 days', async () => {
      const r = await owner.post(path(R.enrollTokenCreate), { name: 'Pilot laptops', email_domains: [`@${domain.toUpperCase()}`], max_devices: 2 }, { params });
      r.status(201).body().has('$.state', 'active').has('$.device_count', 0).has('$.email_domains', [domain]).has('$.max_devices', 2).has('$.require_approval', false);
      token = r.json();
      if (!token.token.startsWith('kortix_enr_') || token.token.length !== 51) throw new Error(`token shape ${token.token.slice(0, 12)}`);
      const listed = (await owner.get(path(R.enrollTokens), { params })).status(200).json<{ tokens: Array<Record<string, unknown>> }>();
      const row = listed.tokens.find((t) => t.token_id === token.token_id)!;
      if (!row || 'token' in row || !String(row.token_prefix).startsWith('kortix_enr_')) throw new Error(`list row ${JSON.stringify(row)}`);
      const days = (Date.parse(String(row.expires_at)) - Date.now()) / 86_400_000;
      if (days < 29.9 || days > 30.1) throw new Error(`expires in ${days} days`);
    });

    await ctx.step('enroll refusals: no token → 400; a 63-hex machine key → 400; an unknown token → 401 enrollment_token_invalid; a person outside the domain → 403 enrollment_domain_not_allowed', async () => {
      (await anon.post(path(R.enroll), { machine_key_sha256: pcA, user: { principal_name: member.email } })).status(400).body().has('$.code', 'invalid_request');
      (await enroll(token.token, pcA.slice(1), member.email!)).status(400).body().has('$.code', 'invalid_request');
      (await enroll('kortix_enr_unknown', pcA, member.email!)).status(401).body().has('$.code', 'enrollment_token_invalid');
      (await enroll(token.token, pcA, 'someone@elsewhere.example')).status(403).body().has('$.code', 'enrollment_domain_not_allowed');
    });

    await ctx.step('the member’s Windows sign-in (UPN, upper case) on computer A → 200 enrolled: a kortix_cap_ device token, prefix orgs/<account>, the account name, and no member (a reported sign-in name links no one on a company token); the device lists with the token id; the device token buys credentials (503 on a store without STS, not 401)', async () => {
      const r = await enroll(token.token, pcA, member.email!.toUpperCase());
      r.status(200).body().has('$.status', 'enrolled').has('$.token_type', 'Bearer').has('$.prefix', `orgs/${team.id}`).has('$.member', null);
      deviceA = r.json();
      if (!deviceA.device_token.startsWith('kortix_cap_')) throw new Error('device token prefix');
      if (!r.json<{ account: { name: string } }>().account.name) throw new Error('no account name');
      const devices = (await owner.get(path(R.devices), { params, query: { scope: 'account' } })).status(200).json<{ devices: Array<Record<string, unknown>> }>();
      const row = devices.devices.find((d) => d.device_id === deviceA.device_id);
      if (row?.user_id !== null || row?.enrollment_token_id !== token.token_id || row?.os !== 'windows') throw new Error(`device ${JSON.stringify(row)}`);
      (await anon.withBearer(deviceA.device_token).post(path(R.credentials))).status(503).body().has('$.code', 'capture_credentials_unavailable');
    });

    await ctx.step('device-first: a person of the domain who is no member, on computer B → 200 enrolled with member null; the device lists linked to no one with the token id; the enrollment lists as enrolled with its Windows names', async () => {
      const r = await enroll(token.token, pcB, stranger);
      r.status(200).body().has('$.status', 'enrolled').has('$.member', null).has('$.prefix', `orgs/${team.id}`);
      deviceB = r.json();
      const devices = (await owner.get(path(R.devices), { params, query: { scope: 'account' } })).status(200).json<{ devices: Array<Record<string, unknown>> }>();
      const row = devices.devices.find((d) => d.device_id === deviceB.device_id);
      if (!row || row.user_id !== null || row.enrollment_token_id !== token.token_id) throw new Error(`device ${JSON.stringify(row)}`);
      const listed = (await owner.get(path(R.enrollments), { params })).status(200).json<{ enrollments: Array<Record<string, any>> }>();
      const enrollment = listed.enrollments.find((e) => e.device_id === deviceB.device_id);
      if (enrollment?.status !== 'enrolled' || enrollment.principal_name !== stranger || enrollment.account_name !== 'CORP\\fixture' || enrollment.token_name !== 'Pilot laptops' || enrollment.user_id !== null) {
        throw new Error(`enrollment ${JSON.stringify(enrollment)}`);
      }
      enrollmentB = enrollment.enrollment_id;
    });

    await ctx.step('computer B records linked to no one: its day indexes; the member reads none of it and does not find it; the owner (capture.read_all) reads it by device_id → user_id null, and a capture.device_view audit row', async () => {
      const store = await localCaptureStore();
      // Audio is off by default: turn it on first, so the fixture's audio item indexes too (as ingestedWorld does).
      (await owner.put(path(R.policyPut), { policy: { layers: { screen: true, actions: true, audio: true } } }, { params })).status(200);
      dayB = vendoredDevice({ prefix: `orgs/${team.id}`, deviceId: deviceB.device_id, machineKeySha256: pcB });
      await uploadCaptureObjects(store, dayB.objects);
      (await owner.post(path(R.sync), {}, { params: { ...params, deviceId: deviceB.device_id } })).status(200);
      const timeline = await waitFor(
        async () => (await owner.get(path(R.timeline), { params, query: { day: dayB.day, device_id: deviceB.device_id } })).json<{ user_id: string | null; chunks?: unknown[] }>(),
        { until: (t) => (t.chunks?.length ?? 0) >= dayB.expected.chunks, timeoutMs: 90_000, intervalMs: 1_000, description: 'the unlinked device to index' },
      );
      if (timeline.user_id !== null) throw new Error(`user_id ${timeline.user_id}`);
      // The member reads only their own rows of it: none.
      (await asMember.get(path(R.timeline), { params, query: { day: dayB.day, device_id: deviceB.device_id } })).status(200).body().has('$.chunks', []);
      (await asMember.get(path(R.search), { params, query: { q: 'quarterly or roadmap' } })).status(200).body().has('$.hits', []);
      const db = await openDb(ctx);
      try {
        await waitFor(
          async () => (await db.query<{ n: string }>(`SELECT count(*) AS n FROM kortix.audit_events WHERE account_id = $1 AND action = 'capture.device_view' AND resource_id = $2`, [team.id, deviceB.device_id])).rows[0]!.n,
          { until: (n) => Number(n) >= 1, timeoutMs: 15_000, intervalMs: 500, description: 'the device_view audit row' },
        );
      } finally {
        await db.end();
      }
    });

    await ctx.step('the token counts 2 computers; a third computer → 403 enrollment_limit_reached', async () => {
      const listed = (await owner.get(path(R.enrollTokens), { params })).status(200).json<{ tokens: Array<Record<string, unknown>> }>();
      if (listed.tokens.find((t) => t.token_id === token.token_id)?.device_count !== 2) throw new Error(`count ${JSON.stringify(listed)}`);
      (await enroll(token.token, pcC, member.email!)).status(403).body().has('$.code', 'enrollment_limit_reached');
    });

    await ctx.step('link a device to a Kortix user: the member cannot (403); a non-member → 400; the owner links computer B to the member → 200; what B recorded unlinked moves to the member (their search finds it); B’s next enroll names the member', async () => {
      (await asMember.put(path(R.link), { user_id: member.userId }, { params: { ...params, deviceId: deviceB.device_id } })).status(403);
      (await owner.put(path(R.link), { user_id: ctx.P.NONMEMBER.userId }, { params: { ...params, deviceId: deviceB.device_id } })).status(400).body().has('$.code', 'capture_link_invalid');
      (await owner.put(path(R.link), { user_id: member.userId }, { params: { ...params, deviceId: deviceB.device_id } })).status(200).body().has('$.user_id', member.userId!);
      await waitFor(
        async () => (await asMember.get(path(R.search), { params, query: { q: 'quarterly or roadmap', device_id: deviceB.device_id } })).json<{ hits: unknown[] }>().hits.length,
        { until: (n) => n > 0, timeoutMs: 60_000, intervalMs: 1_000, description: 'the unlinked recordings to move to the member' },
      );
      // The machine key alone does not re-mint B's token: without B's current token it waits for an admin.
      (await enroll(token.token, pcB, stranger)).status(202).body().has('$.reason', 'approval_required');
      (await anon.withBearer(deviceB.device_token).post(path(R.credentials))).status(503);
      const relinked = await enroll(token.token, pcB, stranger, deviceB.device_token);
      relinked.status(200).body().has('$.member.email', member.email!);
      deviceB = relinked.json();
    });

    await ctx.step('unlink: the owner sets user_id null → B lists linked to no one again; what moved to the member stays theirs', async () => {
      (await owner.put(path(R.link), { user_id: null }, { params: { ...params, deviceId: deviceB.device_id } })).status(200).body().has('$.user_id', null);
      const hits = (await asMember.get(path(R.search), { params, query: { q: 'quarterly or roadmap', device_id: deviceB.device_id } })).status(200).json<{ hits: unknown[] }>();
      if (hits.hits.length === 0) throw new Error('the member lost the recordings an unlink should keep');
    });

    await ctx.step('the owner denies computer B → its device token stops working (401) and its calls → 403 enrollment_denied', async () => {
      const b = (await enroll(token.token, pcB, stranger, deviceB.device_token)).status(200).json<{ device_token: string }>();
      (await owner.post(path(R.enrollDeny), {}, { params: { ...params, enrollmentId: enrollmentB } })).status(200).body().has('$.status', 'denied');
      (await anon.withBearer(b.device_token).post(path(R.credentials))).status(401).body().has('$.code', 'capture_device_unauthorized');
      (await enroll(token.token, pcB, stranger)).status(403).body().has('$.code', 'enrollment_denied');
    });

    await ctx.step('a device the owner revoked is not revived by enroll: computer A → 202 approval_required until the owner approves; then enrolled with the same device id, and the token before it → 401', async () => {
      const before = (await enroll(token.token, pcA, member.email!, deviceA.device_token)).status(200).json<{ device_token: string; device_id: string }>();
      if (before.device_id !== deviceA.device_id) throw new Error('re-enroll changed the device id');
      (await anon.withBearer(deviceA.device_token).post(path(R.credentials))).status(401);
      (await owner.del(path(R.revoke), { params: { ...params, deviceId: deviceA.device_id } })).status(200);
      const waiting = await enroll(token.token, pcA, member.email!);
      waiting.status(202).body().has('$.reason', 'approval_required');
      const enrollmentId = waiting.json<{ enrollment_id: string }>().enrollment_id;
      (await owner.post(path(R.enrollApprove), { user_id: member.userId }, { params: { ...params, enrollmentId } })).status(200);
      const after = (await enroll(token.token, pcA, member.email!)).status(200).json<{ device_token: string; device_id: string }>();
      if (after.device_id !== deviceA.device_id) throw new Error('approval created a new device');
      (await anon.withBearer(after.device_token).post(path(R.credentials))).status(503);
      (await anon.withBearer(before.device_token).post(path(R.credentials))).status(401);
      deviceA = after;
    });

    await ctx.step('a token that requires approval: the member on computer D → 202 approval_required; approved → enrolled', async () => {
      const created = await owner.post(path(R.enrollTokenCreate), { name: 'Approve each', require_approval: true, expires_in_days: null }, { params });
      created.status(201).body().has('$.expires_at', null).has('$.require_approval', true);
      const strict = created.json<{ token: string }>();
      strictToken = strict.token;
      const waiting = await enroll(strict.token, pcD, member.email!);
      waiting.status(202).body().has('$.reason', 'approval_required');
      const enrollmentId = waiting.json<{ enrollment_id: string }>().enrollment_id;
      // The reported sign-in name suggests the member; only the admin's approval links it.
      const listed = (await owner.get(path(R.enrollments), { params })).status(200).json<{ enrollments: Array<Record<string, unknown>> }>();
      if (listed.enrollments.find((e) => e.enrollment_id === enrollmentId)?.user_id !== member.userId) throw new Error('no suggested member');
      (await owner.post(path(R.enrollApprove), { user_id: member.userId }, { params: { ...params, enrollmentId } })).status(200);
      (await enroll(strict.token, pcD, member.email!)).status(200).body().has('$.status', 'enrolled').has('$.member.email', member.email!);
    });

    await ctx.step('a personal token: for a non-member → 400; for the member, 1 computer → 201 with user_id; whoever signs in to computer E, it links to the member; a second computer → 403 enrollment_limit_reached', async () => {
      (await owner.post(path(R.enrollTokenCreate), { name: 'Not a member', user_id: crypto.randomUUID() }, { params })).status(400).body().has('$.code', 'capture_enrollment_invalid');
      const created = await owner.post(path(R.enrollTokenCreate), { name: 'Member laptop', user_id: member.userId, max_devices: 1 }, { params });
      created.status(201).body().has('$.user_id', member.userId).has('$.email_domains', []);
      const personal = created.json<{ token: string; token_id: string }>();
      const listed = (await owner.get(path(R.enrollTokens), { params })).status(200).json<{ tokens: Array<Record<string, unknown>> }>();
      if (listed.tokens.find((t) => t.token_id === personal.token_id)?.user_id !== member.userId) throw new Error('listed token has no user_id');
      const r = await enroll(personal.token, pcE, stranger);
      r.status(200).body().has('$.status', 'enrolled').has('$.member.email', member.email!);
      const devices = (await owner.get(path(R.devices), { params, query: { scope: 'account' } })).status(200).json<{ devices: Array<Record<string, unknown>> }>();
      if (devices.devices.find((d) => d.device_id === r.json<{ device_id: string }>().device_id)?.user_id !== member.userId) throw new Error('computer E is not linked to the member');
      (await enroll(personal.token, pcF, member.email!)).status(403).body().has('$.code', 'enrollment_limit_reached');
    });

    await ctx.step('the owner revokes the first token → new enrolls 401; computer A keeps its device token (503, not 401); the list shows revoked', async () => {
      (await owner.del(path(R.enrollTokenRevoke), { params: { ...params, tokenId: token.token_id } })).status(200).body().has('$.state', 'revoked');
      (await enroll(token.token, pcA, member.email!)).status(401).body().has('$.code', 'enrollment_token_invalid');
      (await anon.withBearer(deviceA.device_token).post(path(R.credentials))).status(503);
      (await asMember.del(path(R.enrollTokenRevoke), { params: { ...params, tokenId: token.token_id } })).status(403);
    });

    await ctx.step('the team’s audit log (not the owner’s own account) holds the owner’s two successful capture.enrollment_token.create rows and the enrolls as capture.device.enroll by the token (system actor), with the device as resource', async () => {
      const db = await openDb(ctx);
      try {
        const rows = await waitFor(
          async () =>
            (await db.query<{ action: string; actor_user_id: string | null; actor_type: string; resource_id: string | null }>(
              `SELECT action, actor_user_id, actor_type, resource_id FROM kortix.audit_events
                WHERE account_id = $1 AND outcome = 'success' AND action IN ('capture.device.enroll', 'capture.enrollment_token.create')`,
              [team.id],
            )).rows,
          {
            until: (r) => r.filter((x) => x.action === 'capture.enrollment_token.create').length >= 2 && r.some((x) => x.action === 'capture.device.enroll'),
            timeoutMs: 20_000,
            intervalMs: 500,
            description: 'the enrollment audit rows',
          },
        );
        const creates = rows.filter((r) => r.action === 'capture.enrollment_token.create');
        if (creates.length < 2 || creates.some((r) => r.actor_user_id !== token.created_by)) throw new Error(`creates ${JSON.stringify(creates)} vs ${token.created_by}`);
        const enrolls = rows.filter((r) => r.action === 'capture.device.enroll');
        if (!enrolls.some((r) => r.actor_type === 'system' && r.actor_user_id === null && r.resource_id === deviceA.device_id)) {
          throw new Error(`enrolls ${JSON.stringify(enrolls)}`);
        }
      } finally {
        await db.end();
      }
    });

    await ctx.step('with Capture off, enroll with a live token → 403 capture_disabled, and the rollout routes → 403 capture_disabled', async () => {
      (await owner.patch(path(R.setEnabled), { enabled: false }, { params })).status(200);
      (await enroll(strictToken, pcD, member.email!)).status(403).body().has('$.code', 'capture_disabled');
      (await owner.get(path(R.enrollTokens), { params })).status(403).body().has('$.code', 'capture_disabled');
    });
  },
);

/** A status.json of the engine (status.schema.json), restamped by `at`. */
function statusDoc(at: number, over: Record<string, unknown> = {}) {
  const doc = {
    recording: 'recording',
    reason: null,
    missingPermissions: [],
    pausedUntilMs: null,
    audio: { enabled: false, state: null },
    sync: { state: 'ok', pending: 0, lastUploadMs: at - 5_000 },
    lastFrameMs: at - 2_000,
    appVersion: '0.1.0',
    actionsRecording: true,
    capture: { intervalMs: 1000, maxHeight: 1080 },
    host: { awakeSinceMs: at - 3_600_000 },
    reportedAtMs: at,
    ...over,
  };
  conforms('status', doc);
  return doc;
}

flow(
  'CAP-8',
  {
    domain: 'capture',
    requires: ['database'],
    timeoutMs: 300_000,
    routes: [R.devices, R.sync, R.inbox, R.setEnabled, R.enrollTokenCreate, R.enroll],
  },
  async (ctx) => {
    const { team, member } = await captureAccount(ctx);
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { accountId: team.id };
    await enableCapture(ctx, team.id);
    const store = await localCaptureStore();
    const MIN = 60_000;
    // Fixed timestamps: the same document read again is the same not-recording spell.
    const t0 = Date.now();
    const stalledDoc = statusDoc(t0, { lastFrameMs: t0 - 40 * MIN });
    const silentDoc = statusDoc(t0 - 45 * MIN);
    const names = ['recording', 'locked', 'paused', 'stalled', 'silent'] as const;
    const computers = new Map<(typeof names)[number], { device_id: string; prefix: string }>();
    // An IT fleet: one personal token for the owner enrolls the five computers (enroll is limited per token
    // and per machine, so the flows that run beside this one cannot rate-limit it the way sign-in can).
    const fleetToken = (
      await owner.post(path(R.enrollTokenCreate), { name: 'CAP-8 fleet', user_id: ctx.P.OWNER.userId }, { params })
    ).status(201).json<{ token: string }>().token;
    const anon = ctx.client.as(ctx.P.ANON);
    for (const name of names) {
      const machineKey = syntheticMachineKey(ctx.fixtures.name(`cap8-${name}`));
      const enrolled = (await anon.post(path(R.enroll), engineEnroll(fleetToken, machineKey, null))).status(200);
      computers.set(name, enrolled.json<{ device_id: string; prefix: string }>());
    }

    /** Upload a status.json for one computer and read it now (what the index reader does every poll). */
    const report = async (name: (typeof names)[number], doc: Record<string, unknown>) => {
      const c = computers.get(name)!;
      await uploadCaptureObjects(store, [{ key: `${c.prefix}/${c.device_id}/status.json`, body: new TextEncoder().encode(JSON.stringify(doc)), contentType: 'application/json' }]);
      return (await owner.post(path(R.sync), {}, { params: { ...params, deviceId: c.device_id } })).status(200).json<{ alerts: { alerted: number; recovered: number } }>();
    };
    const fleet = async () => {
      const r = (await owner.get(path(R.devices), { params, query: { scope: 'account' } })).status(200);
      return r.json<{ devices: Array<{ device_id: string; health: { state: string; idle: boolean; reasons: string[]; since: string | null } }>; health: Record<string, unknown> }>();
    };
    const healthOf = (f: Awaited<ReturnType<typeof fleet>>, name: (typeof names)[number]) =>
      f.devices.find((d) => d.device_id === computers.get(name)!.device_id)!.health;
    const db = await openDb(ctx);
    const stored = async (kind: string, userId: string) =>
      Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM kortix.notifications WHERE account_id = $1 AND user_id = $2 AND kind = $3`, [team.id, userId, kind])).rows[0]!.n);

    try {
      await ctx.step('five computers report: recording, locked, paused by the person, recording with no frame for 40 awake minutes, and silent for 45 minutes → the summary counts 1 recording · 1 idle · 1 needs attention · 2 not recording, each with its reason', async () => {
        const now = t0;
        await report('recording', statusDoc(now));
        await report('locked', statusDoc(now, { recording: 'paused', reason: 'locked', lastFrameMs: now - 40 * MIN }));
        await report('paused', statusDoc(now, { recording: 'paused', reason: 'paused', pausedUntilMs: now + 30 * MIN }));
        await report('stalled', stalledDoc);
        await report('silent', silentDoc);
        const f = await fleet();
        if (JSON.stringify(f.health) !== JSON.stringify({ recording: 1, idle: 1, attention: 1, not_recording: 2, latest_version: null })) throw new Error(`summary ${JSON.stringify(f.health)}`);
        const expected = {
          recording: ['healthy', []],
          locked: ['healthy', []],
          paused: ['attention', ['paused']],
          stalled: ['not_recording', ['stalled']],
          silent: ['not_recording', ['offline']],
        } as const;
        for (const name of names) {
          const h = healthOf(f, name);
          if (h.state !== expected[name][0] || JSON.stringify(h.reasons) !== JSON.stringify(expected[name][1])) throw new Error(`${name}: ${JSON.stringify(h)}`);
        }
        if (!healthOf(f, 'locked').idle || healthOf(f, 'recording').idle) throw new Error('idle flag');
        if (!healthOf(f, 'stalled').since || !healthOf(f, 'silent').since) throw new Error('not-recording spells have no start');
      });

      await ctx.step('a computer asleep after a lock stays healthy: silent for 3 days after a locked report → idle, no alert', async () => {
        await report('locked', statusDoc(Date.now() - 3 * 86_400_000, { recording: 'paused', reason: 'locked' }));
        const h = healthOf(await fleet(), 'locked');
        if (h.state !== 'healthy' || !h.idle) throw new Error(`asleep ${JSON.stringify(h)}`);
        await report('locked', statusDoc(Date.now(), { recording: 'paused', reason: 'locked' }));
      });

      await ctx.step('the owner (capture.manage) gets one capture_device_down per not-recording computer, the member (no capture.manage) none; reading the status again writes no second alert', async () => {
        const ownerId = ctx.P.OWNER.userId!;
        await report('stalled', stalledDoc);
        await report('silent', silentDoc);
        if ((await stored('capture_device_down', ownerId)) !== 2) throw new Error(`owner down rows ${await stored('capture_device_down', ownerId)}`);
        if ((await stored('capture_device_down', member.userId!)) !== 0) throw new Error('the member got an alert');
        const rows = await db.query<{ dedupe_key: string; body: string; title: string }>(
          `SELECT dedupe_key, body, title FROM kortix.notifications WHERE account_id = $1 AND user_id = $2 AND kind = 'capture_device_down' ORDER BY dedupe_key`,
          [team.id, ownerId],
        );
        const keys = rows.rows.map((r) => r.dedupe_key.split(':')[1]).sort();
        const want = [computers.get('stalled')!.device_id, computers.get('silent')!.device_id].sort();
        if (JSON.stringify(keys) !== JSON.stringify(want) || !rows.rows.every((r) => /^capture-down:[0-9a-f-]{36}:\d+$/.test(r.dedupe_key))) throw new Error(`keys ${JSON.stringify(rows.rows)}`);
        if (!rows.rows.some((r) => /^No report for \d+ min\.$/.test(r.body)) || !rows.rows.some((r) => /^No new frame for \d+ min while the computer was awake\.$/.test(r.body))) throw new Error(`bodies ${JSON.stringify(rows.rows)}`);
        for (let again = 0; again < 2; again++) await report('silent', silentDoc);
        if ((await stored('capture_device_down', ownerId)) !== 2) throw new Error('a repeat read wrote a second alert');
      });

      await ctx.step('the alert is in the owner’s inbox and opens the account’s Devices page', async () => {
        const url = (await owner.get(path(R.inbox), { query: { limit: 50 } })).status(200).json<{ notifications: Array<{ kind: string; url: string; title: string }> }>();
        // The owner persona is shared with the other flows, which leave alerts of their own: count this account's.
        const rows = url.notifications.filter((n) => n.kind === 'capture_device_down' && n.url.startsWith(`/capture/${team.id}/`));
        if (rows.length !== 2) throw new Error(`inbox ${JSON.stringify(url.notifications)}`);
        if (!rows.every((n) => n.url.startsWith(`/capture/${team.id}/devices?notification=`))) throw new Error(`urls ${JSON.stringify(rows)}`);
      });

      await ctx.step('both computers record again → the owner gets one capture_device_recovered each, no new down; a repeat read writes no second recovery', async () => {
        const ownerId = ctx.P.OWNER.userId!;
        for (const name of ['stalled', 'silent'] as const) await report(name, statusDoc(Date.now()));
        if ((await stored('capture_device_recovered', ownerId)) !== 2) throw new Error(`recovered ${await stored('capture_device_recovered', ownerId)}`);
        for (const name of ['stalled', 'silent'] as const) await report(name, statusDoc(Date.now()));
        if ((await stored('capture_device_recovered', ownerId)) !== 2 || (await stored('capture_device_down', ownerId)) !== 2) throw new Error('a repeat read wrote more rows');
        const f = await fleet();
        if (f.health.not_recording !== 0 || f.health.attention !== 1 || f.health.recording !== 3 || f.health.idle !== 1) throw new Error(`after ${JSON.stringify(f.health)}`);
      });

      await ctx.step('a new not-recording spell on the same computer alerts again (a new spell key)', async () => {
        const ownerId = ctx.P.OWNER.userId!;
        await report('stalled', statusDoc(Date.now(), { lastFrameMs: Date.now() - 35 * MIN, host: { awakeSinceMs: Date.now() - 3_600_000 } }));
        if ((await stored('capture_device_down', ownerId)) !== 3) throw new Error(`second spell ${await stored('capture_device_down', ownerId)}`);
      });
    } finally {
      await db.end();
    }
  },
);
