/**
 * Auth-side server endpoints. Two routes today, both gated by `supabaseAuth`:
 *   - GET  /v1/user-roles  → {isAdmin, role} platform role (spec SYS-3)
 *   - POST /v1/auth/logout → server-side logout (audit + session revoke) (AUTH-1)
 *
 * See apps/api/src/auth/index.ts (authRouter.use('/*', supabaseAuth)) and
 * apps/api/src/index.ts (app.get('/v1/user-roles', supabaseAuth, …)).
 *
 * Use a flow-scoped user: logging out the shared OWNER revokes the identity
 * that PRX-1 and other flows need for the rest of the run.
 * Logout revokes the GoTrue session. `POST /v1/p/auth` asks GoTrue on every
 * call, so it proves the revoke on any signing algorithm. `supabaseAuth` checks
 * an ES256 bearer locally (signature + exp, apps/api/src/shared/jwt-verify.ts),
 * so on the local stack that bearer stays valid there until it expires.
 * The logout endpoint is documented to *always* return 200 once authed — even
 * when there's nothing to revoke — so clients never have to handle "not signed
 * in" on a logout. Being supabaseAuth-gated, ANON is rejected before that logic
 * runs, so ANON → 401 (SET kept permissive: some deployments treat logout as
 * idempotent and may answer 200/204 even without a session).
 */
import { flow } from "../core/flow";

flow(
  "SYS-3",
  { domain: "auth", tags: ["smoke"], routes: ["GET /v1/user-roles"] },
  async (ctx) => {
    await ctx.step("OWNER sees platform role", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/user-roles");
      r.status(200).body().exists("$.isAdmin").exists("$.role");
    });
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/user-roles");
      r.status(401);
    });
  },
);

flow(
  "AUTH-1",
  { domain: "auth", routes: ["POST /v1/auth/logout", "POST /v1/p/auth"] },
  async (ctx) => {
    const session = await ctx.fixtures.user({ label: "LOGOUT" });
    await ctx.step("logout revokes only this flow's session, not the shared OWNER", async () => {
      const live = await ctx.client.as(session).post("/v1/p/auth", {});
      live.status([200, 204]);
      const r = await ctx.client.as(session).post("/v1/auth/logout", {});
      r.status([200, 204]);
      const revoked = await ctx.client.as(session).post("/v1/p/auth", {});
      revoked.status(401);
      const owner = await ctx.client.as(ctx.P.OWNER).post("/v1/p/auth", {});
      owner.status([200, 204]);
    });
    await ctx.step("ANON → 401 (supabaseAuth-gated)", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/auth/logout", {});
      r.status([200, 401]);
    });
  },
);
