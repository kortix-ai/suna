/**
 * Helpers for the chat-channel flows (Slack, Teams): a direct database
 * connection for seeding what the local profile cannot reach (Slack's
 * auth.test, Microsoft's token endpoint), and Slack's request signature.
 */
import { createHmac } from "node:crypto";
import { Client as PgClient } from "pg";
import type { FlowContext } from "../core/types";

export async function withDb<T>(ctx: FlowContext, run: (db: PgClient) => Promise<T>): Promise<T> {
  const db = new PgClient({ connectionString: ctx.env.databaseUrl! });
  await db.connect();
  try {
    return await run(db);
  } finally {
    await db.end().catch(() => {});
  }
}

/** Slack's v0 request signature over a raw body, with the given signing secret. */
export function slackSigned(secret: string, body: string, contentType: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return {
    raw: true as const,
    headers: { "content-type": contentType, "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
  };
}
