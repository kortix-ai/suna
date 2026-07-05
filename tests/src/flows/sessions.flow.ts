/**
 * Sessions — create/list/get/delete + sandbox status. Maps to spec §16 (SESS-*).
 * Session creation provisions a REAL Daytona sandbox (fire-and-forget), so these
 * assert the contract (201 provisioning, status transitions) without blocking on
 * a full boot. Gated on the `daytona` capability.
 */
import { flow } from "../core/flow";

flow(
  "SESS-1",
  { domain: "sessions", requires: ["daytona", "funded"], timeoutMs: 120_000, routes: ["POST /v1/projects/:projectId/sessions"] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step("create session → 201 provisioning", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/sessions", { initial_prompt: "noop" }, { params: { projectId: p.id } });
      r.status(201);
      const id = r.json<any>()?.session_id ?? r.json<any>()?.id;
      if (id) ctx.track("session", id, { projectId: p.id });
    });
  },
);

flow(
  "SESS-4",
  { domain: "sessions", requires: ["daytona", "funded"], timeoutMs: 120_000, routes: ["GET /v1/projects/:projectId/sessions"] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    await ctx.step("list sessions", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/projects/:projectId/sessions", { params: { projectId: p.id } });
      r.status(200);
    });
  },
);

flow(
  "SESS-5",
  { domain: "sessions", requires: ["daytona", "funded"], timeoutMs: 120_000, routes: ["GET /v1/projects/:projectId/sessions/:sessionId"] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    const s = await ctx.fixtures.session(p);
    await ctx.step("get session → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/sessions/:sessionId", { params: { projectId: p.id, sessionId: s.id } });
      r.status(200);
    });
    await ctx.step("non-uuid session id → 400", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/sessions/:sessionId", { params: { projectId: p.id, sessionId: "not-a-uuid" } });
      r.status(400);
    });
  },
);

flow(
  "SESS-8",
  { domain: "sessions", requires: ["daytona", "funded"], timeoutMs: 120_000, routes: ["GET /v1/projects/:projectId/sessions/:sessionId/sandbox"] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    const s = await ctx.fixtures.session(p);
    await ctx.step("sandbox status row (404 until inserted, else provisioning/active)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/projects/:projectId/sessions/:sessionId/sandbox", { params: { projectId: p.id, sessionId: s.id } });
      r.status([200, 404]);
    });
  },
);

flow(
  "SESS-7",
  { domain: "sessions", requires: ["daytona", "funded"], timeoutMs: 120_000, routes: ["DELETE /v1/projects/:projectId/sessions/:sessionId"] },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    const s = await ctx.fixtures.session(p);
    await ctx.step("delete session → 200 stopped", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/projects/:projectId/sessions/:sessionId", { params: { projectId: p.id, sessionId: s.id } });
      r.status(200);
    });
  },
);

/**
 * SESS-13 — session public shares: CRUD lifecycle + the unauthenticated
 * resolution endpoint. Source of truth: projects/routes/public-shares.ts +
 * shared/session-public-shares.ts (CRUD) and sandbox-proxy/routes/public-share.ts
 * (anon resolution, mounted BEFORE combinedAuth in sandbox-proxy/index.ts — it
 * is genuinely public, no token/cookie ever required).
 *
 * REAL status codes confirmed from source (not guessed):
 *  - a revoked token resolves → 410 "Share link revoked" (resolvePublicShare
 *    checks `revokedAt` BEFORE it ever looks at the sandbox) — NOT 404.
 *  - an unknown token → 404 "Share link not found".
 *  - a real, not-yet-revoked token whose sandbox has no `externalId` yet → 503
 *    "Sandbox is not ready". `resolvePublicShare` LEFT (not INNER) JOINs
 *    `session_sandboxes` for exactly this reason: a freshly-created session
 *    frequently has no `session_sandboxes` row at all yet (provisioning is
 *    kicked off in the background, not awaited before POST /sessions
 *    responds), and an INNER JOIN made that case fall into `!row` → a false
 *    404 ("not found") for a share token that is perfectly valid. `session_id`
 *    is unique on `session_sandboxes` (one row per session), so the LEFT JOIN
 *    never fans out — only [200, 503] are legal for a fresh, unrevoked token.
 *  - `listPublicSharesForSession` does NOT filter out revoked shares —
 *    revoking sets `revoked_at`, it does not remove the row from the list.
 *  - revoke has no idempotency guard (the UPDATE...WHERE matches on
 *    shareId+sessionId only, not `revoked_at IS NULL`), so revoking twice is
 *    200 both times, not a 409/404 on the second call.
 */
