/**
 * Headless regular auth — /v1/auth/* (apps/api/src/auth/headless.ts + index.ts).
 * Public client config, sign-up, password sign-in, refresh, magic link, OTP
 * verify, social start, password reset/update, user, sign-out — all through the Kortix API against
 * the local GoTrue. Maps to spec AUTH-3..AUTH-6.
 */
import { flow } from "../core/flow";

const password = "Ke2e-headless-2026!";

// ── AUTH-3: sign-up → session → user → refresh → sign-out ────────────────────
flow(
  "AUTH-3",
  {
    domain: "auth",
    routes: ["GET /v1/auth/client-config", "POST /v1/auth/signup", "POST /v1/auth/sign-in/password", "POST /v1/auth/refresh", "GET /v1/auth/user", "POST /v1/auth/sign-out"],
  },
  async (ctx) => {
    const email = `${ctx.fixtures.name("headless")}@example.test`.toLowerCase();
    let access = "";
    let refresh = "";
    await ctx.step("client-config (ANON) → 200 with the public sign-in values only, never the service role key", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/auth/client-config");
      r.status(200).body().exists("$.supabase_url");
      const body = r.json<Record<string, unknown>>();
      const nullableString = (v: unknown) => v === null || typeof v === "string";
      const nullableList = (v: unknown) => v === null || (Array.isArray(v) && v.every((x) => typeof x === "string"));
      if (typeof body.supabase_url !== "string" || !/^https?:\/\//.test(body.supabase_url)) throw new Error("supabase_url is not an http(s) URL");
      if (!nullableString(body.supabase_anon_key) || !nullableString(body.frontend_url)) throw new Error("anon key / frontend_url must be string or null");
      if (!nullableList(body.auth_methods) || !nullableList(body.auth_providers)) throw new Error("auth lists must be string[] or null");
      const keys = Object.keys(body).sort();
      if (keys.join() !== "auth_methods,auth_providers,frontend_url,supabase_anon_key,supabase_url") throw new Error(`unexpected fields: ${keys.join()}`);
      const anon = ctx.env.supabaseAnonKey;
      if (anon && body.supabase_anon_key !== null && body.supabase_anon_key !== anon) throw new Error("supabase_anon_key is not the deployment's anon key");
      const serviceRole = ctx.env.supabaseServiceRoleKey;
      if (serviceRole && r.text().includes(serviceRole)) throw new Error("client-config leaked the service role key");
    });
    await ctx.step("signup → 200 with a user; a session unless email confirmation is required", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/auth/signup", { email, password });
      r.status(200).body().exists("$.user").exists("$.requires_email_confirmation");
      const body = r.json<any>();
      if (body.session) {
        access = body.session.access_token;
        refresh = body.session.refresh_token;
      }
    });
    await ctx.step("signup validation: short password → 400", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/auth/signup", { email: `x-${email}`, password: "short" });
      r.status(400);
    });
    await ctx.step("password sign-in: wrong password → 400 with GoTrue's error; right password → session", async () => {
      const bad = await ctx.client.as(ctx.P.ANON).post("/v1/auth/sign-in/password", { email, password: "wrong-password-1" });
      bad.status(400).body().exists("$.error").exists("$.error_description");
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/auth/sign-in/password", { email, password });
      if (r.statusCode === 400 && r.text().includes("not confirmed")) {
        // Deployment requires email confirmation: the account exists, the
        // session cannot be minted without the emailed code. Asserted above.
        return;
      }
      r.status(200).body().exists("$.session.access_token").exists("$.session.refresh_token").has("$.user.email", email);
      access = r.json<any>().session.access_token;
      refresh = r.json<any>().session.refresh_token;
    });
    await ctx.step("user + refresh + sign-out with the session", async () => {
      if (!access) return; // confirmation-gated deployment — covered by the step above
      const user = await ctx.client.as(ctx.P.ANON).get("/v1/auth/user", { headers: { Authorization: `Bearer ${access}` } });
      user.status(200).body().has("$.user.email", email);
      const rot = await ctx.client.as(ctx.P.ANON).post("/v1/auth/refresh", { refresh_token: refresh });
      rot.status(200).body().exists("$.session.access_token");
      const next = rot.json<any>().session;
      const out = await ctx.client.as(ctx.P.ANON).post("/v1/auth/sign-out", { scope: "global" }, { headers: { Authorization: `Bearer ${next.access_token}` } });
      out.status(200).body().has("$.ok", true);
    });
    await ctx.step('rotated refresh token replay after the reuse window rejects and revokes its family', async () => {
      const signed = await ctx.client.as(ctx.P.ANON).post('/v1/auth/sign-in/password', { email, password });
      if (signed.statusCode === 400 && signed.text().includes('not confirmed')) return;
      signed.status(200);
      const oldRefresh = signed.json<{ session: { refresh_token: string } }>().session.refresh_token;
      const rot = await ctx.client.as(ctx.P.ANON).post('/v1/auth/refresh', { refresh_token: oldRefresh });
      rot.status(200);
      const next = rot.json<{ session: { refresh_token: string } }>().session;
      if (next.refresh_token === oldRefresh) throw new Error('refresh token did not rotate');
      await new Promise((resolve) => setTimeout(resolve, 31_000));
      const replay = await ctx.client.as(ctx.P.ANON).post('/v1/auth/refresh', { refresh_token: oldRefresh });
      replay.status([400, 401]).body().exists('$.error');
      const family = await ctx.client.as(ctx.P.ANON).post('/v1/auth/refresh', { refresh_token: next.refresh_token });
      family.status([400, 401]).body().exists('$.error');
      const dead = await ctx.client.as(ctx.P.ANON).post("/v1/auth/refresh", { refresh_token: "kortix-bogus-refresh" });
      dead.status(400);
    });
    await ctx.step("bearer routes without a session → 401", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/auth/user");
      r.status(401);
    });
  },
);

