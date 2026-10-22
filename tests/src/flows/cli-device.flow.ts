/**
 * Callback-free CLI login — /v1/cli/device/* (apps/api/src/cli/device-routes.ts,
 * device-grants.ts). The CLI starts a grant, the person approves its user code
 * in a signed-in browser (`approveCliDevice` in @kortix/sdk), and the CLI polls
 * for a personal access token. Maps to spec AUTH-8.
 *
 * No step waits on the 5 s poll interval: every grant is polled at most twice,
 * and the approved grant is decided before its first poll.
 */
import { flow } from "../core/flow";

interface Grant {
  device_code: string;
  user_code: string;
  expires_in: number;
  interval: number;
  verification_uri: string;
}

flow(
  "AUTH-8",
  {
    domain: "auth",
    routes: ["POST /v1/cli/device/start", "POST /v1/cli/device/poll", "POST /v1/cli/device/decide", "GET /v1/accounts/me", "DELETE /v1/accounts/tokens/:tokenId"],
  },
  async (ctx) => {
    const anon = ctx.client.as(ctx.P.ANON);
    const owner = ctx.client.as(ctx.P.OWNER);
    const start = async (): Promise<Grant> => {
      const r = await anon.post("/v1/cli/device/start", {});
      r.status(200).body().exists("$.device_code").exists("$.user_code");
      if (r.header("cache-control") !== "no-store") throw new Error(`start Cache-Control: ${r.header("cache-control")}`);
      return r.json<Grant>();
    };
    const poll = (deviceCode: string) => anon.post("/v1/cli/device/poll", { device_code: deviceCode });
    const decide = (userCode: string, approve: boolean, as = owner) =>
      as.post("/v1/cli/device/decide", { user_code: userCode, approve });

    let pending: Grant;
    let approved: Grant;
    let denied: Grant;
    let cliToken = "";
    let cliTokenId = "";

    await ctx.step("start (ANON) → 200: a 64-hex device code, a separate user code, 600 s lifetime, 5 s interval, the /cli/authorize page", async () => {
      pending = await start();
      if (!/^[a-f0-9]{64}$/.test(pending.device_code)) throw new Error("device_code is not 64 hex characters");
      if (pending.user_code === pending.device_code) throw new Error("user_code equals device_code");
      if (pending.expires_in !== 600 || pending.interval !== 5) throw new Error(`expires_in=${pending.expires_in} interval=${pending.interval}`);
      if (!pending.verification_uri.endsWith("/cli/authorize")) throw new Error(`verification_uri=${pending.verification_uri}`);
    });

    await ctx.step("poll before approval → authorization_pending; an immediate second poll → slow_down", async () => {
      (await poll(pending.device_code)).status(200).body().has("$.error", "authorization_pending");
      (await poll(pending.device_code)).status(200).body().has("$.error", "slow_down");
    });

    await ctx.step("poll with a malformed device code → 400; with an unknown well-formed one → invalid_grant", async () => {
      (await poll(pending.user_code)).status(400);
      (await poll("0".repeat(64))).status(200).body().has("$.error", "invalid_grant");
    });

    await ctx.step("decide: ANON → 401, a PAT → 403 (browser session only), an unknown user code → 404", async () => {
      (await decide(pending.user_code, true, anon)).status(401);
      (await decide(pending.user_code, true, ctx.client.as(ctx.P.PAT_ACCT))).status(403);
      (await decide("0123456789ABCDEF", true)).status(404);
    });

    await ctx.step("OWNER approves a fresh grant → 200 {ok:true}; deciding it again → 404", async () => {
      approved = await start();
      (await decide(approved.user_code, true)).status(200).body().has("$.ok", true);
      (await decide(approved.user_code, false)).status(404);
    });

    await ctx.step("the CLI's first poll after approval → a token; the token authenticates as OWNER; a second poll → invalid_grant", async () => {
      const r = await poll(approved.device_code);
      r.status(200).body().exists("$.token");
      cliToken = r.json<{ token: string }>().token;
      const me = await ctx.client.withBearer(cliToken, "cli-device-token").get("/v1/accounts/me");
      me.status(200).body().has("$.user_id", ctx.P.OWNER.userId).exists("$.token_context.token_id");
      cliTokenId = me.json<{ token_context: { token_id: string } }>().token_context.token_id;
      (await poll(approved.device_code)).status(200).body().has("$.error", "invalid_grant");
    });

    await ctx.step("OWNER denies a grant → its poll → access_denied, and no token", async () => {
      denied = await start();
      (await decide(denied.user_code, false)).status(200).body().has("$.ok", true);
      const r = await poll(denied.device_code);
      r.status(200).body().has("$.error", "access_denied");
      if (r.text().includes('"token"')) throw new Error("a denied grant returned a token");
    });

    await ctx.step("cleanup: OWNER revokes the CLI token → it no longer authenticates", async () => {
      if (!cliTokenId) return;
      (await owner.del(`/v1/accounts/tokens/${cliTokenId}`)).status(200);
      (await ctx.client.withBearer(cliToken, "cli-device-token").get("/v1/accounts/me")).status(401);
    });
  },
);
