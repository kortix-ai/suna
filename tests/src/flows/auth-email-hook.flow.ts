/**
 * Supabase Auth send-email hook — `POST /v1/webhooks/auth/send-email`.
 *
 * GoTrue posts every auth email (magic link, signup confirmation, password
 * recovery, email change) to this route instead of sending it itself, so auth
 * mail uses the same provider chain, sender identity and templates as invites.
 * The route is public and gated purely on a Standard Webhooks HMAC signature.
 *
 * Signature is over the RAW body, so the request is sent as a pre-serialized
 * string: re-serializing would change the bytes and invalidate the HMAC.
 */
import { createHmac } from "node:crypto";

import { flow } from "../core/flow";

const ROUTE = "/v1/webhooks/auth/send-email";

function hookSecret(): string {
  return process.env.KE2E_AUTH_EMAIL_HOOK_SECRET?.trim() ?? "";
}

/** Standard Webhooks signature: base64(HMAC-SHA256(`{id}.{ts}.{body}`)). */
function signBody(rawBody: string, id: string, timestamp: string, secret: string): string {
  const key = Buffer.from(secret.replace(/^v\d+,/, "").replace(/^whsec_/, ""), "base64");
  const mac = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest("base64");
  return `v1,${mac}`;
}

function magicLinkPayload(recipient: string): string {
  return JSON.stringify({
    user: { email: recipient },
    email_data: {
      token: "123456",
      token_hash: "ke2e-token-hash",
      redirect_to: "http://127.0.0.1:3000/dashboard",
      email_action_type: "magiclink",
      site_url: "http://127.0.0.1:3000",
    },
  });
}

flow(
  "AUTH-2",
  { domain: "auth", routes: [`POST ${ROUTE}`] },
  async (ctx) => {
    const secret = hookSecret();

    await ctx.step("unsigned request → 401 (never 200)", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post(ROUTE, magicLinkPayload("nobody@example.test"), {
        headers: { "content-type": "application/json" },
      });
      // 503 when the deployment has no hook secret configured at all; the
      // contract that matters is that an unsigned body is never accepted.
      r.status([401, 503]);
    });

    await ctx.step("valid signature over a tampered body → 401", async () => {
      if (!secret) return;
      const signed = magicLinkPayload("victim@example.test");
      const id = "ke2e-tamper";
      const timestamp = String(Math.floor(Date.now() / 1000));
      const r = await ctx.client.as(ctx.P.ANON).post(ROUTE, `${signed} `, {
        headers: {
          "content-type": "application/json",
          "webhook-id": id,
          "webhook-timestamp": timestamp,
          "webhook-signature": signBody(signed, id, timestamp, secret),
        },
      });
      r.status(401);
    });

    // 200 is only returned AFTER the send resolves — the route answers 500 on a
    // provider failure and 503 when nothing is configured — so a 200 here means
    // the mail actually went out through the configured provider.
    await ctx.step("signed magic-link payload → 200 and the email is sent", async () => {
      if (!secret) return;
      const recipient = `ke2e-auth-hook-${Date.now()}@example.test`;
      const rawBody = magicLinkPayload(recipient);
      const id = `ke2e-${Date.now()}`;
      const timestamp = String(Math.floor(Date.now() / 1000));
      const r = await ctx.client.as(ctx.P.ANON).post(ROUTE, rawBody, {
        headers: {
          "content-type": "application/json",
          "webhook-id": id,
          "webhook-timestamp": timestamp,
          "webhook-signature": signBody(rawBody, id, timestamp, secret),
        },
      });
      r.status(200);
    });

    await ctx.step("unsupported email_action_type → 400", async () => {
      if (!secret) return;
      const rawBody = JSON.stringify({
        user: { email: "user@example.test" },
        email_data: { email_action_type: "telepathy", token_hash: "x" },
      });
      const id = `ke2e-bad-${Date.now()}`;
      const timestamp = String(Math.floor(Date.now() / 1000));
      const r = await ctx.client.as(ctx.P.ANON).post(ROUTE, rawBody, {
        headers: {
          "content-type": "application/json",
          "webhook-id": id,
          "webhook-timestamp": timestamp,
          "webhook-signature": signBody(rawBody, id, timestamp, secret),
        },
      });
      r.status(400);
    });
  },
);
