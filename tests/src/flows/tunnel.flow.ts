/**
 * Computers — paired machines reached over the Agent Computer Tunnel. Maps to
 * spec §tunnel (TUN-*).
 *
 * A paired machine is an ACCOUNT on the project's `computer` connector
 * (`connector_connections` row with `tunnel_id`), private to the member who
 * paired it unless shared with the project.
 *
 * Auth model (apps/api/src/index.ts):
 *   - POST /v1/tunnel/device-auth and GET /v1/tunnel/device-auth/:code/status
 *     are PUBLIC (CLI device-flow create + poll).
 *   - Everything else under /v1/tunnel/* requires combinedAuth (ANON → 401).
 *   - Mutations additionally require a user credential. No real agent runs
 *     here, so every machine stays offline.
 */
import { strict as assert } from "node:assert";
import { flow } from "../core/flow";
import type { Client } from "../core/client";
import type { FlowContext } from "../core/types";
import { offboardingEvent, pair, pairBothPlacements, projectComputerAccount, startPairing } from "../fixtures/tunnel";

// A uuid that will never match a real machine or request row.
const MISSING_UUID = "00000000-0000-4000-8000-000000000000";

flow(
  "TUN-1",
  {
    domain: "tunnel",
    timeoutMs: 180_000,
    tags: ["smoke"],
    routes: [
      "POST /v1/tunnel/device-auth",
      "GET /v1/tunnel/device-auth/:code/status",
      "POST /v1/tunnel/device-auth/:code/approve",
      "GET /v1/tunnel/connections",
      "GET /v1/tunnel/connections/:tunnelId",
      "PATCH /v1/tunnel/connections/:tunnelId",
      "DELETE /v1/tunnel/connections/:tunnelId",
      "POST /v1/tunnel/connections/:tunnelId/rotate-token",
      "POST /v1/tunnel/connections/:tunnelId/access",
      "GET /v1/projects/:projectId/connections",
    ],
    serial: true,
  },
  async (ctx) => {
    const owner = ctx.client.as(ctx.P.OWNER);
    const project = await ctx.fixtures.project();
    let machine = { tunnelId: "", connectionId: "", token: "" };

    await ctx.step("OWNER pairs a machine: private computer account on the project", async () => {
      machine = await pair(ctx.client.as(ctx.P.ANON), owner, {
        name: ctx.fixtures.name("machine"),
        projectId: project.id,
        capabilities: ["filesystem"],
      });
      ctx.track("tunnelConnection", machine.tunnelId);
      assert.match(machine.token, /^kortix_tnl_/);
      const r = await owner.get("/v1/projects/:projectId/connections", { params: { projectId: project.id } });
      r.status(200);
      const account = r.json<any>().connections.find((c: any) => c.connection_id === machine.connectionId);
      assert.ok(account, "the paired machine is listed as a computer account");
      assert.equal(account.connector_alias, "computer");
      assert.equal(account.owner_type, "member");
      assert.equal(account.tunnel_id, machine.tunnelId);
      assert.deepEqual(account.machine, { online: false, last_heartbeat_at: null, access: null });
    });

    await ctx.step("OWNER lists own machines; ANON → 401", async () => {
      const r = await owner.get("/v1/tunnel/connections");
      r.status(200);
      assert.ok(r.json<any[]>().some((m) => m.tunnelId === machine.tunnelId && m.isLive === false));
      (await ctx.client.as(ctx.P.ANON).get("/v1/tunnel/connections")).status(401);
    });

    await ctx.step("pairing is device auth only: POST /tunnel/connections → 404", async () => {
      (await owner.post("/v1/tunnel/connections", { name: "hand-made", capabilities: [] })).status(404);
    });

    await ctx.step("OWNER reads, renames (empty name → 400), and rotates the setup token", async () => {
      const params = { params: { tunnelId: machine.tunnelId } };
      (await owner.get("/v1/tunnel/connections/:tunnelId", params)).status(200).body().has("$.tunnelId", machine.tunnelId);
      (await owner.patch("/v1/tunnel/connections/:tunnelId", { name: ctx.fixtures.name("renamed") }, params)).status(200);
      (await owner.patch("/v1/tunnel/connections/:tunnelId", { name: "  " }, params)).status(400);
      (await owner.post("/v1/tunnel/connections/:tunnelId/rotate-token", {}, params)).status(200).body().exists("$.setupToken");
    });

    await ctx.step("OWNER changes access through Kortix: a bad change → 400; an offline machine → 409 computer_offline", async () => {
      const params = { params: { tunnelId: machine.tunnelId } };
      // No agent has reported yet: the machine shows no access state.
      (await owner.get("/v1/tunnel/connections/:tunnelId", params)).status(200).body().has("$.access", null);
      (await owner.post("/v1/tunnel/connections/:tunnelId/access", { mode: "sometimes" }, params)).status(400);
      const offline = await owner.post("/v1/tunnel/connections/:tunnelId/access", { mode: "off" }, params);
      offline.status(409).body().has("$.code", "computer_offline");
      assert.match(offline.json<any>().error, /npx @kortix\/agent-tunnel@latest access/);
      (await owner.post("/v1/tunnel/connections/:tunnelId/access", { mode: "off" }, { params: { tunnelId: MISSING_UUID } })).status(404);
    });

    await ctx.step("malformed machine IDs return 400 on every connection endpoint", async () => {
      const params = { params: { tunnelId: "nope" } };
      (await owner.get("/v1/tunnel/connections/:tunnelId", params)).status(400);
      (await owner.patch("/v1/tunnel/connections/:tunnelId", { name: "renamed" }, params)).status(400);
      (await owner.del("/v1/tunnel/connections/:tunnelId", params)).status(400);
      (await owner.post("/v1/tunnel/connections/:tunnelId/rotate-token", {}, params)).status(400);
      (await owner.post("/v1/tunnel/connections/:tunnelId/access", { mode: "off" }, params)).status(400);
    });

    await ctx.step("unknown machine → 404", async () => {
      const params = { params: { tunnelId: MISSING_UUID } };
      (await owner.get("/v1/tunnel/connections/:tunnelId", params)).status(404);
      (await owner.patch("/v1/tunnel/connections/:tunnelId", { name: "renamed" }, params)).status(404);
      (await owner.del("/v1/tunnel/connections/:tunnelId", params)).status(404);
      (await owner.post("/v1/tunnel/connections/:tunnelId/rotate-token", {}, params)).status(404);
    });

    await ctx.step("unpairing deletes the machine and revokes its computer account", async () => {
      (await owner.del("/v1/tunnel/connections/:tunnelId", { params: { tunnelId: machine.tunnelId } }))
        .status(200)
        .body()
        .has("$.success", true);
      const r = await owner.get("/v1/projects/:projectId/connections", { params: { projectId: project.id } });
      r.status(200);
      const account = r.json<any>().connections.find((c: any) => c.connection_id === machine.connectionId);
      assert.equal(account?.status, "revoked");
      assert.equal(account?.tunnel_id, null);
      assert.equal(account?.machine, null);
    });
  },
);

