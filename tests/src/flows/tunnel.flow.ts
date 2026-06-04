/**
 * Tunnel sub-service — reverse-tunnel infra connecting cloud sandboxes to local
 * machine resources. Maps to spec §tunnel (TUN-*).
 *
 * Auth model (apps/api/src/index.ts ~L431):
 *   - POST /v1/tunnel/device-auth and GET /v1/tunnel/device-auth/:code/status
 *     are PUBLIC (CLI device-flow create + poll).
 *   - Everything else under /v1/tunnel/* requires combinedAuth (ANON → 401).
 *   - Tunnel management additionally requires a *user* credential
 *     (requireUserCredential rejects apiKey auth with 403); OWNER is a JWT so it
 *     passes. We don't spin up a real tunnel agent, so :tunnelId-scoped routes
 *     resolve to 404 for a random uuid.
 */
import { flow } from "../core/flow";

// A uuid that will never match a real tunnel/permission/request row.
const MISSING_UUID = "00000000-0000-4000-8000-000000000000";

flow(
  "TUN-1",
  {
    domain: "tunnel",
    tags: ["smoke"],
    routes: [
      "GET /v1/tunnel/connections",
      "POST /v1/tunnel/connections",
      "GET /v1/tunnel/connections/:tunnelId",
      "PATCH /v1/tunnel/connections/:tunnelId",
      "DELETE /v1/tunnel/connections/:tunnelId",
      "POST /v1/tunnel/connections/:tunnelId/rotate-token",
    ],
    serial: true,
  },
  async (ctx) => {
    let tunnelId = "";

    await ctx.step("OWNER lists connections", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/tunnel/connections");
      r.status(200);
    });

    await ctx.step("ANON list → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/tunnel/connections");
      r.status(401);
    });

    await ctx.step("OWNER registers a connection → setupToken returned once", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/tunnel/connections", { name: ctx.fixtures.name("tunnel"), capabilities: [] });
      r.status(201).body().exists("$.tunnelId").exists("$.setupToken");
      tunnelId = r.json<any>().tunnelId;
    });

    await ctx.step("OWNER reads it back", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/tunnel/connections/:tunnelId", { params: { tunnelId } });
      r.status(200).body().has("$.tunnelId", tunnelId);
    });

    await ctx.step("missing name → 400", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post("/v1/tunnel/connections", {});
      r.status(400);
    });

    await ctx.step("OWNER renames the connection", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .patch("/v1/tunnel/connections/:tunnelId", { name: ctx.fixtures.name("renamed") }, { params: { tunnelId } });
      r.status(200);
    });

    await ctx.step("rotate-token issues a fresh setupToken", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/tunnel/connections/:tunnelId/rotate-token", {}, { params: { tunnelId } });
      r.status(200).body().exists("$.setupToken");
    });

    await ctx.step("unknown tunnelId → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/tunnel/connections/:tunnelId", { params: { tunnelId: MISSING_UUID } });
      r.status(404);
    });

    await ctx.step("OWNER deletes the connection", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/tunnel/connections/:tunnelId", { params: { tunnelId } });
      r.status(200).body().has("$.success", true);
    });
  },
);

flow(
  "TUN-2",
  {
    domain: "tunnel",
    routes: [
      "GET /v1/tunnel/permissions/:tunnelId",
      "POST /v1/tunnel/permissions/:tunnelId",
      "DELETE /v1/tunnel/permissions/:tunnelId/:permissionId",
    ],
    serial: true,
  },
  async (ctx) => {
    let tunnelId = "";

    await ctx.step("create a tunnel to attach permissions to", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/tunnel/connections", { name: ctx.fixtures.name("perm-tunnel"), capabilities: [] });
      r.status(201);
      tunnelId = r.json<any>().tunnelId;
    });

    await ctx.step("list permissions (empty)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/tunnel/permissions/:tunnelId", { params: { tunnelId } });
      r.status(200);
    });

    await ctx.step("grant a permission → 201", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/tunnel/permissions/:tunnelId", { capability: "shell" }, { params: { tunnelId } });
      r.status(201).body().exists("$.permissionId");
      ctx.track("tunnelPermission", r.json<any>().permissionId, { tunnelId });
    });

    await ctx.step("missing capability → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/tunnel/permissions/:tunnelId", {}, { params: { tunnelId } });
      r.status(400);
    });

    await ctx.step("invalid capability → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/tunnel/permissions/:tunnelId", { capability: "not-a-real-cap" }, { params: { tunnelId } });
      r.status(400);
    });

    await ctx.step("revoke a non-existent permission → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/tunnel/permissions/:tunnelId/:permissionId", { params: { tunnelId, permissionId: MISSING_UUID } });
      r.status(404);
    });

    await ctx.step("permissions on unknown tunnel → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/tunnel/permissions/:tunnelId", { params: { tunnelId: MISSING_UUID } });
      r.status(404);
    });

    await ctx.step("ANON grant → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/tunnel/permissions/:tunnelId", { capability: "shell" }, { params: { tunnelId } });
      r.status(401);
    });
  },
);

