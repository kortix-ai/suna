import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  gatewayRequestLogs,
  sandboxComputeSessions,
  usageEvents,
} from "@kortix/db";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

let whereClauses: Array<{ table: unknown; where: SQL }> = [];
let synchronousUsageAggregate = {
  llmCost: 0.4,
  requestCount: 1,
  inputTokens: 8,
  outputTokens: 2,
  cachedTokens: 0,
  cacheWriteTokens: 0,
};

mock.module("./db", () => ({
  hasDatabase: true,
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: async (where: SQL) => {
          whereClauses.push({ table, where });
          if (table === usageEvents) return [synchronousUsageAggregate];
          if (table === gatewayRequestLogs) return [];
          if (table === sandboxComputeSessions) return [{ computeCost: 0.1 }];
          return [];
        },
      }),
    }),
  },
}));

const {
  getSessionResourceUsage,
  getSessionResourceUsageIncludingCurrentRequest,
} = await import("./session-costs");

const current = {
  requestId: "request-current",
  cost: 0.6,
  inputTokens: 70,
  outputTokens: 20,
  cachedTokens: 5,
  cacheWriteTokens: 5,
};

beforeEach(() => {
  whereClauses = [];
});

describe("task liveness usage includes the synchronous current gateway request", () => {
  test("admission, sweep, and no-progress history sees prior usage when its gateway trace is missing", async () => {
    const usage = await getSessionResourceUsage({
      accountId: "00000000-0000-4000-a000-000000000001",
      sessionId: "worker-session",
    });

    expect(usage).toEqual({
      total_cost: 0.5,
      input_tokens: 8,
      output_tokens: 2,
      cached_tokens: 0,
      cache_write_tokens: 0,
      total_tokens: 10,
      request_count: 1,
    });
    expect(whereClauses.some(({ table }) => table === usageEvents)).toBe(true);
    expect(whereClauses.some(({ table }) => table === gatewayRequestLogs)).toBe(
      false,
    );
  });

  test("a prior synchronous usage row plus the current request exhausts the bound when both traces are missing", async () => {
    const usage = await getSessionResourceUsageIncludingCurrentRequest({
      accountId: "00000000-0000-4000-a000-000000000001",
      sessionId: "worker-session",
      current,
    });

    expect(usage).toEqual({
      total_cost: 1.1,
      input_tokens: 78,
      output_tokens: 22,
      cached_tokens: 5,
      cache_write_tokens: 5,
      total_tokens: 110,
      request_count: 2,
    });
  });

  test("persisted trace and settlement retry cannot double-count the current request", async () => {
    const input = {
      accountId: "00000000-0000-4000-a000-000000000001",
      sessionId: "worker-session",
      current,
    };
    const first = await getSessionResourceUsageIncludingCurrentRequest(input);
    const retry = await getSessionResourceUsageIncludingCurrentRequest(input);

    expect(retry).toEqual(first);
    const usageQueries = whereClauses.filter(
      ({ table }) => table === usageEvents,
    );
    expect(usageQueries).toHaveLength(2);
    expect(whereClauses.some(({ table }) => table === gatewayRequestLogs)).toBe(
      false,
    );
    for (const query of usageQueries) {
      const rendered = new PgDialect().sqlToQuery(query.where);
      expect(rendered.sql).toContain('"idempotency_key" is distinct from');
      expect(rendered.params).toContain(`llm-gateway:${current.requestId}`);
      expect(rendered.params).toContain("/v1/llm/chat/completions");
    }
  });
});