flow(
  "SESS-13",
  {
    domain: "sessions",
    requires: ["daytona", "funded"],
    timeoutMs: 90_000,
    routes: [
      "POST /v1/projects/:projectId/sessions",
      "POST /v1/projects/:projectId/sessions/:sessionId/public-shares",
      "GET /v1/projects/:projectId/sessions/:sessionId/public-shares",
      "DELETE /v1/projects/:projectId/sessions/:sessionId/public-shares/:shareId",
      "GET /v1/p/public-share/:token",
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project();
    const session = await ctx.fixtures.session(project);
    const owner = ctx.client.as(ctx.P.OWNER);

    let shareId = "";
    let token = "";
    await ctx.step("create a preview public share → 201 with token + shape", async () => {
      const r = await owner.post(
        "/v1/projects/:projectId/sessions/:sessionId/public-shares",
        { preview: { port: 5173, path: "/", label: "ke2e preview" } },
        { params: { projectId: project.id, sessionId: session.id } },
      );
      r.status(201)
        .body()
        .has("$.share.session_id", session.id)
        .has("$.share.project_id", project.id)
        .has("$.share.resource_type", "preview")
        .has("$.share.port", 5173)
        .has("$.share.mode", "view")
        .exists("$.share.share_id")
        .matches("$.share.public_token", /^kps_[0-9a-f]{32}$/)
        .matches("$.share.public_path", /^\/share\/session\/kps_[0-9a-f]{32}$/)
        .exists("$.share.proxy_path");
      const body = r.json<any>();
      shareId = body.share.share_id;
      token = body.share.public_token;
    });

    await ctx.step("list shows the share → 200", async () => {
      const r = await owner.get("/v1/projects/:projectId/sessions/:sessionId/public-shares", {
        params: { projectId: project.id, sessionId: session.id },
      });
      r.status(200).body().has("$.shares[0].share_id", shareId);
    });

    await ctx.step("unauthenticated resolution of an unknown token → 404", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/p/public-share/:token", { params: { token: "kps_ke2e_does_not_exist" } });
      r.status(404);
    });

    await ctx.step(
      "unauthenticated resolution of the real token → 200 (sandbox ready) or 503 (not yet) — never an auth error",
      async () => {
        const r = await ctx.client.as(ctx.P.ANON).get("/v1/p/public-share/:token", { params: { token } });
        r.status([200, 503]);
        if (r.statusCode === 200) {
          r.body()
            .has("$.share.share_id", shareId)
            .has("$.share.session_id", session.id)
            .exists("$.share.proxy_path");
        }
      },
    );

    await ctx.step("revoke the share → 200 with revoked_at set", async () => {
      const r = await owner.del("/v1/projects/:projectId/sessions/:sessionId/public-shares/:shareId", {
        params: { projectId: project.id, sessionId: session.id, shareId },
      });
      r.status(200).body().has("$.share.share_id", shareId).exists("$.share.revoked_at");
    });

    await ctx.step("list still shows the (now revoked) share — revoke does not delete the row", async () => {
      const r = await owner.get("/v1/projects/:projectId/sessions/:sessionId/public-shares", {
        params: { projectId: project.id, sessionId: session.id },
      });
      r.status(200).body().has("$.shares[0].share_id", shareId).exists("$.shares[0].revoked_at");
    });

    await ctx.step("unauthenticated resolution of the revoked token → 410 Gone (not 404)", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/p/public-share/:token", { params: { token } });
      r.status(410);
    });

    await ctx.step("revoking again is idempotent → 200 (no guard against double-revoke)", async () => {
      const r = await owner.del("/v1/projects/:projectId/sessions/:sessionId/public-shares/:shareId", {
        params: { projectId: project.id, sessionId: session.id, shareId },
      });
      r.status(200);
    });

    await ctx.step("revoking an unknown share id on this session → 404", async () => {
      const r = await owner.del("/v1/projects/:projectId/sessions/:sessionId/public-shares/:shareId", {
        params: { projectId: project.id, sessionId: session.id, shareId: crypto.randomUUID() },
      });
      r.status(404);
    });

    await ctx.step("malformed (non-uuid) share id → 400", async () => {
      const r = await owner.del("/v1/projects/:projectId/sessions/:sessionId/public-shares/:shareId", {
        params: { projectId: project.id, sessionId: session.id, shareId: "not-a-uuid" },
      });
      r.status(400);
    });
  },
);

