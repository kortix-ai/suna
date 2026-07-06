/**
 * IAM approval control-plane: project access-requests, the executor
 * approval inbox/resolve routes, per-agent secret/connector scoping, the
 * enterprise-demo preview toggle, and self-serve SSO metadata import. Maps
 * to spec §5 (IAM-27..IAM-33).
 *
 * These live under /v1/projects/:id/* and /v1/accounts/:id/iam/* but are
 * grouped here as the "approval control plane" — the human-in-the-loop
 * surface an agent's write/destructive tool calls gate on, plus its adjacent
 * per-agent scoping and enterprise-preview toggle. Per PR #4117 (a prior 402
 * regression on the per-session audit poll): the project-level approval
 * reads below (GET /approvals, /approvals/needs-input, POST /approvals/:id)
 * gate on plain IAM capability (project.members.manage / project.read),
 * NEVER a billing tier — they must not start 402ing.
 */
import { flow } from "../core/flow";

const UNKNOWN_UUID = "00000000-0000-4000-a000-000000000000";

// ─── Access requests: request → review → approve/reject ────────────────────

flow(
  "IAM-27",
  {
    domain: "iam",
    routes: [
      "POST /v1/projects/:projectId/access-requests",
      "GET /v1/projects/:projectId/access-requests",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project();

    await ctx.step("an outsider (no account membership) requests access → 201 created", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post(
          "/v1/projects/:projectId/access-requests",
          { message: "please add me" },
          { params: { projectId: project.id } },
        );
      r.status(201).body().has("$.status", "created").exists("$.request.request_id");
    });

    await ctx.step("re-requesting while pending is idempotent → 200 pending", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post("/v1/projects/:projectId/access-requests", {}, { params: { projectId: project.id } });
      r.status(200).body().has("$.status", "pending");
    });

    await ctx.step("a project manager lists pending access requests → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/access-requests", { params: { projectId: project.id } });
      r.status(200).body().exists("$.requests").exists("$.requests[0].request_id");
    });

    await ctx.step("a plain member with no project grant cannot review requests → 404", async () => {
      const bare = await team.addMember("member");
      const r = await ctx.client
        .as(bare)
        .get("/v1/projects/:projectId/access-requests", { params: { projectId: project.id } });
      // loadProjectForUser('manage') hides the project entirely from a
      // non-grantee — 404, not 403 (never confirms the project's existence).
      r.status(404);
    });

    await ctx.step("POST to an unknown project → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/access-requests", {}, { params: { projectId: UNKNOWN_UUID } });
      r.status(404);
    });
  },
);

flow(
  "IAM-28",
  {
    domain: "iam",
    routes: [
      "POST /v1/projects/:projectId/access-requests/:requestId/approve",
      "POST /v1/projects/:projectId/access-requests/:requestId/reject",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project();
    const requesterA = await team.addMember("member");
    const requesterB = await team.addMember("member");
    let approveRequestId = "";
    let rejectRequestId = "";

    await ctx.step("seed two pending access requests", async () => {
      const a = await ctx.client
        .as(requesterA)
        .post("/v1/projects/:projectId/access-requests", {}, { params: { projectId: project.id } });
      a.status(201);
      approveRequestId = a.json<any>().request.request_id;

      const b = await ctx.client
        .as(requesterB)
        .post("/v1/projects/:projectId/access-requests", {}, { params: { projectId: project.id } });
      b.status(201);
      rejectRequestId = b.json<any>().request.request_id;
    });

    await ctx.step("OWNER approves with an explicit role → 200, grants the project role", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/access-requests/:requestId/approve",
          { role: "editor" },
          { params: { projectId: project.id, requestId: approveRequestId } },
        );
      r.status(200).body().has("$.request.status", "approved").has("$.member.project_role", "editor");
    });

    await ctx.step("approving the same request again → 409 already reviewed", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/access-requests/:requestId/approve",
          {},
          { params: { projectId: project.id, requestId: approveRequestId } },
        );
      r.status(409);
    });

    await ctx.step("invalid role → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/access-requests/:requestId/approve",
          { role: "wizard" },
          { params: { projectId: project.id, requestId: rejectRequestId } },
        );
      r.status(400);
    });

    await ctx.step("OWNER rejects the second request → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/access-requests/:requestId/reject",
          {},
          { params: { projectId: project.id, requestId: rejectRequestId } },
        );
      r.status(200).body().has("$.request.status", "rejected");
    });

    await ctx.step("rejecting an already-resolved request → 409", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/access-requests/:requestId/reject",
          {},
          { params: { projectId: project.id, requestId: rejectRequestId } },
        );
      r.status(409);
    });

    await ctx.step("unknown request id → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/access-requests/:requestId/approve",
          {},
          { params: { projectId: project.id, requestId: UNKNOWN_UUID } },
        );
      r.status(404);
    });

    await ctx.step("an editor (project.write but not members.manage) cannot approve → 403", async () => {
      const editorOnly = await team.addMember("member");
      await team.grantProjectRole(project.id, editorOnly.userId!, "editor");
      const requesterC = await team.addMember("member");
      const seeded = await ctx.client
        .as(requesterC)
        .post("/v1/projects/:projectId/access-requests", {}, { params: { projectId: project.id } });
      seeded.status(201);

      const r = await ctx.client
        .as(editorOnly)
        .post(
          "/v1/projects/:projectId/access-requests/:requestId/approve",
          {},
          { params: { projectId: project.id, requestId: seeded.json<any>().request.request_id } },
        );
      r.status(403);
    });
  },
);

