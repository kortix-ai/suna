/**
 * CAP-1 — Kortix Capture, the cloud side. Contract: tests/spec/end-to-end.md.
 * A paired machine uploads synthetic mp4 bytes and synthetic frames through the
 * machine API; members and admins read them through the user API. Every byte
 * and every frame in this flow is synthetic.
 */
import { strict as assert } from "node:assert";
import { flow } from "../core/flow";
import { waitFor } from "../core/poll";
import { startPairing } from "../fixtures/tunnel";

const SETTINGS = "/v1/accounts/:accountId/capture/settings";
const SEARCH = "/v1/accounts/:accountId/capture/search";

flow(
  "CAP-1",
  {
    domain: "capture",
    timeoutMs: 180_000,
    serial: true,
    routes: [
      "POST /v1/tunnel/device-auth",
      "GET /v1/tunnel/device-auth/:code/status",
      "POST /v1/tunnel/device-auth/:code/approve",
      "GET /v1/capture/agent/config",
      "POST /v1/capture/agent/chunks",
      "POST /v1/capture/agent/chunks/:chunkId/commit",
      "GET /v1/capture/devices",
      "PUT /v1/capture/devices/:deviceId",
      "GET /v1/accounts/:accountId/capture/settings",
      "PUT /v1/accounts/:accountId/capture/settings",
      "GET /v1/accounts/:accountId/capture/search",
      "GET /v1/accounts/:accountId/capture/timeline",
      "GET /v1/accounts/:accountId/capture/chunks/:chunkId/video",
      "GET /v1/accounts/:accountId/capture/frames/:frameId",
      "DELETE /v1/accounts/:accountId/capture/data",
      "GET /v1/accounts/:accountId/audit",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team({ enterprise: true });
    const owner = ctx.client.as(ctx.P.OWNER);
    const anon = ctx.client.as(ctx.P.ANON);
    // The recording member has a personal account (created at first sign-in),
    // where a privately paired machine lives until the member moves it.
    const memberP = await ctx.fixtures.user({ label: "CAP-MEMBER" });
    (
      await owner.post("/v1/accounts/:accountId/members", { email: memberP.email, role: "member" }, { params: { accountId: team.id } })
    ).status(201);
    const otherP = await team.addMember("member");
    const adminP = await team.addMember("admin");
    const member = ctx.client.as(memberP);
    const other = ctx.client.as(otherP);
    const admin = ctx.client.as(adminP);
    const params = { accountId: team.id };
    const phrase = `zebrafish${Date.now().toString(36)}`;
    const video = new Uint8Array(4096).map((_, i) => (i * 7) % 251);
    let tunnelId = "";
    let machine = anon;
    let deviceId = "";
    let chunkId = "";
    let frameId = 0;
    let videoUrl = "";

    const audit = async (action: string) =>
      (
        await waitFor(
          async () => (await owner.get("/v1/accounts/:accountId/audit", { params, query: { action, limit: 20 } })).json<any>().events,
          { until: (events: any[]) => events.length > 0, timeoutMs: 20_000, intervalMs: 500, description: `audit ${action}` },
        )
      ) as any[];

    await ctx.step("OWNER enables capture for the account; a member reads it and sees admins cannot view", async () => {
      (await member.put(SETTINGS, { enabled: true }, { params })).status(403);
      (await other.get(SETTINGS, { params })).status(200).body().has("$.enabled", false).has("$.retention_days", 30);
      (await owner.put(SETTINGS, { enabled: true, retention_days: 14 }, { params }))
        .status(200)
        .body()
        .has("$.enabled", true)
        .has("$.retention_days", 14)
        .has("$.admins_can_view", false);
      (await member.get(SETTINGS, { params })).status(200).body().has("$.enabled", true).has("$.admins_can_view", false);
      (await owner.put(SETTINGS, { retention_days: 0 }, { params })).status(400);
      (await ctx.client.as(ctx.P.NONMEMBER).get(SETTINGS, { params })).status(403);
      const events = await audit("capture.settings.changed");
      assert.equal(events[0].actor_user_id, ctx.P.OWNER.userId);
    });

    await ctx.step("a member pairs a machine; capture stays off until the member moves it to the team and turns it on", async () => {
      // A team member who never had a personal account pairs a machine into an account
      // that does not exist: no account holds its device row (409 CAPTURE_NO_ACCOUNT).
      const bare = await startPairing(anon, { machineHostname: `${ctx.fixtures.name("bare")}.local` });
      bare.status(201);
      const bareApproved = await other.post(
        "/v1/tunnel/device-auth/:code/approve",
        { name: ctx.fixtures.name("bare"), capabilities: [] },
        { params: { code: bare.json<any>().deviceCode } },
      );
      bareApproved.status(200);
      ctx.track("tunnelConnection", bareApproved.json<any>().tunnelId);
      const bareToken = (
        await anon
          .withBearer(bare.json<any>().deviceSecret)
          .get("/v1/tunnel/device-auth/:code/status", { params: { code: bare.json<any>().deviceCode } })
      ).json<any>().token;
      (
        await anon
          .withBearer(bareToken)
          .get("/v1/capture/agent/config", { headers: { "x-tunnel-id": bareApproved.json<any>().tunnelId } })
      )
        .status(409)
        .body()
        .has("$.code", "CAPTURE_NO_ACCOUNT");

      const created = await startPairing(anon, { machineHostname: `${ctx.fixtures.name("cap")}.local` });
      created.status(201);
      const { deviceCode, deviceSecret } = created.json<any>();
      const approved = await member.post(
        "/v1/tunnel/device-auth/:code/approve",
        { name: ctx.fixtures.name("laptop"), capabilities: [] },
        { params: { code: deviceCode } },
      );
      approved.status(200);
      tunnelId = approved.json<any>().tunnelId;
      ctx.track("tunnelConnection", tunnelId);
      const poll = await anon
        .withBearer(deviceSecret)
        .get("/v1/tunnel/device-auth/:code/status", { params: { code: deviceCode } });
      poll.status(200).body().has("$.status", "approved");
      machine = anon.withBearer(poll.json<any>().token);
      const h = { headers: { "x-tunnel-id": tunnelId } };

      (await anon.get("/v1/capture/agent/config", h)).status(401);
      (await machine.get("/v1/capture/agent/config", { headers: { "x-tunnel-id": "not-a-uuid" } })).status(400);
      (await machine.get("/v1/capture/agent/config", h))
        .status(200)
        .body()
        .has("$.capture_allowed", false)
        .has("$.device_enabled", false)
        .has("$.poll_seconds", 60);

      const devices = (await member.get("/v1/capture/devices")).status(200).json<any>().devices;
      const device = devices.find((d: any) => d.tunnel_id === tunnelId);
      assert.ok(device, "the machine shows in its owner's device list");
      deviceId = device.id;
      assert.equal(device.enabled, false);
      assert.equal((await other.get("/v1/capture/devices")).json<any>().devices.length, 0);
      (await other.put("/v1/capture/devices/:deviceId", { enabled: true }, { params: { deviceId } })).status(404);
      (await member.put("/v1/capture/devices/:deviceId", { account_id: ctx.P.NONMEMBER.userId }, { params: { deviceId } })).status(403);

      (await member.put("/v1/capture/devices/:deviceId", { account_id: team.id }, { params: { deviceId } }))
        .status(200)
        .body()
        .has("$.account_id", team.id);
      (await machine.get("/v1/capture/agent/config", h))
        .status(200)
        .body()
        .has("$.account_enabled", true)
        .has("$.device_enabled", false)
        .has("$.capture_allowed", false);
      const body = {
        client_uid: "c1",
        started_at: "2026-10-01T10:00:00Z",
        ended_at: "2026-10-01T10:05:00Z",
        frame_count: 2,
        width: 1920,
        height: 1080,
        codec: "hevc",
        video_bytes: video.byteLength,
        video_sha256: new Bun.CryptoHasher("sha256").update(video).digest("hex"),
      };
      (await machine.post("/v1/capture/agent/chunks", body, h)).status(403).body().has("$.code", "CAPTURE_DISABLED");
      (await member.put("/v1/capture/devices/:deviceId", { enabled: true }, { params: { deviceId } })).status(200);
      (await machine.get("/v1/capture/agent/config", h)).status(200).body().has("$.capture_allowed", true);
      (await member.put("/v1/capture/devices/:deviceId", { paused_until: new Date(Date.now() + 3600_000).toISOString() }, { params: { deviceId } })).status(200);
      (await machine.get("/v1/capture/agent/config", h)).status(200).body().has("$.capture_allowed", false);
      (await member.put("/v1/capture/devices/:deviceId", { paused_until: null }, { params: { deviceId } })).status(200);
      (await machine.get("/v1/capture/agent/config", h)).status(200).body().has("$.capture_allowed", true);
    });

    await ctx.step("the machine uploads a chunk: presign, PUT the mp4, commit the frames; retries are idempotent", async () => {
      const h = { headers: { "x-tunnel-id": tunnelId } };
      const body = {
        client_uid: "c1",
        started_at: "2026-10-01T10:00:00Z",
        ended_at: "2026-10-01T10:05:00Z",
        frame_count: 2,
        width: 1920,
        height: 1080,
        codec: "hevc",
        video_bytes: video.byteLength,
        video_sha256: new Bun.CryptoHasher("sha256").update(video).digest("hex"),
      };
      (await machine.post("/v1/capture/agent/chunks", { ...body, codec: "vp9" }, h)).status(400);
      (await machine.post("/v1/capture/agent/chunks", { ...body, video_bytes: 201 * 1024 * 1024 }, h)).status(400);
      const reg = (await machine.post("/v1/capture/agent/chunks", body, h)).status(200).json<any>();
      chunkId = reg.chunk_id;
      assert.equal(reg.already_committed, false);
      assert.equal(reg.upload.method, "PUT");

      const frames = [
        { frame_index: 0, ts: "2026-10-01T10:00:00Z", app_bundle: "com.apple.Terminal", app_name: "Terminal", window_title: "deploy", text: `${phrase} rollout restarted` },
        { frame_index: 1, ts: "2026-10-01T10:02:30Z", app_name: "Safari", url: "https://example.com/plan", domain: "example.com", window_title: "Plan", text: "quarterly planning notes" },
      ];
      const commit = `/v1/capture/agent/chunks/:chunkId/commit`;
      const cp = { params: { chunkId }, ...h };
      (await machine.post(commit, { frames }, cp)).status(409).body().has("$.code", "CAPTURE_UPLOAD_MISSING");

      const wrong = await fetch(reg.upload.url, { method: "PUT", headers: reg.upload.headers, body: video.slice(0, 100) });
      assert.ok(!wrong.ok, `an upload of the wrong size is refused (got ${wrong.status})`);
      const put = await fetch(reg.upload.url, { method: reg.upload.method, headers: reg.upload.headers, body: video });
      assert.equal(put.status, 200, await put.text());

      (await machine.post(commit, { frames: [{ frame_index: "x" }] }, cp)).status(400);
      (await machine.post(commit, { frames }, cp)).status(200).body().has("$.ok", true).has("$.frames", 2);
      (await machine.post(commit, { frames }, cp)).status(200).body().has("$.frames", 2);
      (await machine.post("/v1/capture/agent/chunks", body, h))
        .status(200)
        .body()
        .has("$.chunk_id", chunkId)
        .has("$.already_committed", true);
      (await machine.post(commit, { frames }, { params: { chunkId: "00000000-0000-4000-8000-000000000000" }, ...h })).status(404);
    });

    await ctx.step("the member searches, reads the frame and the timeline, and plays the video", async () => {
      const found = (await member.get(SEARCH, { params, query: { q: phrase } })).status(200).json<any>();
      assert.equal(found.items.length, 1);
      const item = found.items[0];
      assert.equal(item.chunk_id, chunkId);
      assert.equal(item.app_name, "Terminal");
      assert.ok(item.snippet.includes(phrase));
      assert.equal(found.next_cursor, null);
      frameId = item.frame_id;

      const page1 = (await member.get(SEARCH, { params, query: { limit: 1 } })).status(200).json<any>();
      assert.equal(page1.items.length, 1);
      assert.ok(page1.next_cursor);
      assert.equal(page1.items[0].app_name, "Safari", "newest frame first");
      const page2 = (await member.get(SEARCH, { params, query: { limit: 1, cursor: page1.next_cursor } })).status(200).json<any>();
      assert.equal(page2.items[0].frame_id, frameId);
      assert.equal(page2.next_cursor, null);
      const byDomain = (await member.get(SEARCH, { params, query: { domain: "example.com" } })).json<any>();
      assert.equal(byDomain.items.length, 1);
      const none = (await member.get(SEARCH, { params, query: { q: phrase, to: "2026-10-01T09:00:00Z" } })).json<any>();
      assert.equal(none.items.length, 0);
      (await member.get(SEARCH, { params, query: { cursor: "garbage" } })).status(400);

      (await member.get("/v1/accounts/:accountId/capture/frames/:frameId", { params: { ...params, frameId } }))
        .status(200)
        .body()
        .has("$.app_name", "Terminal")
        .has("$.text", `${phrase} rollout restarted`);
      const timeline = (
        await member.get("/v1/accounts/:accountId/capture/timeline", {
          params,
          query: { from: "2026-10-01T00:00:00Z", to: "2026-10-02T00:00:00Z" },
        })
      )
        .status(200)
        .json<any>();
      assert.equal(timeline.chunks.length, 1);
      assert.equal(timeline.chunks[0].chunk_id, chunkId);
      assert.deepEqual(timeline.apps.map((a: any) => [a.app_name, a.seconds]).sort(), [["Safari", 150], ["Terminal", 150]]);

      const link = (await member.get("/v1/accounts/:accountId/capture/chunks/:chunkId/video", { params: { ...params, chunkId } }))
        .status(200)
        .json<any>();
      videoUrl = link.url;
      const dl = await fetch(link.url);
      assert.equal(dl.status, 200);
      assert.deepEqual(new Uint8Array(await dl.arrayBuffer()), video);
    });

    await ctx.step("a second member sees nothing of it; so does an admin while admins_can_view is off", async () => {
      const q = { q: phrase };
      assert.equal((await other.get(SEARCH, { params, query: q })).status(200).json<any>().items.length, 0);
      for (const who of [other, admin]) {
        (await who.get(SEARCH, { params, query: { ...q, user_id: memberP.userId! } })).status(403).body().has("$.code", "CAPTURE_MEMBER_VIEW_FORBIDDEN");
        (await who.get("/v1/accounts/:accountId/capture/frames/:frameId", { params: { ...params, frameId } })).status(403);
        (await who.get("/v1/accounts/:accountId/capture/chunks/:chunkId/video", { params: { ...params, chunkId } })).status(403);
        (await who.get("/v1/accounts/:accountId/capture/timeline", { params, query: { user_id: memberP.userId! } })).status(403);
      }
      (await owner.get(SEARCH, { params, query: { ...q, user_id: memberP.userId! } })).status(403);
    });

    await ctx.step("only the OWNER enables admins_can_view; then the admin reads the member's captures and each read is audited", async () => {
      (await admin.put(SETTINGS, { admins_can_view: true }, { params })).status(403);
      (await admin.put(SETTINGS, { retention_days: 20 }, { params })).status(200).body().has("$.retention_days", 20);
      (await owner.put(SETTINGS, { admins_can_view: true }, { params })).status(200).body().has("$.admins_can_view", true);
      (await member.get(SETTINGS, { params })).status(200).body().has("$.admins_can_view", true);
      (await other.get(SEARCH, { params, query: { q: phrase, user_id: memberP.userId! } })).status(403);

      const r = (await admin.get(SEARCH, { params, query: { q: phrase, user_id: memberP.userId! } })).status(200).json<any>();
      assert.equal(r.items.length, 1);
      (await admin.get("/v1/accounts/:accountId/capture/frames/:frameId", { params: { ...params, frameId } })).status(200).body().has("$.user_id", memberP.userId);
      (await admin.get("/v1/accounts/:accountId/capture/chunks/:chunkId/video", { params: { ...params, chunkId } })).status(200).body().exists("$.url");
      const views = await waitFor(() => audit("capture.member_view"), {
        until: (events: any[]) => events.length >= 3,
        timeoutMs: 20_000,
        intervalMs: 500,
        description: "three member_view events",
      });
      for (const event of views) {
        assert.equal(event.actor_user_id, adminP.userId);
        assert.equal(event.resource_id, memberP.userId);
      }
      // An admin reading their OWN captures writes no member_view.
      const before = views.length;
      (await admin.get(SEARCH, { params, query: { q: phrase } })).status(200);
      assert.equal((await audit("capture.member_view")).length, before);
    });

    await ctx.step("a member deletes their own data: the chunk, the frames and the video are gone for everyone", async () => {
      (await other.del("/v1/accounts/:accountId/capture/data", { params })).status(200).body().has("$.deleted_chunks", 0);
      assert.equal((await member.get(SEARCH, { params, query: { q: phrase } })).json<any>().items.length, 1, "another member's delete leaves it");
      (await member.del("/v1/accounts/:accountId/capture/data", { params })).status(200).body().has("$.deleted_chunks", 1);
      assert.equal((await member.get(SEARCH, { params, query: { q: phrase } })).json<any>().items.length, 0);
      assert.equal((await admin.get(SEARCH, { params, query: { q: phrase, user_id: memberP.userId! } })).json<any>().items.length, 0);
      (await member.get("/v1/accounts/:accountId/capture/frames/:frameId", { params: { ...params, frameId } })).status(404);
      (await member.get("/v1/accounts/:accountId/capture/chunks/:chunkId/video", { params: { ...params, chunkId } })).status(404);
      assert.ok(!(await fetch(videoUrl)).ok, "the object is deleted from storage: the earlier signed URL no longer serves it");
    });
  },
);