/**
 * SESS-14 — public share access boundary. `canManageSharing = isOwner (the
 * session creator) || canManageProject (roleAllows('manage') — i.e. the top
 * project role editor, or account owner/admin)` — projects/lib/access.ts
 * `loadSessionForSharing()`. Project-role collapse: `manager` was retired and
 * `editor` is now the top project role, so 'write' and 'manage' collapse to
 * the same check — a project EDITOR who did NOT create the session CAN now
 * manage its shares (200) via the canManageProject half of the OR. The denied
 * case is a plain project MEMBER (floor role) who did not create the session
 * (403, the sharing-specific message). NONMEMBER is denied earlier, by the
 * account-membership gate in `loadProjectForUser` (throws 403 before the
 * sharing check is ever reached). ANON never reaches the handler (401,
 * `supabaseAuth`).
 *
 * `loadSessionForSharing` is deliberately NOT `loadVisibleSession` (the
 * content-visibility gate used for reading a session's transcript): the
 * public-shares routes used to call `loadVisibleSession`, whose
 * `isSessionVisibleTo` check hides a default-`private` session from everyone
 * but its creator — including a project editor/owner with no adminBypass.
 * That made the `canManageProject` half of the OR unreachable: the route
 * 404'd on the visibility gate before ever computing `canManageSharing`, and
 * a plain member got the same 404 instead of the informative 403 this spec
 * expects. `loadSessionForSharing` loads the same row but only computes
 * isOwner/canManageProject — no content-visibility check — since managing
 * share links is a project-management action, not a "can you read this
 * conversation" one.
 */
flow(
  "SESS-14",
  {
    domain: "sessions",
    requires: ["daytona", "funded"],
    timeoutMs: 90_000,
    routes: [
      "POST /v1/projects/:projectId/sessions",
      "POST /v1/projects/:projectId/sessions/:sessionId/public-shares",
      "GET /v1/projects/:projectId/sessions/:sessionId/public-shares",
      "DELETE /v1/projects/:projectId/sessions/:sessionId/public-shares/:shareId",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const p = await team.project();
    // A plain project MEMBER (floor role) — the denied case: has project
    // access but cannot manage the project, so cannot manage someone else's
    // session's shares.
    const member = await team.addMember("member");
    await team.grantProjectRole(p.id, member.userId!, "user");
    // A project EDITOR (the top project role now) — the allowed case: editor
    // holds the coarse 'manage' capability (write ≡ manage after the
    // project-role collapse), so canManageProject is true even though they
    // did not create the session.
    const editor = await team.addMember("member");
    await team.grantProjectRole(p.id, editor.userId!, "editor");

    const owner = ctx.client.as(ctx.P.OWNER);
    let sessionId = "";
    await ctx.step("OWNER (the account owner) creates the session — session creator", async () => {
      const r = await owner.post(
        "/v1/projects/:projectId/sessions",
        { initial_prompt: "noop" },
        { params: { projectId: p.id } },
      );
      r.status(201);
      sessionId = r.json<any>()?.session_id ?? r.json<any>()?.id;
      ctx.track("session", sessionId, { projectId: p.id });
    });

    let shareId = "";
    await ctx.step("the creator can create a public share", async () => {
      const r = await owner.post(
        "/v1/projects/:projectId/sessions/:sessionId/public-shares",
        { preview: { port: 3000 } },
        { params: { projectId: p.id, sessionId } },
      );
      r.status(201);
      shareId = r.json<any>()?.share?.share_id;
    });

    await ctx.step("a plain project MEMBER who did not create the session cannot list shares → 403", async () => {
      const r = await ctx.client
        .as(member)
        .get("/v1/projects/:projectId/sessions/:sessionId/public-shares", { params: { projectId: p.id, sessionId } });
      r.status(403);
    });
    await ctx.step("a plain project MEMBER cannot create a share on someone else's session → 403", async () => {
      const r = await ctx.client
        .as(member)
        .post(
          "/v1/projects/:projectId/sessions/:sessionId/public-shares",
          { preview: { port: 3000 } },
          { params: { projectId: p.id, sessionId } },
        );
      r.status(403);
    });
    await ctx.step("a plain project MEMBER cannot revoke someone else's share → 403", async () => {
      const r = await ctx.client
        .as(member)
        .del("/v1/projects/:projectId/sessions/:sessionId/public-shares/:shareId", {
          params: { projectId: p.id, sessionId, shareId },
        });
      r.status(403);
    });

    await ctx.step("a project EDITOR (the top project role, not the creator) CAN list shares → 200 (isOwner || canManageProject)", async () => {
      const r = await ctx.client
        .as(editor)
        .get("/v1/projects/:projectId/sessions/:sessionId/public-shares", { params: { projectId: p.id, sessionId } });
      r.status(200).body().has("$.shares[0].share_id", shareId);
    });

    await ctx.step("NONMEMBER → 403 (no account membership at all)", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/projects/:projectId/sessions/:sessionId/public-shares", { params: { projectId: p.id, sessionId } });
      r.status(403);
    });
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/projects/:projectId/sessions/:sessionId/public-shares", { params: { projectId: p.id, sessionId } });
      r.status(401);
    });
  },
);