// ─── Approval inbox (project-manager oversight) + per-session indicator ────

flow(
  "IAM-29",
  {
    domain: "iam",
    routes: [
      "GET /v1/projects/:projectId/approvals",
      "GET /v1/projects/:projectId/approvals/needs-input",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project();
    const viewer = await team.addMember("member");
    await team.grantProjectRole(project.id, viewer.userId!, "user");

    await ctx.step("a project manager reads the (empty) approval inbox → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/approvals", { params: { projectId: project.id } });
      r.status(200).body().has("$.count", 0).exists("$.approvals");
    });

    await ctx.step("out-of-range limit → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/approvals?limit=0", { params: { projectId: project.id } });
      r.status(400);
    });

    await ctx.step("a plain member with no project grant cannot read the manager-only inbox → 404", async () => {
      const bare = await team.addMember("member");
      const r = await ctx.client
        .as(bare)
        .get("/v1/projects/:projectId/approvals", { params: { projectId: project.id } });
      r.status(404);
    });

    await ctx.step("a granted (non-manager) project member sees their own needs-input → 200", async () => {
      const r = await ctx.client
        .as(viewer)
        .get("/v1/projects/:projectId/approvals/needs-input", { params: { projectId: project.id } });
      r.status(200).body().has("$.total", 0).exists("$.sessions");
    });

    await ctx.step("a project manager sees needs-input project-wide → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/approvals/needs-input", { params: { projectId: project.id } });
      r.status(200).body().has("$.total", 0);
    });

    await ctx.step("a non-project-member has no visibility into needs-input → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/projects/:projectId/approvals/needs-input", { params: { projectId: project.id } });
      r.status(404);
    });
  },
);

flow(
  "IAM-30",
  {
    domain: "iam",
    routes: ["POST /v1/projects/:projectId/approvals/:executionId"],
  },
  async (ctx) => {
    // The happy-path resolve (approve/deny a REAL pending_approval execution)
    // needs a live governed connector call from an agent session — not
    // reproducible black-box here (same constraint as SESS-11's session
    // sub-routes). This flow pins the validation + authz boundary, which is
    // exactly what a policy or gate regression breaks first.
    const team = await ctx.fixtures.team();
    const project = await team.project();

    await ctx.step("malformed execution id → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/approvals/:executionId",
          { decision: "approve" },
          { params: { projectId: project.id, executionId: "not-a-uuid" } },
        );
      r.status(400);
    });

    await ctx.step("invalid decision → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/approvals/:executionId",
          { decision: "maybe" },
          { params: { projectId: project.id, executionId: UNKNOWN_UUID } },
        );
      r.status(400);
    });

    await ctx.step("unknown (well-formed) execution id → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/approvals/:executionId",
          { decision: "approve" },
          { params: { projectId: project.id, executionId: UNKNOWN_UUID } },
        );
      r.status(404);
    });

    await ctx.step("a non-project-member cannot resolve anything on this project → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post(
          "/v1/projects/:projectId/approvals/:executionId",
          { decision: "approve" },
          { params: { projectId: project.id, executionId: UNKNOWN_UUID } },
        );
      r.status(404);
    });
  },
);

// ─── Per-agent secret/connector scope (inheritance-pyramid first step) ─────

