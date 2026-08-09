import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { accounts, gatewayRequestLogs, usageEvents } from "@kortix/db";
import { and, eq } from "drizzle-orm";
import { db } from "../shared/db";
import { recordUsageEvent } from "../shared/usage-events";
import {
  getSessionResourceUsage,
  getSessionResourceUsageIncludingCurrentRequest,
} from "../shared/session-costs";

const CONFIRMATION = "I_UNDERSTAND_THIS_DELETES_TEST_DATA";
const enabled = Boolean(
  process.env.TEST_DATABASE_URL &&
  process.env.DATABASE_URL === process.env.TEST_DATABASE_URL &&
  process.env.KORTIX_TEST_DB_CONFIRM === CONFIRMATION &&
  process.env.INTERNAL_KORTIX_ENV !== "prod",
);
const describeWithDb = enabled ? describe : describe.skip;
const ACCOUNT_ID = "00000000-0000-4000-a000-00000000f201";
const SESSION_ID = "task-liveness-usage-ledger-proof";

async function cleanup() {
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT_ID));
}

describeWithDb("task liveness usage ledger — real PostgreSQL", () => {
  beforeEach(async () => {
    await cleanup();
    await db
      .insert(accounts)
      .values({ accountId: ACCOUNT_ID, name: "Liveness usage proof" });
  });
  afterEach(cleanup);

  test("prior trace loss is durable and request retries count once", async () => {
    const prior = {
      accountId: ACCOUNT_ID,
      sessionId: SESSION_ID,
      provider: "anthropic",
      model: "claude-sonnet-4.6",
      route: "/v1/llm/chat/completions",
      idempotencyKey: "llm-gateway:req-prior",
      inputTokens: 8,
      outputTokens: 2,
      costUsd: 0.4,
      metadata: { requestId: "req-prior" },
    };
    const firstId = await recordUsageEvent(prior);
    const retryId = await recordUsageEvent(prior);
    expect(retryId).toBe(firstId);

    const historical = await getSessionResourceUsage({
      accountId: ACCOUNT_ID,
      sessionId: SESSION_ID,
    });
    expect(historical).toMatchObject({
      total_cost: 0.4,
      total_tokens: 10,
      request_count: 1,
    });

    await recordUsageEvent({
      ...prior,
      idempotencyKey: "llm-gateway:req-current",
      inputTokens: 70,
      outputTokens: 20,
      cachedTokens: 5,
      cacheWriteTokens: 5,
      costUsd: 0.6,
      metadata: { requestId: "req-current" },
    });
    const finalized = await getSessionResourceUsageIncludingCurrentRequest({
      accountId: ACCOUNT_ID,
      sessionId: SESSION_ID,
      current: {
        requestId: "req-current",
        cost: 0.6,
        inputTokens: 70,
        outputTokens: 20,
        cachedTokens: 5,
        cacheWriteTokens: 5,
      },
    });
    expect(finalized).toMatchObject({
      total_cost: 1,
      total_tokens: 110,
      request_count: 2,
    });

    const ledgerRows = await db
      .select({ idempotencyKey: usageEvents.idempotencyKey })
      .from(usageEvents)
      .where(
        and(
          eq(usageEvents.accountId, ACCOUNT_ID),
          eq(usageEvents.sessionId, SESSION_ID),
        ),
      );
    expect(ledgerRows).toHaveLength(2);
    const traceRows = await db
      .select({ requestId: gatewayRequestLogs.requestId })
      .from(gatewayRequestLogs)
      .where(
        and(
          eq(gatewayRequestLogs.accountId, ACCOUNT_ID),
          eq(gatewayRequestLogs.sessionId, SESSION_ID),
        ),
      );
    expect(traceRows).toHaveLength(0);
  });
});
