import { beforeEach, describe, expect, mock, test } from "bun:test";

import { configureKortix } from "../../http/config";
import {
  readSessionKnowledge,
  searchSessionKnowledge,
} from "./session-knowledge";

let calls: Array<{ url: string; method: string; body: unknown }> = [];

beforeEach(() => {
  calls = [];
  globalThis.fetch = mock(async (url: unknown, options: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: options.method ?? "GET",
      body: options.body ? JSON.parse(String(options.body)) : undefined,
    });
    return new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
});

configureKortix({
  backendUrl: "http://test.local",
  getToken: async () => "token",
});

describe("session-scoped knowledge", () => {
  test("search takes no agent name and defaults to eight cited results", async () => {
    await searchSessionKnowledge("p1", "s1", { query: "refund policy" });
    expect(calls[0]).toEqual({
      url: "http://test.local/projects/p1/sessions/s1/knowledge/search",
      method: "POST",
      body: { query: "refund policy", limit: 8 },
    });
  });

  test("reads a citation through the authenticated session identity", async () => {
    await readSessionKnowledge("p1", "s1", "citation-1");
    expect(calls[0]).toEqual({
      url: "http://test.local/projects/p1/sessions/s1/knowledge/citation-1",
      method: "GET",
      body: undefined,
    });
  });
});
