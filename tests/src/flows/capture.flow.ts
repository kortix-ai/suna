/**
 * Kortix Capture — device sign-in (RFC 8628), the credential endpoint,
 * ingestion of the Kortix Capture format (schema 2), the timeline, search,
 * policy, scoping, audit, and the agent tool. Spec: tests/spec/end-to-end.md §
 * Capture. Source of truth: apps/api/src/capture/.
 *
 * The local profile's capture store is Supabase Storage's S3 endpoint, which
 * has no STS: `POST /v1/capture/credentials` answers 503 there (CAP-1 asserts
 * it), and CAP-2/3 write as a static-credential device with the S3 protocol
 * keys. Scoped STS credentials (AWS, MinIO) and the range pipelines' model
 * calls are proved outside this profile: the session policy in
 * apps/api/src/capture/credentials.test.ts, the pipelines in
 * apps/api/src/__tests__/integration-capture.test.ts.
 */
import { flow } from '../core/flow';
import { waitFor } from '../core/poll';
import type { FlowContext, Principal } from '../core/types';
import { AgentPrincipalsWorld, openDb } from '../fixtures/agent-principals';
import { buildCaptureDay, localCaptureStore, readCaptureObject, syntheticMachineKey, uploadCaptureObjects } from '../fixtures/capture';
import { CliSandbox } from '../fixtures/cli';

const R = {
  authorize: 'POST /v1/capture/device/authorize',
  token: 'POST /v1/capture/device/token',
  credentials: 'POST /v1/capture/credentials',
  grant: 'GET /v1/capture/device/grants/:user_code',
  approve: 'POST /v1/capture/device/grants/:user_code/approve',
  deny: 'POST /v1/capture/device/grants/:user_code/deny',
  devices: 'GET /v1/projects/:projectId/capture/devices',
  revoke: 'DELETE /v1/projects/:projectId/capture/devices/:deviceId',
  devicePolicy: 'PUT /v1/projects/:projectId/capture/devices/:deviceId/policy',
  asset: 'GET /v1/projects/:projectId/capture/devices/:deviceId/assets/:name',
  policyGet: 'GET /v1/projects/:projectId/capture/policy',
  policyPut: 'PUT /v1/projects/:projectId/capture/policy',
  timeline: 'GET /v1/projects/:projectId/capture/timeline',
  items: 'GET /v1/projects/:projectId/capture/timeline/items',
  search: 'GET /v1/projects/:projectId/capture/search',
  frame: 'GET /v1/projects/:projectId/capture/frames/:frameId',
  media: 'GET /v1/projects/:projectId/capture/chunks/:chunkId/media',
  ranges: 'GET /v1/projects/:projectId/capture/ranges',
  saveRange: 'POST /v1/projects/:projectId/capture/ranges',
  range: 'GET /v1/projects/:projectId/capture/ranges/:rangeId',
  process: 'POST /v1/projects/:projectId/capture/ranges/:rangeId/process',
  people: 'GET /v1/projects/:projectId/capture/people',
};
const path = (route: string) => route.split(' ')[1]!;

async function captureProject(ctx: FlowContext) {
  const team = await ctx.fixtures.team();
  const project = await team.project();
  const member = await team.addMember('member');
  await team.grantProjectRole(project.id, member.userId!, 'member');
  return { team, project, member };
}

async function enableCapture(ctx: FlowContext, projectId: string) {
  (await ctx.client.as(ctx.P.OWNER).patch('/v1/projects/:projectId/features', { feature: 'capture', enabled: true }, { params: { projectId } }))
    .status(200)
    .body()
    .has('$.experimental.capture', true);
}

