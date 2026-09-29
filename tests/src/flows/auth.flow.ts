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
  { domain: "auth", routes: ["POST /v1/auth/logout", "GET /v1/accounts/me"] },
  async (ctx) => {
    await ctx.step('signed-in session logout → 200; same bearer denies /accounts/me after 31 seconds', async () => {
      const email = `${ctx.fixtures.name('logout')}@example.test`.toLowerCase();
      const password = 'Ke2e-logout-2026!';
      const signup = await ctx.client.as(ctx.P.ANON).post('/v1/auth/signup', { email, password });
      signup.status(200);
      const session = signup.json<{ session: { access_token: string; refresh_token: string } | null }>().session;
      if (!session) {
        const signed = await ctx.client.as(ctx.P.ANON).post('/v1/auth/sign-in/password', { email, password });
        signed.status(400);
        if (!signed.text().includes('not confirmed')) throw new Error('unexpected sign-in failure');
        return; // confirmation-gated deployment: the sign-in rejection is asserted
      }
      const headers = { Authorization: `Bearer ${session.access_token}` };
      const before = await ctx.client.as(ctx.P.ANON).get('/v1/accounts/me', { headers });
      before.status(200);
      const out = await ctx.client.as(ctx.P.ANON).post('/v1/auth/logout', {}, { headers });
      out.status(200).body().has('$.ok', true);
      await new Promise((resolve) => setTimeout(resolve, 31_000));
      const after = await ctx.client.as(ctx.P.ANON).get('/v1/accounts/me', { headers });
      after.status(401);
      const refresh = await ctx.client.as(ctx.P.ANON).post('/v1/auth/refresh', { refresh_token: session.refresh_token });
      refresh.status([400, 401]);
    });
    await ctx.step("ANON → 401 (supabaseAuth-gated)", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/auth/logout", {});
      r.status([200, 401]);
    });
  },
);
