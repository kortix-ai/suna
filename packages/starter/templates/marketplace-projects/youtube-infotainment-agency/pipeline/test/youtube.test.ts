import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { whoami } from "../src/youtube";

const realFetch = globalThis.fetch;
const env = { ...process.env };
let calls: { url: string; auth?: string | null }[] = [];

/** Stub Google: the token endpoint answers an access token, the channels endpoint answers `items`. */
function mockGoogle(items: unknown[]) {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
    const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
    if (String(url).startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "at-1" });
    if (new URL(String(url)).pathname === "/youtube/v3/channels") return json({ items });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
  Object.assign(process.env, { YT_CLIENT_ID: "cid", YT_CLIENT_SECRET: "csecret", YT_REFRESH_TOKEN: "rt" });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...env };
});

describe("yt youtube whoami", () => {
  test("names the channel the refresh token publishes to", async () => {
    mockGoogle([{ id: "UC123", snippet: { title: "Example Channel", customUrl: "@example" } }]);
    expect(await whoami()).toEqual({ id: "UC123", title: "Example Channel", handle: "@example" });
    const channels = calls.find((c) => c.url.includes("/youtube/v3/channels"))!;
    expect(new URL(channels.url).searchParams.get("mine")).toBe("true");
    expect(channels.auth).toBe("Bearer at-1");
  });

  test("an account without a channel is an error, not an empty result", async () => {
    mockGoogle([]);
    await expect(whoami()).rejects.toThrow(/no YouTube channel/);
  });

  test("missing credentials fail before any request", async () => {
    delete process.env.YT_REFRESH_TOKEN;
    mockGoogle([]);
    await expect(whoami()).rejects.toThrow(/YT_REFRESH_TOKEN/);
    expect(calls).toHaveLength(0);
  });
});
