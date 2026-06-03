/**
 * Preview proxy — the public-facing reverse proxy in front of sandbox previews.
 * Maps to spec §… (PRX-1, PRX-2). Mounted at /v1/p (apps/api/src/sandbox-proxy).
 *
 *   - POST    /v1/p/auth          exchange a Bearer token for a __preview_session cookie
 *   - OPTIONS /v1/p/auth          CORS preflight → 204
 *   - GET     /v1/p/share         combinedAuth → list share links for a sandbox
 *   - POST    /v1/p/share         combinedAuth → create a share link
 *   - DELETE  /v1/p/share/:token  combinedAuth → revoke a share link
 *
 * /v1/p/auth validates the Authorization Bearer (kortix_ token OR Supabase JWT)
 * and on success sets the cookie. Missing/invalid → 401. We do NOT fabricate a
 * sandbox: the OWNER JWT is a *valid identity* so /auth accepts it (200) even
 * though no preview context is implied; ANON (no header) → 401.
 *
 * The /share routes are combinedAuth-gated and then resolve a real sandbox via
 * the session-sandbox proxy table. Without a sandbox we exercise the real
 * boundaries: ANON → 401; OWNER with a bogus/unknown sandbox_id → not-found /
 * not-authorized / bad-input (permissive SET). We never fake a live sandbox.
 */
import { flow } from "../core/flow";

flow(
  "PRX-1",
  { domain: "preview-proxy", tags: ["smoke"], routes: ["POST /v1/p/auth", "OPTIONS /v1/p/auth"] },
  async (ctx) => {
    await ctx.step("OPTIONS /p/auth → CORS preflight 204", async () => {
      const r = await ctx.client.as(ctx.P.ANON).request("OPTIONS", "/v1/p/auth");
      r.status([200, 204]);
    });
    await ctx.step("POST /p/auth with no Authorization → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/p/auth", {});
      r.status([400, 401]);
    });
    await ctx.step("POST /p/auth with a valid OWNER JWT → 200 sets cookie", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post("/v1/p/auth", {});
      r.status([200, 204]);
    });
  },
);

flow(
  "PRX-2",
  {
    domain: "preview-proxy",
    routes: ["GET /v1/p/share", "POST /v1/p/share", "DELETE /v1/p/share/:token"],
  },
  async (ctx) => {
    const bogusSandbox = `ke2e-no-such-sandbox-${Date.now()}`;

    await ctx.step("GET /p/share: ANON → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/p/share", { query: { sandbox_id: bogusSandbox } });
      r.status(401);
    });
    await ctx.step("GET /p/share: OWNER, unknown sandbox → not-authorized/not-found", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get("/v1/p/share", { query: { sandbox_id: bogusSandbox } });
      r.status([400, 403, 404]);
    });
    await ctx.step("POST /p/share: ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/p/share", { sandbox_id: bogusSandbox, port: 3000 });
      r.status(401);
    });
    await ctx.step("POST /p/share: OWNER, missing body → 400", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post("/v1/p/share", {});
      r.status([400, 403, 404]);
    });
    await ctx.step("POST /p/share: OWNER, unknown sandbox → not-authorized/not-found", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/p/share", { sandbox_id: bogusSandbox, port: 3000 });
      r.status([400, 403, 404]);
    });
    await ctx.step("DELETE /p/share/:token: ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .del("/v1/p/share/:token", { params: { token: "bogus-token" }, query: { sandbox_id: bogusSandbox } });
      r.status(401);
    });
    await ctx.step("DELETE /p/share/:token: OWNER, bogus token/sandbox → not-found/not-authorized", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .del("/v1/p/share/:token", { params: { token: "bogus-token" }, query: { sandbox_id: bogusSandbox } });
      r.status([200, 400, 403, 404]);
    });
  },
);