/**
 * SESS-15 — per-session agent action audit log. Same visibility gate as
 * session detail (project read + the session must be visible to the caller —
 * projects/routes/r7.ts). Non-Enterprise accounts degrade to pending-only
 * (never a 402 here: this is the always-on approval control plane the
 * launcher polls from every open session).
 */
flow(
  "SESS-15",
  {
    domain: "sessions",
    requires: ["daytona", "funded"],
    timeoutMs: 90_000,
    routes: ["GET /v1/projects/:projectId/sessions/:sessionId/audit"],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    const s = await ctx.fixtures.session(p);
    const owner = ctx.client.as(ctx.P.OWNER);

    await ctx.step("read the session audit trail → 200 (empty on a fresh session)", async () => {
      const r = await owner.get("/v1/projects/:projectId/sessions/:sessionId/audit", {
        params: { projectId: p.id, sessionId: s.id },
      });
      r.status(200).body().has("$.session_id", s.id).has("$.count", 0).exists("$.actions").exists("$.audit_access");
    });
    await ctx.step("non-uuid session id → 400", async () => {
      const r = await owner.get("/v1/projects/:projectId/sessions/:sessionId/audit", {
        params: { projectId: p.id, sessionId: "not-a-uuid" },
      });
      r.status(400);
    });
    await ctx.step("invalid limit (below 1) → 400", async () => {
      const r = await owner.get("/v1/projects/:projectId/sessions/:sessionId/audit", {
        params: { projectId: p.id, sessionId: s.id },
        query: { limit: "0" },
      });
      r.status(400);
    });
    await ctx.step("NONMEMBER → 403", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .get("/v1/projects/:projectId/sessions/:sessionId/audit", { params: { projectId: p.id, sessionId: s.id } });
      r.status(403);
    });
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/projects/:projectId/sessions/:sessionId/audit", { params: { projectId: p.id, sessionId: s.id } });
      r.status(401);
    });
  },
);

/**
 * SESS-16 — anonymous session-share VIEWING: `GET /v1/public/session-shares/:shareId`
 * and `.../messages`, mounted at `apps/api/src/public-session-shares/index.ts`
 * (public/session-shares/index.ts, no auth middleware). Closes the backend
 * gap `(public)/share/[shareId]` (apps/web `ShareViewer.tsx`) had flagged
 * in-code since #4124: that page has no public-share token in its route and
 * the sandbox-proxy's own public-share family deliberately blocks port 8000
 * (`PUBLIC_SHARE_BLOCKED_PORTS` in shared/session-public-shares.ts), so it
 * could never serve a session's title/transcript to a logged-out visitor.
 *
 * `:shareId` here is the SESS-13 share's raw `share_id` (the uuid — the SAME
 * value the CRUD responses call `share.share_id`), NOT the `kps_...` public
 * token `/v1/p/public-share/:token` uses. The route derives the token
 * server-side (`publicShareToken(shareId)`) and resolves through the exact
 * same `resolvePublicShare()` SESS-13 covers, so it inherits identical
 * 404 (unknown) / 410 (revoked or expired) / 503 (sandbox not provisioned
 * yet) semantics — and ANY existing share for the session (created as a
 * `preview` or a `file`, the only kinds the CRUD supports today) unlocks the
 * transcript view too: a share token already proves the owner handed this
 * link to someone outside the account, and the read-only conversation is not
 * more sensitive than the live preview or workspace file that SAME token
 * already exposes.
 *
 * The metadata route (`GET /:shareId`) is DB-only (title/status/timestamps),
 * so it does not itself 503 on an inactive sandbox — only `resolvePublicShare`'s
 * own missing-`externalId` check can. The messages route additionally 503s
 * when the sandbox row exists but isn't `active`, and otherwise degrades to a
 * 200 `{available:false, reason}` digest (mirroring the authenticated
 * `/transcript` debug endpoint's behavior) for transient OpenCode-not-ready
 * states — a polling frontend should retry those, not treat them as fatal.
 */