flow(
  "TUN-3",
  {
    domain: "tunnel",
    routes: [
      "GET /v1/tunnel/permission-requests",
      "POST /v1/tunnel/permission-requests/:requestId/approve",
      "POST /v1/tunnel/permission-requests/:requestId/deny",
      "GET /v1/tunnel/permission-requests/stream",
    ],
  },
  async (ctx) => {
    await ctx.step("OWNER lists pending permission requests", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/tunnel/permission-requests");
      r.status(200);
    });

    await ctx.step("ANON list → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/tunnel/permission-requests");
      r.status(401);
    });

    await ctx.step("approve unknown request → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/tunnel/permission-requests/:requestId/approve", {}, { params: { requestId: MISSING_UUID } });
      r.status(404);
    });

    await ctx.step("deny unknown request → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/tunnel/permission-requests/:requestId/deny", {}, { params: { requestId: MISSING_UUID } });
      r.status(404);
    });

    await ctx.step("ANON stream → 401 (auth runs before the stream opens)", async () => {
      // The SSE stream (text/event-stream) is long-lived and never closes
      // server-side, so the OWNER 200 path would hang the HTTP client until the
      // request timeout — we don't read it. The meaningful black-box assertion
      // is the auth boundary: combinedAuth rejects ANON with a normal 401 JSON
      // response *before* the stream handler runs, so this never hangs.
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/tunnel/permission-requests/stream");
      r.status(401);
    });
  },
);

flow(
  "TUN-4",
  {
    domain: "tunnel",
    routes: [
      "POST /v1/tunnel/rpc/:tunnelId",
      "GET /v1/tunnel/audit/:tunnelId",
    ],
    serial: true,
  },
  async (ctx) => {
    let tunnelId = "";

    await ctx.step("create a tunnel for rpc/audit", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/tunnel/connections", { name: ctx.fixtures.name("rpc-tunnel"), capabilities: [] });
      r.status(201);
      tunnelId = r.json<any>().tunnelId;
    });

    await ctx.step("rpc missing method → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/tunnel/rpc/:tunnelId", {}, { params: { tunnelId } });
      r.status(400);
    });

    await ctx.step("rpc on a tunnel with no live agent → not connected", async () => {
      // No permission granted + no agent connected: handler may answer 403
      // (permission required, opens a request) or 5xx (not connected) once a
      // permission exists. For a bare tunnel the capability is ungranted →
      // 403 with a requestId. Accept the not-connected family too.
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/tunnel/rpc/:tunnelId", { method: "shell.exec", params: {} }, { params: { tunnelId } });
      r.status([403, 502, 504, 500]);
    });

    await ctx.step("rpc on unknown tunnel → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/tunnel/rpc/:tunnelId", { method: "shell.exec" }, { params: { tunnelId: MISSING_UUID } });
      r.status(404);
    });

    await ctx.step("audit log for the tunnel → 200 paginated", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/tunnel/audit/:tunnelId", { params: { tunnelId } });
      r.status(200).body().exists("$.data").exists("$.pagination");
    });

    await ctx.step("audit for unknown tunnel → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/tunnel/audit/:tunnelId", { params: { tunnelId: MISSING_UUID } });
      r.status(404);
    });

    await ctx.step("ANON audit → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/tunnel/audit/:tunnelId", { params: { tunnelId } });
      r.status(401);
    });
  },
);

flow(
  "TUN-5",
  {
    domain: "tunnel",
    routes: [
      "POST /v1/tunnel/device-auth",
      "GET /v1/tunnel/device-auth/:code/status",
      "GET /v1/tunnel/device-auth/:code/info",
      "POST /v1/tunnel/device-auth/:code/approve",
      "POST /v1/tunnel/device-auth/:code/deny",
    ],
    serial: true,
  },
  async (ctx) => {
    let deviceCode = "";
    let deviceSecret = "";

    await ctx.step("PUBLIC: begin device-auth flow → code + secret", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/tunnel/device-auth", { machineHostname: "ke2e-host" });
      // 201 normally; 429 if a prior run hammered the global rate limiter.
      r.status([201, 429]);
      if (r.json<any>()?.deviceCode) {
        deviceCode = r.json<any>().deviceCode;
        deviceSecret = r.json<any>().deviceSecret;
      }
    });

    await ctx.step("PUBLIC: poll status with secret → pending", async () => {
      if (!deviceCode) return ctx.skip("device-auth create was rate-limited");
      const r = await ctx.client
        .withBearer(deviceSecret)
        .get("/v1/tunnel/device-auth/:code/status", { params: { code: deviceCode } });
      r.status([200, 429]);
    });

    await ctx.step("PUBLIC: poll status without secret → 400", async () => {
      if (!deviceCode) return ctx.skip("device-auth create was rate-limited");
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/tunnel/device-auth/:code/status", { params: { code: deviceCode } });
      r.status([400, 429]);
    });

    await ctx.step("AUTH: OWNER reads device-auth info", async () => {
      if (!deviceCode) return ctx.skip("device-auth create was rate-limited");
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/tunnel/device-auth/:code/info", { params: { code: deviceCode } });
      r.status(200).body().has("$.deviceCode", deviceCode);
    });

    await ctx.step("AUTH: info for unknown code → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/tunnel/device-auth/:code/info", { params: { code: "NOPECODE" } });
      r.status(404);
    });

    await ctx.step("AUTH: approve unknown code → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/tunnel/device-auth/:code/approve", {}, { params: { code: "NOPECODE" } });
      r.status(404);
    });

    await ctx.step("AUTH: OWNER approves the device → creates a tunnel", async () => {
      if (!deviceCode) return ctx.skip("device-auth create was rate-limited");
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/tunnel/device-auth/:code/approve", { name: ctx.fixtures.name("device") }, { params: { code: deviceCode } });
      r.status(200).body().exists("$.tunnelId");
      const tid = r.json<any>()?.tunnelId;
      if (tid) ctx.track("tunnelConnection", tid);
    });

    await ctx.step("AUTH: deny unknown code → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/tunnel/device-auth/:code/deny", {}, { params: { code: "NOPECODE" } });
      r.status(404);
    });

    await ctx.step("AUTH: info requires user credential → ANON 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/tunnel/device-auth/:code/info", { params: { code: "NOPECODE" } });
      r.status(401);
    });
  },
);