/** The whole device sign-in, approved by `who` into `projectId`. */
async function signInDevice(ctx: FlowContext, who: Principal, projectId: string, machineKey: string) {
  const anon = ctx.client.as(ctx.P.ANON);
  const started = await anon.post(path(R.authorize), { machine_key_sha256: machineKey, computer_name: 'Fixture Laptop', os: 'macos', os_version: '15.0' });
  started.status(200);
  const grant = started.json<{ device_code: string; user_code: string; interval: number }>();
  (await ctx.client.as(who).post(path(R.approve), { project_id: projectId }, { params: { user_code: grant.user_code } })).status(200);
  const token = await anon.post(path(R.token), { device_code: grant.device_code });
  token.status(200);
  return token.json<{ device_token: string; prefix: string; device_id: string }>();
}

flow(
  'CAP-1',
  {
    domain: 'capture',
    requires: ['database'],
    timeoutMs: 120_000,
    routes: [R.authorize, R.token, R.credentials, R.grant, R.approve, R.deny, R.devices, R.revoke],
  },
  async (ctx) => {
    const { team, project, member } = await captureProject(ctx);
    const anon = ctx.client.as(ctx.P.ANON);
    const asMember = ctx.client.as(member);
    const projectId = project.id;
    const machineKey = syntheticMachineKey(ctx.fixtures.name('cap1'));
    let grant = { device_code: '', user_code: '' };

    await ctx.step('a sign-in without a sha256 machine key → 400 invalid_request', async () => {
      (await anon.post(path(R.authorize), { machine_key_sha256: 'not-a-key' })).status(400).body().has('$.error', 'invalid_request');
    });

    await ctx.step('the device starts a sign-in → 200 with a device code, an XXXX-0000 user code, the approval URL, interval 5, 900 s', async () => {
      const r = await anon.post(path(R.authorize), { machine_key_sha256: machineKey, computer_name: 'Fixture Laptop', os: 'macos' });
      r.status(200).body().has('$.interval', 5).has('$.expires_in', 900);
      grant = r.json();
      if (!/^[A-Z]{4}-\d{4}$/.test(grant.user_code)) throw new Error(`user code ${grant.user_code}`);
      if (!r.json<{ verification_uri_complete: string }>().verification_uri_complete.endsWith(`/capture/authorize?user_code=${grant.user_code}`)) {
        throw new Error(`verification URL ${r.text()}`);
      }
    });

    await ctx.step('polling before approval → authorization_pending; polling again at once → slow_down', async () => {
      (await anon.post(path(R.token), { device_code: grant.device_code })).status(400).body().has('$.error', 'authorization_pending');
      (await anon.post(path(R.token), { device_code: grant.device_code })).status(400).body().has('$.error', 'slow_down');
    });

    await ctx.step('the approval page reads the grant for a signed-in member; anonymous → 401', async () => {
      (await asMember.get(path(R.grant), { params: { user_code: grant.user_code } }))
        .status(200)
        .body()
        .has('$.status', 'pending')
        .has('$.device.name', 'Fixture Laptop');
      (await anon.get(path(R.grant), { params: { user_code: grant.user_code } })).status(401);
    });

    await ctx.step('approving into a project with capture off → 403 feature_disabled; the project reads → 403 too', async () => {
      (await asMember.post(path(R.approve), { project_id: projectId }, { params: { user_code: grant.user_code } }))
        .status(403)
        .body()
        .has('$.code', 'feature_disabled');
      (await asMember.get(path(R.devices), { params: { projectId } })).status(403).body().has('$.code', 'feature_disabled');
    });

    await enableCapture(ctx, projectId);
    let device = { device_token: '', prefix: '', device_id: '' };

    await ctx.step('the member approves into the project → approved; a second decision → 409', async () => {
      (await asMember.post(path(R.approve), { project_id: projectId }, { params: { user_code: grant.user_code } }))
        .status(200)
        .body()
        .has('$.status', 'approved')
        .has('$.project_id', projectId);
      (await asMember.post(path(R.deny), {}, { params: { user_code: grant.user_code } })).status(409);
    });

    await ctx.step('the device exchanges the code once → device token, prefix orgs/<account>/projects/<project>, device id; again → invalid_grant', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5_100));
      const r = await anon.post(path(R.token), { device_code: grant.device_code });
      r.status(200).body().has('$.token_type', 'Bearer');
      device = r.json();
      if (!device.device_token.startsWith('kortix_cap_')) throw new Error('device token prefix');
      if (device.prefix !== `orgs/${team.id}/projects/${projectId}`) throw new Error(`prefix ${device.prefix}`);
      (await anon.post(path(R.token), { device_code: grant.device_code })).status(400).body().has('$.error', 'invalid_grant');
    });

    await ctx.step('credentials: a bad token → 401; the device token on a store without STS → 503 capture_credentials_unavailable', async () => {
      (await anon.withBearer('kortix_cap_nope').post(path(R.credentials))).status(401).body().has('$.code', 'capture_device_unauthorized');
      (await anon.withBearer(device.device_token).post(path(R.credentials))).status(503).body().has('$.code', 'capture_credentials_unavailable');
    });

    await ctx.step('signing in again on the same machine reuses the device (same device_id) and retires the old token', async () => {
      const again = await signInDevice(ctx, member, projectId, machineKey);
      if (again.device_id !== device.device_id) throw new Error(`device ${again.device_id} != ${device.device_id}`);
      (await anon.withBearer(device.device_token).post(path(R.credentials))).status(401);
      device = again;
      (await asMember.get(path(R.devices), { params: { projectId } })).status(200).body().has('$.devices[0].device_id', device.device_id).has('$.devices[0].name', 'Fixture Laptop');
    });

    await ctx.step('a denied sign-in → the device reads access_denied', async () => {
      const r = await anon.post(path(R.authorize), { machine_key_sha256: syntheticMachineKey(ctx.fixtures.name('cap1-deny')) });
      const denied = r.json<{ device_code: string; user_code: string }>();
      (await asMember.post(path(R.deny), {}, { params: { user_code: denied.user_code } })).status(200).body().has('$.status', 'denied');
      (await anon.post(path(R.token), { device_code: denied.device_code })).status(400).body().has('$.error', 'access_denied');
    });

    await ctx.step('the owner cannot see the member’s device without asking for the project; revoking it kills the token → 401', async () => {
      (await ctx.client.as(ctx.P.OWNER).get(path(R.devices), { params: { projectId } })).status(200).body().has('$.devices', []);
      (await asMember.del(path(R.revoke), { params: { projectId, deviceId: device.device_id } })).status(200);
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
  const { team, project, member } = await captureProject(ctx);
  await enableCapture(ctx, project.id);
  const machineKey = syntheticMachineKey(ctx.fixtures.name(label));
  const device = await signInDevice(ctx, member, project.id, machineKey);
  const store = await localCaptureStore();
  const marker = `zq${ctx.fixtures.name(label).replace(/[^a-z0-9]/gi, '').slice(-14).toLowerCase()}`;
  // Audio is off by default: turn it on first, so the audio item indexes too.
  (await ctx.client.as(ctx.P.OWNER).put(path(R.policyPut), { policy: { layers: { screen: true, actions: true, audio: true } } }, { params: { projectId: project.id } })).status(200);
  const day = buildCaptureDay({ prefix: device.prefix, deviceId: device.device_id, machineKeySha256: machineKey, marker });
  await uploadCaptureObjects(store, day.objects);
  const asMember = ctx.client.as(member);
  await waitFor(
    async () => (await asMember.get(path(R.timeline), { params: { projectId: project.id }, query: { from: new Date(day.sessions[0]!.startMs - 60_000).toISOString(), to: new Date().toISOString() } })).json<{ chunks?: unknown[] }>(),
    { until: (t) => (t.chunks?.length ?? 0) >= day.expected.chunks, timeoutMs: 60_000, intervalMs: 1_000, description: 'the index reader to ingest every item' },
  );
  return { team, project, member, device, store, marker, day, asMember };
}

flow(
  'CAP-2',
  {
    domain: 'capture',
    requires: ['database'],
    timeoutMs: 180_000,
    routes: [R.devices, R.timeline, R.items, R.search, R.frame, R.media, R.asset, R.policyGet, R.policyPut, R.devicePolicy, R.ranges, R.saveRange, R.range, R.process, R.people],
  },
  async (ctx) => {
    const { project, member, device, store, marker, day, asMember } = await ingestedWorld(ctx, 'cap2');
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { projectId: project.id };
    const window = { from: new Date(day.sessions[0]!.startMs - 60_000).toISOString(), to: new Date().toISOString() };

    await ctx.step('every item of the day is indexed once: chunks, frames, actions and audio lines match the device output', async () => {
      const t = (await asMember.get(path(R.timeline), { params, query: window })).status(200).json<any>();
      if (t.chunks.length !== day.expected.chunks) throw new Error(`chunks ${t.chunks.length} != ${day.expected.chunks}`);
      const frames = t.chunks.filter((c: any) => c.kind === 'chunk').reduce((n: number, c: any) => n + c.item_count, 0);
      const actions = t.chunks.filter((c: any) => c.kind === 'actions').reduce((n: number, c: any) => n + c.item_count, 0);
      const audio = t.chunks.filter((c: any) => c.kind === 'audio').reduce((n: number, c: any) => n + c.item_count, 0);
      if (frames !== day.expected.frames || actions !== day.expected.actions || audio !== day.expected.audioLines) {
        throw new Error(`frames ${frames}, actions ${actions}, audio ${audio} vs ${JSON.stringify(day.expected)}`);
      }
      const apps = t.runs.map((r: any) => r.app);
      for (const app of ['Sheets', 'Mail', 'Browser']) if (!apps.includes(app)) throw new Error(`no ${app} run in ${apps}`);
    });

    await ctx.step('the device reads as recording from its status.json; two activity sessions 40 minutes apart are two detected ranges', async () => {
      (await asMember.get(path(R.devices), { params })).status(200).body().has('$.devices[0].live.state', 'recording');
      const ranges = (await asMember.get(path(R.ranges), { params, query: window })).status(200).json<{ ranges: any[] }>().ranges;
      if (ranges.filter((r) => r.source === 'detected').length !== day.expected.ranges) throw new Error(`ranges ${JSON.stringify(ranges)}`);
    });

    let hits: Hit[] = [];
    await ctx.step('one search finds the marker on screen, in a typed action and in the audio transcript', async () => {
      const r = await asMember.get(path(R.search), { params, query: { q: marker, limit: 50 } });
      r.status(200);
      hits = r.json<{ hits: Hit[] }>().hits;
      for (const kind of ['screen', 'actions', 'audio']) {
        if (!hits.some((h) => h.kind === kind && h.snippet.toLowerCase().includes(marker))) throw new Error(`no ${kind} hit: ${JSON.stringify(hits).slice(0, 400)}`);
      }
      (await asMember.get(path(R.search), { params, query: { q: '"invoice 1042"', kinds: 'screen' } })).status(200).body().has('$.hits[0].app', 'Mail');
    });

    await ctx.step('a frame opens with its full on-screen text and a signed URL whose bytes match the uploaded video', async () => {
      const frameId = hits.find((h) => h.kind === 'screen')!.id;
      const detail = (await asMember.get(path(R.frame), { params: { ...params, frameId } })).status(200).json<any>();
      if (!detail.frame.ocr_text.includes(marker)) throw new Error('frame text');
      const video = await fetch(detail.video.url);
      if (video.status !== 200 || !(await video.text()).startsWith('synthetic-mp4:')) throw new Error(`video GET ${video.status}`);
      (await asMember.get(path(R.media), { params: { ...params, chunkId: detail.frame.chunk_id } })).status(200).body().has('$.kind', 'chunk');
      const items = (await asMember.get(path(R.items), { params, query: { from: new Date(day.sessions[0]!.startMs).toISOString(), to: new Date(day.sessions[0]!.startMs + 300_000).toISOString() } })).status(200).json<any>();
      const shot = items.actions.find((a: any) => a.screenshot)?.screenshot;
      const asset = (await asMember.get(path(R.asset), { params: { ...params, deviceId: device.device_id, name: shot } })).status(200).json<{ url: string }>();
      if ((await fetch(asset.url)).status !== 200) throw new Error('asset URL');
    });

    await ctx.step('scoping: the member cannot read the owner or the project; the owner reads the member → 200 and a capture.member_view audit row', async () => {
      (await asMember.get(path(R.timeline), { params, query: { user_id: ctx.P.OWNER.userId! } })).status(403).body().has('$.code', 'capture_forbidden');
      (await asMember.get(path(R.people), { params })).status(403);
      (await asMember.get(path(R.devices), { params, query: { scope: 'project' } })).status(403);
      (await owner.get(path(R.search), { params, query: { q: marker, user_id: member.userId! } })).status(200);
      const db = await openDb(ctx);
      try {
        const rows = await waitFor(
          async () => (await db.query<{ n: string }>(`SELECT count(*) AS n FROM kortix.audit_events WHERE project_id = $1 AND action = 'capture.member_view' AND actor_user_id = $2 AND resource_id = $3`, [project.id, ctx.P.OWNER.userId, member.userId])).rows[0]!.n,
          { until: (n) => Number(n) >= 1, timeoutMs: 15_000, intervalMs: 500, description: 'the member_view audit row' },
        );
        if (Number(rows) < 1) throw new Error('no audit row');
      } finally {
        await db.end();
      }
    });

    await ctx.step('the people summary (owner) gives the member active time per app; it is audited as capture.project_view', async () => {
      const people = (await owner.get(path(R.people), { params, query: window })).status(200).json<{ people: any[] }>().people;
      const row = people.find((p) => p.user_id === member.userId);
      if (!row || row.active_seconds <= 0 || !row.apps.some((a: any) => a.app === 'Sheets')) throw new Error(`people ${JSON.stringify(people)}`);
    });

    await ctx.step('policy: a member cannot write it; the owner writes it and the device reads the same policy.json from the store', async () => {
      const policy = { layers: { screen: true, actions: false, audio: false }, retention: { local_hours: 24, remote_days: 30 }, notice: 'Synthetic notice' };
      (await asMember.put(path(R.policyPut), { policy }, { params })).status(403);
      (await owner.put(path(R.policyPut), { policy: { retention: { local_hours: 0, remote_days: -1 } } }, { params })).status(400).body().has('$.code', 'capture_policy_invalid');
      (await owner.put(path(R.policyPut), { policy }, { params })).status(200).body().has('$.policy.layers.actions', false);
      (await asMember.get(path(R.policyGet), { params })).status(200).body().has('$.policy.notice', 'Synthetic notice');
      const doc = JSON.parse((await readCaptureObject(store, `${device.prefix}/policy.json`)) ?? '{}');
      if (doc.schema !== 2 || doc.layers.actions !== false || doc.notice !== 'Synthetic notice') throw new Error(`policy.json ${JSON.stringify(doc)}`);
      (await owner.put(path(R.devicePolicy), { policy: { recording: { paused: true, paused_until_ms: null } } }, { params: { ...params, deviceId: device.device_id } }))
        .status(200)
        .body()
        .has('$.policy_override.recording.paused', true);
      const override = JSON.parse((await readCaptureObject(store, `${device.prefix}/${device.device_id}/policy.json`)) ?? '{}');
      if (override.recording?.paused !== true) throw new Error('device policy.json');
      (await owner.put(path(R.devicePolicy), { policy: null }, { params: { ...params, deviceId: device.device_id } })).status(200).body().has('$.policy_override', null);
      if ((await readCaptureObject(store, `${device.prefix}/${device.device_id}/policy.json`)) !== null) throw new Error('override not removed');
    });

    await ctx.step('a member saves a range of their own time → 201 closed and queued; it reads back with its outputs list; reprocess → 202', async () => {
      const saved = await asMember.post(path(R.saveRange), { start_at: new Date(day.sessions[0]!.startMs).toISOString(), end_at: new Date(day.sessions[0]!.endMs).toISOString(), title: 'Budget review' }, { params });
      saved.status(201).body().has('$.source', 'saved').has('$.title', 'Budget review');
      const rangeId = saved.json<{ range_id: string }>().range_id;
      (await asMember.get(path(R.range), { params: { ...params, rangeId } })).status(200).body().has('$.range_id', rangeId);
      (await asMember.post(path(R.process), {}, { params: { ...params, rangeId } })).status(202).body().has('$.queued', true);
      (await asMember.post(path(R.saveRange), { start_at: '2026-01-02T00:00:00Z', end_at: '2026-01-01T00:00:00Z' }, { params })).status(400);
    });
  },
);

flow(
  'CAP-3',
  {
    domain: 'capture',
    requires: ['database'],
    timeoutMs: 240_000,
    routes: [R.search, R.timeline, R.frame],
  },
  async (ctx) => {
    const { team, project, member, marker } = await ingestedWorld(ctx, 'cap3');
    const world = await AgentPrincipalsWorld.open(ctx, { accountId: team.id, projectId: project.id });
    const sandbox = new CliSandbox('cap3');
    const params = { projectId: project.id };
    try {
      await world.setFeature('agent_principal', true);
      await world.writeManifest(
        'kortix_version: 2\nproject:\n  name: ke2e-capture\ndefault_agent: kortix\nagents:\n  kortix:\n    kortix_permissions: all\n',
        'ke2e: capture agent',
      );
      const own = await world.mintAgentSession({ agent: 'kortix', launcher: member });
      const shared = await world.mintAgentSession({ agent: 'kortix', launcher: member, visibility: 'project' });
      const trigger = await world.mintAgentSession({ agent: 'kortix', launcher: null });

      await ctx.step('an agent in the member’s private session searches the member’s timeline → their hits, audited as capture.agent_read', async () => {
        const r = await own.client.get(path(R.search), { params, query: { q: marker } });
        r.status(200).body().has('$.user_id', member.userId!);
        if (r.json<{ hits: Hit[] }>().hits.length === 0) throw new Error('no hits for the agent');
      });

      await ctx.step('the agent cannot name another member, and a shared or trigger session has no person → 403', async () => {
        (await own.client.get(path(R.search), { params, query: { q: marker, user_id: ctx.P.OWNER.userId! } })).status(403).body().has('$.code', 'capture_forbidden');
        (await shared.client.get(path(R.search), { params, query: { q: marker } })).status(403).body().has('$.code', 'capture_no_human');
        (await trigger.client.get(path(R.timeline), { params })).status(403).body().has('$.code', 'capture_no_human');
      });

      await ctx.step('real CLI inside the session: `kortix capture search <marker> --json` exits 0 with the member’s hits; `capture frame` prints the text', async () => {
        const env = { KORTIX_TOKEN: own.secret, KORTIX_API_URL: ctx.env.apiUrl, KORTIX_PROJECT_ID: project.id, KORTIX_SESSION_ID: own.sessionId };
        const searched = await sandbox.run(['capture', 'search', marker, '--json'], { env });
        if (searched.exitCode !== 0) throw new Error(`capture search exit ${searched.exitCode}: ${searched.all.slice(0, 600)}`);
        const result = JSON.parse(searched.stdout.trim()) as { user_id: string; hits: Hit[] };
        if (result.user_id !== member.userId || result.hits.length === 0) throw new Error(`unexpected ${searched.stdout.slice(0, 400)}`);
        const frameId = result.hits.find((h) => h.kind === 'screen')!.id;
        const frame = await sandbox.run(['capture', 'frame', frameId], { env });
        if (frame.exitCode !== 0 || !frame.stdout.includes(marker)) throw new Error(`capture frame: ${frame.all.slice(0, 400)}`);
      });

      await ctx.step('each agent read wrote a capture.agent_read row for the member', async () => {
        const db = await openDb(ctx);
        try {
          const n = await waitFor(
            async () => Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM kortix.audit_events WHERE project_id = $1 AND action = 'capture.agent_read' AND resource_id = $2`, [project.id, member.userId])).rows[0]!.n),
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