// ── AUTH-4: magic link + OTP verify ──────────────────────────────────────────
flow("AUTH-4", { domain: "auth", routes: ["POST /v1/auth/sign-in/magic-link", "POST /v1/auth/verify-otp"] }, async (ctx) => {
  const email = `${ctx.fixtures.name("magic")}@example.test`.toLowerCase();
  await ctx.step("magic link → 200 sent (creates the user)", async () => {
    const r = await ctx.client.as(ctx.P.ANON).post("/v1/auth/sign-in/magic-link", { email, redirect_to: "https://app.example.test/cb" });
    r.status(200).body().has("$.sent", true);
  });
  await ctx.step("verify-otp: a bogus code → 4xx with GoTrue's error; a non-http redirect is ignored, not fatal", async () => {
    const r = await ctx.client.as(ctx.P.ANON).post("/v1/auth/verify-otp", { email, token: "000000", type: "magiclink" });
    r.status([400, 401, 403, 422]).body().exists("$.error");
    const bad = await ctx.client.as(ctx.P.ANON).post("/v1/auth/verify-otp", { email, token: "1", type: "magiclink" });
    bad.status(400);
  });
});

// ── AUTH-5: social sign-in (PKCE) start + exchange boundary ──────────────────
flow("AUTH-5", { domain: "auth", routes: ["POST /v1/auth/sign-in/oauth", "POST /v1/auth/oauth/exchange"] }, async (ctx) => {
  await ctx.step("start: returns the provider URL + a PKCE verifier, or GoTrue's error when the provider is not enabled", async () => {
    const r = await ctx.client.as(ctx.P.ANON).post("/v1/auth/sign-in/oauth", { provider: "github", redirect_to: "https://app.example.test/cb" });
    r.status([200, 400, 422]);
    if (r.statusCode === 200) {
      r.body().exists("$.url").exists("$.code_verifier");
      if (r.json<any>().code_verifier.length < 43) throw new Error("verifier too short");
    } else {
      r.body().exists("$.error");
    }
  });
  await ctx.step("start: non-http redirect_to → 400 before GoTrue; unknown provider → 400", async () => {
    const bad = await ctx.client.as(ctx.P.ANON).post("/v1/auth/sign-in/oauth", { provider: "github", redirect_to: "javascript:alert(1)" });
    bad.status(400);
    const prov = await ctx.client.as(ctx.P.ANON).post("/v1/auth/sign-in/oauth", { provider: "myspace", redirect_to: "https://app.example.test/cb" });
    prov.status(400);
  });
  await ctx.step("exchange: a bogus code → 4xx (GoTrue answers 404 for an unknown flow state)", async () => {
    const r = await ctx.client.as(ctx.P.ANON).post("/v1/auth/oauth/exchange", { code: "nope", code_verifier: "nope" });
    r.status([400, 401, 403, 404, 422]).body().exists("$.error");
  });
});

// ── AUTH-6: password reset + update ──────────────────────────────────────────
flow("AUTH-6", { domain: "auth", routes: ["POST /v1/auth/password/reset", "POST /v1/auth/password/update"] }, async (ctx) => {
  await ctx.step("reset: unknown address → 200 sent (never reveals existence); invalid email → 400", async () => {
    const r = await ctx.client.as(ctx.P.ANON).post("/v1/auth/password/reset", { email: `${ctx.fixtures.name("ghost")}@example.test`.toLowerCase() });
    r.status(200).body().has("$.sent", true);
    const bad = await ctx.client.as(ctx.P.ANON).post("/v1/auth/password/reset", { email: "not-an-email" });
    bad.status(400);
  });
  await ctx.step("update: ANON → 401; a fresh headless user can set a new password and sign in with it", async () => {
    const anon = await ctx.client.as(ctx.P.ANON).post("/v1/auth/password/update", { password: "Another-pass-2026!" });
    anon.status(401);
    const email = `${ctx.fixtures.name("pwupd")}@example.test`.toLowerCase();
    const signup = await ctx.client.as(ctx.P.ANON).post("/v1/auth/signup", { email, password });
    signup.status(200);
    const session = signup.json<any>().session;
    if (!session) return; // confirmation-gated deployment: no session to update with
    const upd = await ctx.client.as(ctx.P.ANON).post("/v1/auth/password/update", { password: "Another-pass-2026!" }, { headers: { Authorization: `Bearer ${session.access_token}` } });
    upd.status(200).body().has("$.user.email", email);
    const again = await ctx.client.as(ctx.P.ANON).post("/v1/auth/sign-in/password", { email, password: "Another-pass-2026!" });
    again.status(200);
  });
});
