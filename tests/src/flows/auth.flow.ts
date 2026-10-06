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
 * Logout revokes the GoTrue session. `supabaseAuth` confirms every access
 * token (ES256 and HS256) with GoTrue through the liveness cache in
 * apps/api/src/shared/jwt-liveness.ts, so the revoked bearer gets 401 on
 * `GET /v1/accounts/me`, a route without the account session gate.
 * The logout endpoint is documented to *always* return 200 once authed — even
 * when there's nothing to revoke — so clients never have to handle "not signed
 * in" on a logout. Being supabaseAuth-gated, ANON is rejected before that logic
 * runs, so ANON → 401 (SET kept permissive: some deployments treat logout as
 * idempotent and may answer 200/204 even without a session).
 */
import { flow } from "../core/flow";
import { PASSWORD } from "../fixtures/principals";

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
  { domain: "auth", routes: ["POST /v1/auth/logout", "POST /v1/p/auth", "GET /v1/accounts/me"] },
  async (ctx) => {
    const session = await ctx.fixtures.user({ label: "LOGOUT" });
    await ctx.step("logout revokes only this flow's session, not the shared OWNER", async () => {
      const live = await ctx.client.as(session).post("/v1/p/auth", {});
      live.status([200, 204]);
      const r = await ctx.client.as(session).post("/v1/auth/logout", {});
      r.status([200, 204]);
      const revoked = await ctx.client.as(session).post("/v1/p/auth", {});
      revoked.status(401);
      const me = await ctx.client.as(session).get("/v1/accounts/me");
      me.status(401);
      const owner = await ctx.client.as(ctx.P.OWNER).post("/v1/p/auth", {});
      owner.status([200, 204]);
    });
    await ctx.step("ANON → 401 (supabaseAuth-gated)", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/auth/logout", {});
      r.status([200, 401]);
    });
  },
);

// Signed-in devices: the caller's live GoTrue sessions, read from
// auth.sessions by the API (a browser can only see its own session).
flow(
  "AUTH-7",
  { domain: "auth", routes: ["GET /v1/accounts/me/devices", "DELETE /v1/accounts/me/devices/:sessionId"] },
  async (ctx) => {
    const here = await ctx.fixtures.user({ label: "DEVICES" });
    const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });
    let other = { access: "", refresh: "", id: "" };
    let hereId = "";

    await ctx.step("a second password sign-in → a second device in the list; only the caller's is current", async () => {
      const signIn = await ctx.client.as(ctx.P.ANON).post("/v1/auth/sign-in/password", { email: here.email, password: PASSWORD }, {
        headers: { "user-agent": "Mozilla/5.0 (iPhone) Safari/604.1" },
      });
      signIn.status(200);
      other = { access: signIn.json<any>().session.access_token, refresh: signIn.json<any>().session.refresh_token, id: "" };
      const r = await ctx.client.as(here).get("/v1/accounts/me/devices");
      r.status(200);
      const devices = r.json<any>().devices as Array<{ session_id: string; current: boolean; signed_in_at: string; last_active_at: string }>;
      if (devices.length !== 2) throw new Error(`expected 2 devices, got ${devices.length}`);
      if (devices.filter((d) => d.current).length !== 1) throw new Error("expected exactly one current device");
      hereId = devices.find((d) => d.current)!.session_id;
      other.id = devices.find((d) => !d.current)!.session_id;
      for (const d of devices) {
        if (Number.isNaN(Date.parse(d.signed_in_at)) || Number.isNaN(Date.parse(d.last_active_at))) throw new Error("timestamps must be ISO dates");
      }
      const fromOther = await ctx.client.as(ctx.P.ANON).get("/v1/accounts/me/devices", bearer(other.access));
      fromOther.status(200);
      const otherView = fromOther.json<any>().devices.find((d: { current: boolean }) => d.current);
      if (otherView?.session_id !== other.id) throw new Error("the second sign-in must see itself as current");
    });

    await ctx.step("the current device, a malformed id, and another user's session are refused", async () => {
      (await ctx.client.as(here).del(`/v1/accounts/me/devices/${hereId}`)).status(400);
      (await ctx.client.as(here).del("/v1/accounts/me/devices/not-a-uuid")).status(400);
      (await ctx.client.as(ctx.P.OWNER).del(`/v1/accounts/me/devices/${other.id}`)).status(404);
    });

    await ctx.step("a PAT has no device: list and sign-out → 403", async () => {
      const minted = await ctx.client.as(here).post("/v1/accounts/tokens", { name: "e2e-devices-pat" });
      minted.status(201);
      const pat = minted.json<any>().secret_key as string;
      (await ctx.client.as(ctx.P.ANON).get("/v1/accounts/me/devices", bearer(pat))).status(403);
      (await ctx.client.as(ctx.P.ANON).del(`/v1/accounts/me/devices/${other.id}`, bearer(pat))).status(403);
    });

    await ctx.step("signing the other device out ends its refresh and its bearer; the caller keeps working", async () => {
      (await ctx.client.as(here).del(`/v1/accounts/me/devices/${other.id}`)).status(200).body().has("$.ok", true);
      (await ctx.client.as(ctx.P.ANON).post("/v1/auth/refresh", { refresh_token: other.refresh })).status(400);
      (await ctx.client.as(ctx.P.ANON).get("/v1/accounts/me", bearer(other.access))).status(401);
      const after = await ctx.client.as(here).get("/v1/accounts/me/devices");
      after.status(200);
      const ids = (after.json<any>().devices as Array<{ session_id: string }>).map((d) => d.session_id);
      if (ids.join() !== hereId) throw new Error(`expected only the current device, got ${ids.join()}`);
      (await ctx.client.as(here).del(`/v1/accounts/me/devices/${other.id}`)).status(404);
    });

    await ctx.step("ANON → 401", async () => {
      (await ctx.client.as(ctx.P.ANON).get("/v1/accounts/me/devices")).status(401);
    });
  },
);
