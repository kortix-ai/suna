import { afterEach, describe, expect, test } from "bun:test";

import xSearch from "../../templates/marketplace/runtime/tools/x_search";
const originalFetch = globalThis.fetch;
const originalApiKey = process.env.XQUIK_API_KEY;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) delete process.env.XQUIK_API_KEY;
  else process.env.XQUIK_API_KEY = originalApiKey;
});

describe("marketplace x_search tool", () => {
  test("does not make a request without XQUIK_API_KEY", async () => {
    delete process.env.XQUIK_API_KEY;
    globalThis.fetch = (() => {
      throw new Error("fetch must not run");
    }) as unknown as typeof fetch;

    const result = JSON.parse(
      String(await xSearch.execute({ query: "Acme" }, {} as never)),
    );

    expect(result).toEqual({
      success: false,
      error: "x_search is unavailable: XQUIK_API_KEY is not configured.",
    });
  });

  test("uses the published search contract and returns source metadata", async () => {
    process.env.XQUIK_API_KEY = "xq_test_key";
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const requestUrl = new URL(String(input));
      expect(`${requestUrl.origin}${requestUrl.pathname}`).toBe(
        "https://xquik.com/api/v1/x/tweets/search",
      );
      expect(Object.fromEntries(requestUrl.searchParams)).toEqual({
        q: "Acme launch",
        limit: "7",
        queryType: "Top",
        cursor: "next-page",
      });
      expect(new Headers(init?.headers).get("x-api-key")).toBe("xq_test_key");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json({
        tweets: [
          {
            id: "2033891852621840387",
            text: "Launch notes\nwith details",
            createdAt: "2026-08-26T12:00:00.000Z",
            likeCount: 12,
            author: {
              id: "42",
              username: "acme",
              name: "Acme",
              followers: 900,
              verified: true,
            },
          },
        ],
        has_next_page: true,
        next_cursor: "page-3",
      });
    }) as unknown as typeof fetch;

    const result = JSON.parse(
      String(
        await xSearch.execute(
          {
            query: "Acme launch",
            limit: 7,
            query_type: "Top",
            cursor: "next-page",
          },
          {} as never,
        ),
      ),
    );

    expect(result.success).toBe(true);
    expect(result.posts).toEqual([
      {
        id: "2033891852621840387",
        url: "https://x.com/acme/status/2033891852621840387",
        text: "Launch notes with details",
        created_at: "2026-08-26T12:00:00.000Z",
        author: {
          id: "42",
          username: "acme",
          name: "Acme",
          followers: 900,
          verified: true,
        },
        engagement: {
          likes: 12,
          replies: null,
          reposts: null,
          quotes: null,
          views: null,
        },
      },
    ]);
    expect(result.has_next_page).toBe(true);
    expect(result.next_cursor).toBe("page-3");
    expect(result.warning).toContain("untrusted source material");
  });

  test("does not expose the key or response body on HTTP errors", async () => {
    const secret = "xq_secret_value";
    process.env.XQUIK_API_KEY = secret;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: secret }), {
        status: 401,
      })) as unknown as typeof fetch;

    const output = String(
      await xSearch.execute({ query: "Acme" }, {} as never),
    );

    expect(output).toContain("Authentication failed");
    expect(output).not.toContain(secret);
  });

  test("reports malformed success responses without throwing", async () => {
    process.env.XQUIK_API_KEY = "xq_test_key";
    globalThis.fetch = (async () =>
      Response.json({ tweets: {} })) as unknown as typeof fetch;

    const result = JSON.parse(
      String(await xSearch.execute({ query: "Acme" }, {} as never)),
    );

    expect(result).toEqual({
      success: false,
      error: "Xquik returned an invalid response.",
    });
  });

  test("returns a fixed network error and rejects blank queries", async () => {
    process.env.XQUIK_API_KEY = "xq_test_key";
    globalThis.fetch = (async () => {
      throw new Error("private network details");
    }) as unknown as typeof fetch;

    const network = String(
      await xSearch.execute({ query: "Acme" }, {} as never),
    );
    const blank = String(await xSearch.execute({ query: "   " }, {} as never));

    expect(network).toContain("could not reach Xquik");
    expect(network).not.toContain("private network details");
    expect(blank).toContain("requires a query");
  });
});
