/**
 * Auth-side server endpoints. Two routes today, both gated by `supabaseAuth`:
 *   - GET  /v1/user-roles  → {isAdmin, role} platform role (spec SYS-3)
 *   - POST /v1/auth/logout → server-side logout (audit + session revoke) (AUTH-1)
 *
 * See apps/api/src/auth/index.ts (authRouter.use('/*', supabaseAuth)) and
 * apps/api/src/index.ts (app.get('/v1/user-roles', supabaseAuth, …)).
 *
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
  { domain: "auth", routes: ["POST /v1/auth/logout"] },
  async (ctx) => {
    await ctx.step("OWNER logout → 200 (idempotent server-side logout)", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).post("/v1/auth/logout", {});
      r.status([200, 204]);
    });
    await ctx.step("ANON → 401 (supabaseAuth-gated)", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/auth/logout", {});
      r.status([200, 401]);
    });
  },
);