flow(
  "SESS-16",
  {
    domain: "sessions",
    requires: ["daytona", "funded"],
    timeoutMs: 90_000,
    routes: [
      "POST /v1/projects/:projectId/sessions/:sessionId/public-shares",
      "DELETE /v1/projects/:projectId/sessions/:sessionId/public-shares/:shareId",
      "GET /v1/public/session-shares/:shareId",
      "GET /v1/public/session-shares/:shareId/messages",
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project();
    const session = await ctx.fixtures.session(project);
    const owner = ctx.client.as(ctx.P.OWNER);
    const anon = ctx.client.as(ctx.P.ANON);

    let shareId = "";
    await ctx.step("create a preview public share → 201", async () => {
      const r = await owner.post(
        "/v1/projects/:projectId/sessions/:sessionId/public-shares",
        { preview: { port: 5173, path: "/", label: "ke2e session-share" } },
        { params: { projectId: project.id, sessionId: session.id } },
      );
      r.status(201);
      shareId = r.json<any>()?.share?.share_id;
    });

    await ctx.step("anon: unknown share id → 404 on metadata", async () => {
      const r = await anon.get("/v1/public/session-shares/:shareId", {
        params: { shareId: crypto.randomUUID() },
      });
      r.status(404);
    });

    await ctx.step("anon: unknown share id → 404 on messages", async () => {
      const r = await anon.get("/v1/public/session-shares/:shareId/messages", {
        params: { shareId: crypto.randomUUID() },
      });
      r.status(404);
    });

    await ctx.step("anon: malformed (non-uuid) share id → 400", async () => {
      const r = await anon.get("/v1/public/session-shares/:shareId", { params: { shareId: "not-a-uuid" } });
      r.status(400);
    });

    await ctx.step(
      "anon: view metadata for the real share → 200 (sandbox ready) or 503 (not yet) — never an auth error",
      async () => {
        const r = await anon.get("/v1/public/session-shares/:shareId", { params: { shareId } });
        r.status([200, 503]);
        if (r.statusCode === 200) {
          r.body()
            .has("$.share.share_id", shareId)
            .has("$.share.session_id", session.id)
            .has("$.session.session_id", session.id)
            .exists("$.session.status")
            .exists("$.session.created_at");
        }
      },
    );

    await ctx.step(
      "anon: read the sanitized transcript for the real share → 200 (digest) or 503 (sandbox not up)",
      async () => {
        const r = await anon.get("/v1/public/session-shares/:shareId/messages", { params: { shareId } });
        r.status([200, 503]);
        if (r.statusCode === 200) {
          r.body().exists("$.available").exists("$.messages").exists("$.message_count");
        }
      },
    );

    await ctx.step("revoke the share → 200", async () => {
      const r = await owner.del("/v1/projects/:projectId/sessions/:sessionId/public-shares/:shareId", {
        params: { projectId: project.id, sessionId: session.id, shareId },
      });
      r.status(200);
    });

    await ctx.step("anon: revoked share's metadata → 410 Gone (not 404)", async () => {
      const r = await anon.get("/v1/public/session-shares/:shareId", { params: { shareId } });
      r.status(410);
    });

    await ctx.step("anon: revoked share's messages → 410 Gone (not 404)", async () => {
      const r = await anon.get("/v1/public/session-shares/:shareId/messages", { params: { shareId } });
      r.status(410);
    });
  },
);
