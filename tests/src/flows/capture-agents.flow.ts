/**
 * CAP-2 — Kortix Capture for agents. Contract: tests/spec/end-to-end.md.
 * A session credential reads only the captures of the person the session acts
 * for. The same route answers a user, the real `kortix capture` CLI and the MCP
 * tools. Synthetic data only.
 */
import { strict as assert } from "node:assert";
import { flow } from "../core/flow";
import { waitFor } from "../core/poll";
import { CliSandbox } from "../fixtures/cli";
import { recordFrame, SessionCredentials } from "../fixtures/capture";

const SEARCH = "/v1/projects/:projectId/capture/search";
const TIMELINE = "/v1/projects/:projectId/capture/timeline";
const FRAME = "/v1/projects/:projectId/capture/frames/:frameId";
const rpc = (id: number, method: string, params: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id, method, params });

flow(
  "CAP-2",
  {
    domain: "capture",
    requires: ["database"],
    timeoutMs: 240_000,
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
      "PUT /v1/accounts/:accountId/capture/settings",
      "GET /v1/accounts/:accountId/capture/search",
      "GET /v1/accounts/:accountId/audit",
      "POST /v1/accounts/tokens",
      "GET /v1/projects/:projectId/capture/search",
      "GET /v1/projects/:projectId/capture/timeline",
      "GET /v1/projects/:projectId/capture/frames/:frameId",
      "POST /v1/mcp",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team({ enterprise: true });
    const owner = ctx.client.as(ctx.P.OWNER);
    const project = await team.project();
    const people = [] as Awaited<ReturnType<typeof ctx.fixtures.user>>[];
    for (const label of ["CAP2-A", "CAP2-B"]) {
      const p = await ctx.fixtures.user({ label });
      (await owner.post("/v1/accounts/:accountId/members", { email: p.email, role: "member" }, { params: { accountId: team.id } })).status(201);
      await team.grantProjectRole(project.id, p.userId!, "member");
      people.push(p);
    }
    const [a, b] = people as [(typeof people)[number], (typeof people)[number]];
    const params = { projectId: project.id };
    const phraseA = `zebrafish${Date.now().toString(36)}`;
    const phraseB = `okapi${Date.now().toString(36)}`;
    const creds = await SessionCredentials.open(ctx, team.id, project.id);
    const sandbox = new CliSandbox("cap2");
    let frameA = 0;
    let frameB = 0;
    let deviceA = "";
    const sessions = {} as Record<string, Awaited<ReturnType<SessionCredentials["mint"]>>>;
    const cliEnv = (secret: string) => ({ KORTIX_TOKEN: secret, KORTIX_PROJECT_ID: project.id, KORTIX_API_URL: ctx.env.apiUrl });
    const audit = async (action: string) =>
      (await waitFor(
        async () => (await owner.get("/v1/accounts/:accountId/audit", { params: { accountId: team.id }, query: { action, limit: 20 } })).json<any>().events,
        { until: (events: any[]) => events.length > 0, timeoutMs: 20_000, intervalMs: 500, description: `audit ${action}` },
      )) as any[];

    try {
      await ctx.step("capture is on for the account; two members each record one frame on their own machine", async () => {
        (await owner.put("/v1/accounts/:accountId/capture/settings", { enabled: true }, { params: { accountId: team.id } })).status(200);
        const ra = await recordFrame(ctx, { accountId: team.id, who: a, text: `${phraseA} release notes draft`, title: "Alpha notes", ts: "2026-10-01T10:00:00Z" });
        const rb = await recordFrame(ctx, { accountId: team.id, who: b, text: `${phraseB} hiring plan`, title: "Beta notes", ts: "2026-10-01T11:00:00Z" });
        frameA = ra.frameId;
        frameB = rb.frameId;
        deviceA = ra.deviceId;
        assert.notEqual(frameA, frameB);
      });

      await ctx.step("a session acting for A finds A's frame, reads its text and the timeline; the read is audited with the session id", async () => {
        sessions.a = await creds.mint({ human: a });
        const found = (await sessions.a.client.get(SEARCH, { params, query: { q: phraseA } })).status(200).json<any>();
        assert.equal(found.items.length, 1);
        assert.equal(found.items[0].frame_id, frameA);
        assert.ok(found.items[0].snippet.includes(phraseA));
        (await sessions.a.client.get(FRAME, { params: { ...params, frameId: frameA } }))
          .status(200)
          .body()
          .has("$.text", `${phraseA} release notes draft`)
          .has("$.user_id", a.userId);
        const timeline = (await sessions.a.client.get(TIMELINE, { params, query: { from: "2026-10-01T00:00:00Z", to: "2026-10-02T00:00:00Z" } })).status(200).json<any>();
        assert.equal(timeline.chunks.length, 1);
        const events = await audit("capture.agent_read");
        const mine = events.find((e: any) => e.session_id === sessions.a!.sessionId);
        assert.ok(mine, `an agent_read event names the session: ${JSON.stringify(events.map((e: any) => e.session_id))}`);
        assert.equal(mine.resource_id, a.userId);
      });

      await ctx.step("a session acting for B finds nothing of A's; A's frame is 404; B's own frame is found; a user_id parameter changes nothing", async () => {
        sessions.b = await creds.mint({ human: b });
        assert.equal((await sessions.b.client.get(SEARCH, { params, query: { q: phraseA } })).status(200).json<any>().items.length, 0);
        assert.equal((await sessions.b.client.get(SEARCH, { params, query: { q: phraseA, user_id: a.userId! } })).status(200).json<any>().items.length, 0);
        (await sessions.b.client.get(FRAME, { params: { ...params, frameId: frameA } })).status(404);
        const own = (await sessions.b.client.get(SEARCH, { params, query: { q: phraseB } })).status(200).json<any>();
        assert.equal(own.items.length, 1);
        assert.equal(own.items[0].frame_id, frameB);
      });

      await ctx.step("a trigger run (no human) and a shared session get 403 CAPTURE_NO_HUMAN; the account owner's admin rights add nothing", async () => {
        const trigger = await creds.mint({ human: null });
        (await trigger.client.get(SEARCH, { params, query: { q: phraseA } })).status(403).body().has("$.code", "CAPTURE_NO_HUMAN");
        (await trigger.client.get(FRAME, { params: { ...params, frameId: frameA } })).status(403).body().has("$.code", "CAPTURE_NO_HUMAN");
        const shared = await creds.mint({ human: a, visibility: "project" });
        (await shared.client.get(SEARCH, { params, query: { q: phraseA } })).status(403).body().has("$.code", "CAPTURE_NO_HUMAN");
        // A service-less machine token and an unauthenticated call are refused too.
        (await ctx.client.as(ctx.P.ANON).get(SEARCH, { params, query: { q: phraseA } })).status(401);
      });

      await ctx.step("users: A finds A's frame through the project route, B's frame is 404, a non-member of the project is refused", async () => {
        const ca = ctx.client.as(a);
        assert.equal((await ca.get(SEARCH, { params, query: { q: phraseA } })).status(200).json<any>().items.length, 1);
        assert.equal((await ca.get(SEARCH, { params, query: { q: phraseB, user_id: b.userId! } })).status(200).json<any>().items.length, 0);
        (await ca.get(FRAME, { params: { ...params, frameId: frameB } })).status(404);
        (await ctx.client.as(ctx.P.NONMEMBER).get(SEARCH, { params, query: { q: phraseA } })).status([403, 404]);
      });

      await ctx.step("capture turned off by the person: the session gets 403 CAPTURE_NOT_ENABLED; back on, it reads again", async () => {
        (await ctx.client.as(a).put("/v1/capture/devices/:deviceId", { enabled: false }, { params: { deviceId: deviceA } })).status(200);
        (await sessions.a!.client.get(SEARCH, { params, query: { q: phraseA } })).status(403).body().has("$.code", "CAPTURE_NOT_ENABLED");
        (await ctx.client.as(a).put("/v1/capture/devices/:deviceId", { enabled: true }, { params: { deviceId: deviceA } })).status(200);
        assert.equal((await sessions.a!.client.get(SEARCH, { params, query: { q: phraseA } })).status(200).json<any>().items.length, 1);
      });

      await ctx.step("the real CLI inside the sandbox: `kortix capture search|timeline|frame` read A's history; a trigger token exits non-zero", async () => {
        const env = cliEnv(sessions.a!.secret);
        const search = await sandbox.run(["capture", "search", phraseA, "--json"], { env });
        assert.equal(search.exitCode, 0, search.all);
        const page = JSON.parse(search.stdout);
        assert.equal(page.items.length, 1);
        assert.equal(page.items[0].frame_id, frameA);
        const text = await sandbox.run(["capture", "search", phraseA], { env });
        assert.equal(text.exitCode, 0, text.all);
        assert.ok(text.stdout.includes(`#${frameA}`) && text.stdout.includes("Notes"), text.stdout);
        const frame = await sandbox.run(["capture", "frame", String(frameA), "--json"], { env });
        assert.equal(frame.exitCode, 0, frame.all);
        assert.equal(JSON.parse(frame.stdout).text, `${phraseA} release notes draft`);
        const timeline = await sandbox.run(["capture", "timeline", "--from", "2026-10-01T00:00:00Z", "--to", "2026-10-02T00:00:00Z", "--json"], { env });
        assert.equal(timeline.exitCode, 0, timeline.all);
        assert.equal(JSON.parse(timeline.stdout).chunks.length, 1);
        const other = await sandbox.run(["capture", "frame", String(frameB), "--json"], { env });
        assert.notEqual(other.exitCode, 0, "another person's frame is not readable");
        const trigger = await creds.mint({ human: null });
        const denied = await sandbox.run(["capture", "search", phraseA, "--json"], { env: cliEnv(trigger.secret) });
        assert.notEqual(denied.exitCode, 0);
        assert.match(denied.all, /does not act for a person/);
        const bad = await sandbox.run(["capture", "search"], { env });
        assert.notEqual(bad.exitCode, 0);
      });

      await ctx.step("MCP: tools/list carries capture_search and capture_frame; tools/call returns A's frame to A's token", async () => {
        const created = await ctx.client.as(a).post("/v1/accounts/tokens", { name: "CAP-2 mcp" });
        created.status(201);
        const pat = created.json<{ secret_key: string }>().secret_key;
        const mcp = (body: unknown) => ctx.client.as(ctx.P.ANON).post("/v1/mcp", body, { headers: { Authorization: `Bearer ${pat}` } });
        const names = (await mcp(rpc(1, "tools/list"))).json<any>().result.tools.map((t: { name: string }) => t.name);
        assert.ok(names.includes("capture_search") && names.includes("capture_frame"), names.join());
        const call = async (id: number, name: string, args: Record<string, unknown>) =>
          (await mcp(rpc(id, "tools/call", { name, arguments: args }))).json<any>().result as { isError?: boolean; content: Array<{ text: string }> };
        const found = await call(2, "capture_search", { project_id: project.id, q: phraseA });
        assert.ok(!found.isError, found.content[0]!.text);
        assert.match(found.content[0]!.text, /HTTP 200/);
        assert.ok(found.content[0]!.text.includes(`"frame_id": ${frameA}`) || found.content[0]!.text.includes(`"frame_id":${frameA}`), found.content[0]!.text);
        const frame = await call(3, "capture_frame", { project_id: project.id, frame_id: frameA });
        assert.ok(!frame.isError && frame.content[0]!.text.includes(phraseA), frame.content[0]!.text);
        const foreign = await call(4, "capture_frame", { project_id: project.id, frame_id: frameB });
        assert.ok(foreign.isError, "another person's frame is an error");
        assert.match(foreign.content[0]!.text, /HTTP 404/);
        const bad = await call(5, "capture_frame", { project_id: project.id, frame_id: "x" });
        assert.ok(bad.isError);
      });
    } finally {
      sandbox.dispose();
      await creds.close();
    }
  },
);