flow(
  "TUN-2",
  {
    domain: "tunnel",
    timeoutMs: 180_000,
    serial: true,
    routes: [
      "POST /v1/tunnel/device-auth",
      "GET /v1/tunnel/device-auth/:code/status",
      "POST /v1/tunnel/device-auth/:code/approve",
      "POST /v1/projects/:projectId/computers",
      "GET /v1/projects/:projectId/connections",
      "GET /v1/tunnel/connections",
      "DELETE /v1/tunnel/connections/:tunnelId",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const member = await team.addMember("member");
    const project = await team.project();
    await team.grantProjectRole(project.id, member.userId!, "member");
    const owner = ctx.client.as(ctx.P.OWNER);
    const asMember = ctx.client.as(member);
    const params = { params: { projectId: project.id } };
    let machine = { tunnelId: "", connectionId: "", token: "" };
    const connectionIds = async (client: Client) => {
      const r = await client.get("/v1/projects/:projectId/connections", params);
      r.status(200);
      return r.json<any>().connections.map((c: any) => c.connection_id) as string[];
    };

    await ctx.step("OWNER pairs a private machine; the member neither lists it nor sees it in the project", async () => {
      machine = await pair(ctx.client.as(ctx.P.ANON), owner, {
        name: ctx.fixtures.name("owner-mac"),
        projectId: project.id,
        capabilities: ["filesystem"],
      });
      ctx.track("tunnelConnection", machine.tunnelId);
      assert.ok((await connectionIds(owner)).includes(machine.connectionId));
      assert.ok(!(await connectionIds(asMember)).includes(machine.connectionId));
      const mine = await asMember.get("/v1/tunnel/connections");
      mine.status(200);
      assert.ok(!mine.json<any[]>().some((m) => m.tunnelId === machine.tunnelId));
    });

    await ctx.step("POST /computers is idempotent for the owner", async () => {
      const r = await owner.post("/v1/projects/:projectId/computers", { tunnel_id: machine.tunnelId }, params);
      r.status(200).body().has("$.connection_id", machine.connectionId).has("$.tunnel_id", machine.tunnelId);
    });

    await ctx.step("the member cannot add the owner's machine (404) or a malformed id (400)", async () => {
      (await asMember.post("/v1/projects/:projectId/computers", { tunnel_id: machine.tunnelId }, params)).status(404);
      (await asMember.post("/v1/projects/:projectId/computers", { tunnel_id: "not-a-uuid" }, params)).status(400);
    });

    await ctx.step("the member cannot share a pairing with the project (403)", async () => {
      const created = await startPairing(ctx.client.as(ctx.P.ANON), {
        machineHostname: "member.local",
        project_id: project.id,
      });
      created.status(201);
      const r = await asMember.post(
        "/v1/tunnel/device-auth/:code/approve",
        { capabilities: [], share: "project" },
        { params: { code: created.json<any>().deviceCode } },
      );
      r.status(403);
    });

    await ctx.step("OWNER shares the machine with the project; the member now sees that account", async () => {
      const r = await owner.post(
        "/v1/projects/:projectId/computers",
        { tunnel_id: machine.tunnelId, share: "project" },
        params,
      );
      r.status(201).body().has("$.owner_type", "project").has("$.tunnel_id", machine.tunnelId);
      assert.ok((await connectionIds(asMember)).includes(r.json<any>().connection_id));
    });

    await ctx.step("cleanup: unpair the machine", async () => {
      (await owner.del("/v1/tunnel/connections/:tunnelId", { params: { tunnelId: machine.tunnelId } })).status(200);
    });
  },
);

flow(
  "TUN-3",
  {
    domain: "tunnel",
    routes: ["GET /v1/tunnel/connections"],
  },
  async (ctx) => {
    await ctx.step("per-machine permission, permission-request, and audit routes are gone (404)", async () => {
      const owner = ctx.client.as(ctx.P.OWNER);
      for (const path of [
        "/v1/tunnel/permission-requests",
        `/v1/tunnel/permissions/${MISSING_UUID}`,
        `/v1/tunnel/audit/${MISSING_UUID}`,
      ]) {
        (await owner.get(path)).status(404);
      }
      (await owner.get("/v1/tunnel/connections")).status(200);
    });
  },
);

flow(
  "TUN-4",
  {
    domain: "tunnel",
    timeoutMs: 180_000,
    serial: true,
    routes: [
      "POST /v1/tunnel/device-auth",
      "GET /v1/tunnel/device-auth/:code/status",
      "POST /v1/tunnel/device-auth/:code/approve",
      "POST /v1/tunnel/rpc/:tunnelId",
      "DELETE /v1/tunnel/connections/:tunnelId",
    ],
  },
  async (ctx) => {
    const owner = ctx.client.as(ctx.P.OWNER);
    const project = await ctx.fixtures.project();
    let tunnelId = "";

    await ctx.step("pair a filesystem-only machine", async () => {
      tunnelId = (
        await pair(ctx.client.as(ctx.P.ANON), owner, {
          name: ctx.fixtures.name("rpc-machine"),
          projectId: project.id,
          capabilities: ["filesystem"],
        })
      ).tunnelId;
      ctx.track("tunnelConnection", tunnelId);
    });

    await ctx.step("rpc missing method → 400", async () => {
      (await owner.post("/v1/tunnel/rpc/:tunnelId", {}, { params: { tunnelId } })).status(400);
    });

    await ctx.step("a capability not approved at pairing → 403 computer_capability_not_approved", async () => {
      const r = await owner.post(
        "/v1/tunnel/rpc/:tunnelId",
        { method: "shell.exec", params: { command: "true" } },
        { params: { tunnelId } },
      );
      r.status(403).body().has("$.error", "computer_capability_not_approved").has("$.capability", "shell");
    });

    await ctx.step("an approved capability with no live agent → 503 carrying upstream 502 and the not-connected code", async () => {
      const r = await owner.post(
        "/v1/tunnel/rpc/:tunnelId",
        { method: "fs.list", params: { path: "/tmp" } },
        { params: { tunnelId } },
      );
      // The API rewrites every 502 to 503 on the wire (apps/api/src/index.ts).
      r.status(503).headerEquals("x-kortix-upstream-status", "502").body().has("$.code", -32004);
    });

    await ctx.step("rpc on unknown machine → 404", async () => {
      (await owner.post("/v1/tunnel/rpc/:tunnelId", { method: "fs.list" }, { params: { tunnelId: MISSING_UUID } })).status(404);
    });

    await ctx.step("cleanup: unpair the machine", async () => {
      (await owner.del("/v1/tunnel/connections/:tunnelId", { params: { tunnelId } })).status(200);
    });
  },
);

flow(
  "TUN-5",
  {
    domain: "tunnel",
    timeoutMs: 180_000,
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
    const project = await ctx.fixtures.project();
    let deviceCode = "";
    let deviceSecret = "";

    await ctx.step("PUBLIC: begin device-auth flow with a project → code + secret", async () => {
      const r = await startPairing(ctx.client.as(ctx.P.ANON), {
        machineHostname: "ke2e-host",
        project_id: project.id,
      });
      r.status(201);
      deviceCode = r.json<any>().deviceCode;
      deviceSecret = r.json<any>().deviceSecret;
    });

    await ctx.step("PUBLIC: a non-UUID project_id → 400", async () => {
      (await startPairing(ctx.client.as(ctx.P.ANON), { project_id: "nope" })).status(400);
    });

    await ctx.step("PUBLIC: poll status with secret → pending", async () => {
      const r = await ctx.client
        .withBearer(deviceSecret)
        .get("/v1/tunnel/device-auth/:code/status", { params: { code: deviceCode } });
      r.status(200).body().has("$.status", "pending");
    });

    await ctx.step("PUBLIC: unknown code and wrong secret return identical denials", async () => {
      const caller = ctx.client.withBearer("synthetic-invalid-device-secret");
      const existing = await caller.get("/v1/tunnel/device-auth/:code/status", {
        params: { code: deviceCode },
      });
      const missing = await caller.get("/v1/tunnel/device-auth/:code/status", {
        params: { code: "NONE-0000" },
      });
      existing.status(403);
      missing.status(existing.statusCode);
      assert.deepEqual(existing.json<unknown>(), { error: "Invalid secret" });
      assert.equal(missing.text(), existing.text());
    });

    await ctx.step("PUBLIC: poll status without secret → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/tunnel/device-auth/:code/status", { params: { code: deviceCode } });
      r.status(400);
    });

    await ctx.step("AUTH: OWNER reads device-auth info, including the requested project", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/tunnel/device-auth/:code/info", { params: { code: deviceCode } });
      r.status(200).body().has("$.deviceCode", deviceCode).has("$.projectId", project.id);
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

    await ctx.step("AUTH: OWNER approves the device → machine + computer account", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/tunnel/device-auth/:code/approve",
          { name: ctx.fixtures.name("device") },
          { params: { code: deviceCode } },
        );
      r.status(200).body().exists("$.tunnelId").exists("$.connectionId");
      ctx.track("tunnelConnection", r.json<any>().tunnelId);
    });

    await ctx.step("PUBLIC: poll after approval → token", async () => {
      const r = await ctx.client
        .withBearer(deviceSecret)
        .get("/v1/tunnel/device-auth/:code/status", { params: { code: deviceCode } });
      r.status(200).body().has("$.status", "approved").exists("$.token");
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

flow(
  "TUN-7",
  {
    domain: "tunnel",
    timeoutMs: 180_000,
    serial: true,
    routes: [
      "POST /v1/tunnel/device-auth",
      "GET /v1/tunnel/device-auth/:code/status",
      "POST /v1/tunnel/device-auth/:code/approve",
      "GET /v1/projects/:projectId/connections",
      "DELETE /v1/tunnel/self",
    ],
  },
  async (ctx) => {
    const anon = ctx.client.as(ctx.P.ANON);
    const owner = ctx.client.as(ctx.P.OWNER);
    const project = await ctx.fixtures.project();
    const name = ctx.fixtures.name("follows");
    let tunnelId = "";
    let token = "";

    await ctx.step("OWNER approves a pairing with no project: the machine is paired, no account yet", async () => {
      const created = await startPairing(anon, { machineHostname: `${name}.local` });
      created.status(201);
      const { deviceCode, deviceSecret } = created.json<any>();
      const approved = await owner.post(
        "/v1/tunnel/device-auth/:code/approve",
        { name, capabilities: [] },
        { params: { code: deviceCode } },
      );
      approved.status(200).body().has("$.connectionId", null);
      tunnelId = approved.json<any>().tunnelId;
      ctx.track("tunnelConnection", tunnelId);
      const poll = await anon
        .withBearer(deviceSecret)
        .get("/v1/tunnel/device-auth/:code/status", { params: { code: deviceCode } });
      poll.status(200).body().has("$.status", "approved");
      token = poll.json<any>().token;
      assert.match(token, /^kortix_tnl_/);
    });

    await ctx.step("listing any project's connections gives OWNER the machine as a private account", async () => {
      const r = await owner.get("/v1/projects/:projectId/connections", { params: { projectId: project.id } });
      r.status(200);
      const account = r.json<any>().connections.find((c: any) => c.tunnel_id === tunnelId);
      assert.ok(account, "the owner's machine is an account in the project without any setup");
      assert.equal(account.owner_type, "member");
      assert.equal(account.label, name);
      assert.equal(account.machine.access, null);
    });

    await ctx.step("the machine unpairs itself with its own token; a wrong token → 401", async () => {
      (await anon.withBearer(`kortix_tnl_${"x".repeat(40)}`).del("/v1/tunnel/self", { headers: { "x-tunnel-id": tunnelId } }))
        .status(401);
      (await anon.withBearer(token).del("/v1/tunnel/self", { headers: { "x-tunnel-id": tunnelId } }))
        .status(200)
        .body()
        .has("$.success", true);
      const r = await owner.get("/v1/projects/:projectId/connections", { params: { projectId: project.id } });
      r.status(200);
      const account = r.json<any>().connections.find((c: any) => c.label === name);
      assert.equal(account?.status, "revoked");
      assert.equal(account?.tunnel_id, null);
    });
  },
);

const DEPARTED_OWNER_ROUTES = [
  "POST /v1/tunnel/device-auth",
  "GET /v1/tunnel/device-auth/:code/status",
  "POST /v1/tunnel/device-auth/:code/approve",
  "GET /v1/projects/:projectId/connections",
  "GET /v1/accounts/:accountId/audit",
  "GET /v1/tunnel/connections",
  "DELETE /v1/tunnel/connections/:tunnelId",
];

/**
 * KRTX-1722: a member's computer accounts end with their membership. The
 * member pairs a machine in each placement, then leaves the account or is
 * removed. Both computer accounts in the team project are revoked, an OWNER's
 * computer account stays active, one audit event counts them, and the
 * machines stay the member's own.
 */
async function departedOwnerComputers(ctx: FlowContext, exit: "removed" | "left") {
  const team = await ctx.fixtures.team({ enterprise: true });
  const member = await team.addMember("member");
  const project = await team.project();
  await team.grantProjectRole(project.id, member.userId!, "manager");
  const anon = ctx.client.as(ctx.P.ANON);
  const owner = ctx.client.as(ctx.P.OWNER);
  const asMember = ctx.client.as(member);
  let machines!: Awaited<ReturnType<typeof pairBothPlacements>>;
  let ownerMachine = { tunnelId: "", connectionId: "", token: "" };

  await ctx.step("the member pairs a private machine and one shared with the project; OWNER shares one too", async () => {
    machines = await pairBothPlacements(anon, asMember, { projectId: project.id, name: ctx.fixtures.name });
    ownerMachine = await pair(anon, owner, {
      name: ctx.fixtures.name("owner-studio"),
      projectId: project.id,
      capabilities: ["filesystem"],
      share: "project",
    });
    ctx.track("tunnelConnection", ownerMachine.tunnelId);
    const shared = await projectComputerAccount(owner, project.id, machines.shared.connectionId);
    assert.equal(shared?.owner_type, "project");
    assert.equal(shared?.status, "active");
  });

  await ctx.step(exit === "removed" ? "OWNER removes the member → 200" : "the member leaves → 200", async () => {
    const r =
      exit === "removed"
        ? await owner.del("/v1/accounts/:accountId/members/:userId", {
            params: { accountId: team.id, userId: member.userId! },
          })
        : await asMember.post("/v1/accounts/:accountId/leave", {}, { params: { accountId: team.id } });
    r.status(200);
  });

  await ctx.step("the shared machine's account is revoked (owner_left, no default pin); OWNER's stays active", async () => {
    const shared = await projectComputerAccount(owner, project.id, machines.shared.connectionId);
    assert.equal(shared?.status, "revoked");
    assert.equal(shared?.is_default, false);
    assert.equal(shared?.metadata?.revokedReason, "owner_left");
    assert.equal((await projectComputerAccount(owner, project.id, ownerMachine.connectionId))?.status, "active");
  });

  await ctx.step("one member.offboarded audit event counts the accounts of both placements", async () => {
    const event = await offboardingEvent(owner, team.id, member.userId!);
    assert.equal(event.actor_user_id, exit === "removed" ? ctx.P.OWNER.userId : member.userId);
    assert.equal(event.metadata?.reason, exit);
    assert.equal(event.metadata?.computers_revoked, 2);
    assert.equal(event.metadata?.reminders_disabled, 0);
  });

  await ctx.step("the machines stay the member's: they still list and unpair both", async () => {
    const r = await asMember.get("/v1/tunnel/connections");
    r.status(200);
    const listed = r.json<any[]>().map((m) => m.tunnelId);
    for (const machine of [machines.personal, machines.shared]) {
      assert.ok(listed.includes(machine.tunnelId), `the member lists ${machine.tunnelId}`);
      (await asMember.del("/v1/tunnel/connections/:tunnelId", { params: { tunnelId: machine.tunnelId } })).status(200);
    }
  });
}

flow(
  "TUN-8",
  {
    domain: "tunnel",
    timeoutMs: 180_000,
    serial: true,
    routes: [...DEPARTED_OWNER_ROUTES, "DELETE /v1/accounts/:accountId/members/:userId"],
  },
  (ctx) => departedOwnerComputers(ctx, "removed"),
);

flow(
  "TUN-9",
  {
    domain: "tunnel",
    timeoutMs: 180_000,
    serial: true,
    routes: [...DEPARTED_OWNER_ROUTES, "POST /v1/accounts/:accountId/leave"],
  },
  (ctx) => departedOwnerComputers(ctx, "left"),
);
