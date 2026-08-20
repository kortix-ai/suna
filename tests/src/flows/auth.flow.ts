/**
 * Auth-side server endpoints. Three routes today:
 *   - GET  /v1/user-roles  → {isAdmin, role} platform role (spec SYS-3)
 *   - POST /v1/auth/logout → server-side logout (audit + session revoke) (AUTH-1)
 *   - GET  /v1/auth/config → PUBLIC sign-in discovery for @kortix/sdk (AUTH-3)
 *
 * The first two are gated by `supabaseAuth`; the third must not be.
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
import { assert } from "../core/expect";
import { FIXTURE_USER_PASSWORD } from "../fixtures/principals";

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

/**
 * AUTH-3 — public sign-in discovery.
 *
 * The point of this flow is step 4 and 5, not step 1. A 200 with six fields
 * present proves nothing: the question the route exists to answer is "can a
 * third party who only knows the API URL actually sign a user in?". So the
 * flow takes the `url` + `anon_key` it was handed, completes a REAL GoTrue
 * password grant with them, and then spends the resulting token on a real
 * Kortix route. Until SUPABASE_ANON_KEY is set on a deployment the route
 * correctly answers 503 and this flow fails loudly there — which is the
 * intended signal, not a flake.
 *
 * Steps 2 and 6 defend the two structural properties of the route:
 * `Cache-Control: public` is only honest while the body does not vary per
 * caller (step 2), and the route sits on an UNGATED router mounted before
 * `authRouter` — so its gated sibling must still reject ANON (step 6).
 */
flow(
  "AUTH-3",
  { domain: "auth", tags: ["smoke"], routes: ["GET /v1/auth/config"] },
  async (ctx) => {
    let discovered: { url: string; anon_key: string } | null = null;
    let anonBody = "";
    let etag = "";

    await ctx.step("ANON GET /v1/auth/config → 200 discovery payload", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/auth/config");
      r.status(200)
        .body()
        .has("$.provider", "supabase")
        .exists("$.url")
        .exists("$.anon_key")
        .exists("$.methods")
        .exists("$.providers")
        .exists("$.signups_enabled");
      // Regex, not an exact string: a CDN in front of a deployed target may
      // reorder or append directives. The exact header is pinned at the source
      // in apps/api/src/auth/config-route.test.ts.
      r.headerEquals("cache-control", /public.*max-age=60/).headerExists("etag");
      const body = r.json<{ url: string; anon_key: string }>();
      discovered = { url: body.url, anon_key: body.anon_key };
      anonBody = r.text();
      etag = r.header("etag") ?? "";
    });

    await ctx.step("OWNER gets the byte-identical body (never varies per caller)", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).get("/v1/auth/config");
      r.status(200);
      assert({
        kind: "body.identical",
        description: "authenticated body === anonymous body",
        expected: anonBody,
        actual: r.text(),
        pass: r.text() === anonBody,
      });
    });

    await ctx.step("If-None-Match with the served ETag → 304", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .get("/v1/auth/config", { headers: { "If-None-Match": etag } });
      r.status(304);
    });

    let accessToken = "";

    await ctx.step("the discovered url + anon_key complete a real password grant", async () => {
      const user = await ctx.fixtures.user({ label: "AUTH2" });
      const { url, anon_key } = discovered!;
      const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { apikey: anon_key, "content-type": "application/json" },
        body: JSON.stringify({ email: user.email, password: FIXTURE_USER_PASSWORD }),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text();
      assert({
        kind: "gotrue.password_grant",
        description: `POST ${url}/auth/v1/token?grant_type=password → 200`,
        expected: 200,
        actual: `${res.status} ${text.slice(0, 200)}`,
        pass: res.status === 200,
      });
      const token = (JSON.parse(text) as { access_token?: string }).access_token ?? "";
      assert({
        kind: "gotrue.access_token",
        description: "grant returned a non-empty access_token",
        expected: "<non-empty>",
        actual: token ? `<${token.length} chars>` : "<empty>",
        pass: token.length > 0,
      });
      accessToken = token;
    });

    await ctx.step("that token is accepted by GET /v1/accounts", async () => {
      const r = await ctx.client.withBearer(accessToken, "DISCOVERED").get("/v1/accounts");
      r.status(200);
    });

    await ctx.step("ANON POST /v1/auth/logout stays 401 (mount-ordering guard)", async () => {
      // /config answered 200 unauthenticated in step 1. If this sibling also
      // stopped returning 401, the two app.route('/v1/auth', …) registrations
      // in apps/api/src/index.ts were reordered and the gate is gone.
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/auth/logout", {});
      r.status(401);
    });
  },
);