flow(
  "IAM-31",
  {
    domain: "iam",
    routes: ["PUT /v1/projects/:projectId/agents/:agentName/scope"],
  },
  async (ctx) => {
    // The happy path (scoping a REAL declared [[agents]] entry) needs a
    // project whose kortix.toml already declares an agent — out of reach for
    // a bare provisioned repo here. This flow pins the manifest-edit
    // validation + manager-only gate, which is what regresses first.
    const team = await ctx.fixtures.team();
    const project = await team.project();

    await ctx.step("empty body (neither env nor connectors) → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/projects/:projectId/agents/:agentName/scope",
          {},
          { params: { projectId: project.id, agentName: "nope" } },
        );
      r.status(400);
    });

    await ctx.step("malformed grant set → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/projects/:projectId/agents/:agentName/scope",
          { env: 123 },
          { params: { projectId: project.id, agentName: "nope" } },
        );
      r.status(400);
    });

    await ctx.step("unknown agent name → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/projects/:projectId/agents/:agentName/scope",
          { env: [] },
          { params: { projectId: project.id, agentName: "does-not-exist" } },
        );
      r.status(404);
    });

    await ctx.step("a member with no project grant cannot scope agents → 404", async () => {
      const bare = await team.addMember("member");
      const r = await ctx.client
        .as(bare)
        .put(
          "/v1/projects/:projectId/agents/:agentName/scope",
          { env: [] },
          { params: { projectId: project.id, agentName: "does-not-exist" } },
        );
      r.status(404);
    });
  },
);

// ─── Enterprise-demo preview toggle (self-serve unlock for the Enterprise UI) ─

flow(
  "IAM-32",
  {
    domain: "iam",
    routes: [
      "GET /v1/accounts/:accountId/iam/enterprise-demo",
      "PUT /v1/accounts/:accountId/iam/enterprise-demo",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();

    await ctx.step("a fresh account starts with the demo off → 200 false", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/accounts/:accountId/iam/enterprise-demo", { params: { accountId: team.id } });
      r.status(200).body().has("$.enabled", false);
    });

    await ctx.step("OWNER enables the demo → 200 true", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/accounts/:accountId/iam/enterprise-demo",
          { enabled: true },
          { params: { accountId: team.id } },
        );
      r.status(200).body().has("$.enabled", true);
    });

    await ctx.step("GET reflects the toggle → 200 true", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/accounts/:accountId/iam/enterprise-demo", { params: { accountId: team.id } });
      r.status(200).body().has("$.enabled", true);
    });

    await ctx.step("non-boolean enabled → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/accounts/:accountId/iam/enterprise-demo",
          { enabled: "yes" },
          { params: { accountId: team.id } },
        );
      r.status(400);
    });

    await ctx.step("NONMEMBER → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/accounts/:accountId/iam/enterprise-demo", { params: { accountId: team.id } });
      r.status(403);
    });

    await ctx.step("OWNER disables the demo again (cleanup) → 200 false", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/accounts/:accountId/iam/enterprise-demo",
          { enabled: false },
          { params: { accountId: team.id } },
        );
      r.status(200).body().has("$.enabled", false);
    });
  },
);

// ─── Self-serve SSO metadata import ─────────────────────────────────────────

flow(
  "IAM-33",
  {
    domain: "iam",
    routes: ["POST /v1/accounts/:accountId/iam/sso/provider/from-metadata"],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();

    await ctx.step("a non-Enterprise account is denied with a clean 402 upsell, not a 500", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/accounts/:accountId/iam/sso/provider/from-metadata",
          { name: "Acme", primary_domain: "acme-e2e-iam33.com", metadata_xml: "<x/>" },
          { params: { accountId: team.id } },
        );
      r.status(402).body().has("$.code", "entitlement_required").has("$.entitlement", "sso");
    });

    await ctx.step("enabling the enterprise-demo preview unlocks the surface", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put(
          "/v1/accounts/:accountId/iam/enterprise-demo",
          { enabled: true },
          { params: { accountId: team.id } },
        );
      r.status(200).body().has("$.enabled", true);
    });

    await ctx.step("missing name → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/accounts/:accountId/iam/sso/provider/from-metadata",
          { primary_domain: "acme-e2e-iam33.com", metadata_xml: "<x/>" },
          { params: { accountId: team.id } },
        );
      r.status(400);
    });

    await ctx.step("invalid domain → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/accounts/:accountId/iam/sso/provider/from-metadata",
          { name: "Acme", primary_domain: "not a domain", metadata_xml: "<x/>" },
          { params: { accountId: team.id } },
        );
      r.status(400);
    });

    await ctx.step("neither metadata_xml nor metadata_url → 400 (or 501 when SSO isn't configured)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/accounts/:accountId/iam/sso/provider/from-metadata",
          { name: "Acme", primary_domain: "acme-e2e-iam33.com" },
          { params: { accountId: team.id } },
        );
      // 400 = Supabase auth admin API reachable, "provide exactly one" body
      // validation; 501 = this deployment has no SUPABASE_SERVICE_ROLE_KEY.
      r.status([400, 501]);
    });

    await ctx.step("NONMEMBER → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .post(
          "/v1/accounts/:accountId/iam/sso/provider/from-metadata",
          { name: "Acme", primary_domain: "acme-e2e-iam33.com", metadata_xml: "<x/>" },
          { params: { accountId: team.id } },
        );
      r.status(403);
    });
  },
);
