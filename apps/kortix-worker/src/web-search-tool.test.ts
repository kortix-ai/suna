import { afterEach, expect, test } from "bun:test";
import {
  PermissionBroker,
  PermissionDeniedError,
} from "./permission-broker.ts";
import { protectToolsWithPermissions } from "./permission-tools.ts";
import { createWebSearchTool } from "./web-search-tool.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});
function service(handler: (request: Request) => Response | Promise<Response>) {
  const requests: { url: string; headers: Headers; body: any }[] = [];
  const server = Bun.serve({ port: 0, fetch: handler });
  servers.push(server);
  const transport = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    requests.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    return fetch(server.url, init);
  }) as typeof fetch;
  return {
    tool: createWebSearchTool({ fetch: transport, timeoutMs: 250 }),
    requests,
  };
}
const text =
  "Title: Kortix SDK\nURL: https://kortix.com/docs/sdk\nText: Install @kortix/sdk.";
const payload = (content = text) => ({
  jsonrpc: "2.0",
  id: 1,
  result: { content: [{ type: "text", text: content }] },
});

test("websearch preserves the OpenCode request contract and source-card text", async () => {
  const { tool, requests } = service(() => Response.json(payload()));
  const result = await tool.execute("search_1", {
    query: "Kortix SDK",
    numResults: 3,
    type: "fast",
    livecrawl: "preferred",
    contextMaxCharacters: 2000,
  });
  expect(tool.name).toBe("websearch");
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe("https://mcp.exa.ai/mcp");
  expect(requests[0]?.headers.get("authorization")).toBeNull();
  expect(requests[0]?.headers.get("accept")).toBe(
    "application/json, text/event-stream",
  );
  expect(requests[0]?.body).toEqual({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "web_search_exa",
      arguments: {
        query: "Kortix SDK",
        numResults: 3,
        type: "fast",
        livecrawl: "preferred",
        contextMaxCharacters: 2000,
      },
    },
  });
  expect(result.content).toEqual([{ type: "text", text }]);
  expect(result.details).toEqual({ query: "Kortix SDK", provider: "exa" });
});

test("websearch applies defaults and reads split SSE frames before the stream closes", async () => {
  const { tool, requests } = service(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            const data = `: ping\r\n\r\nevent: message\r\ndata: ${JSON.stringify(payload("First source"))}\r\n\r\n`;
            const bytes = new TextEncoder().encode(data);
            for (let n = 0; n < bytes.length; n += 7)
              controller.enqueue(bytes.slice(n, n + 7));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  expect((await tool.execute("search_2", { query: "query" })).content).toEqual([
    { type: "text", text: "First source" },
  ]);
  expect(requests[0]?.body.params.arguments).toEqual({
    query: "query",
    numResults: 8,
    type: "auto",
    livecrawl: "fallback",
    contextMaxCharacters: 10000,
  });
});

for (const [name, response, error] of [
  [
    "HTTP rejection",
    () => new Response("provider-private-detail", { status: 429 }),
    "429",
  ],
  [
    "RPC error",
    () =>
      Response.json({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -1, message: "unavailable" },
      }),
    "search provider",
  ],
  [
    "tool error",
    () =>
      Response.json({
        ...payload(),
        result: {
          isError: true,
          content: [{ type: "text", text: "rate limited" }],
        },
      }),
    "search provider",
  ],
  [
    "wrong response ID",
    () => Response.json({ ...payload(), id: 2 }),
    "response",
  ],
  ["malformed response", () => Response.json({ result: null }), "response"],
  [
    "oversized output",
    () => Response.json(payload("x".repeat(300_000))),
    "limit",
  ],
] as const) {
  test(`websearch rejects ${name}`, async () => {
    const { tool } = service(response);
    await expect(tool.execute("search_3", { query: "query" })).rejects.toThrow(
      error,
    );
  });
}

test("websearch preserves empty results and all text blocks", async () => {
  const empty = service(() =>
    Response.json({ jsonrpc: "2.0", id: 1, result: { content: [] } }),
  );
  expect(
    (await empty.tool.execute("empty", { query: "nothing" })).content,
  ).toEqual([{ type: "text", text: "No search results found." }]);
  const multiple = service(() =>
    Response.json({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [
          { type: "text", text: "One" },
          { type: "text", text: "Two" },
        ],
      },
    }),
  );
  expect(
    (await multiple.tool.execute("multiple", { query: "query" })).content,
  ).toEqual([{ type: "text", text: "One\n\nTwo" }]);
});

test("websearch validates input before sending a request", async () => {
  const { tool, requests } = service(() => Response.json(payload()));
  for (const input of [
    { query: "" },
    { query: "   " },
    { query: "q", numResults: 0 },
    { query: "q", type: "invalid" },
    { query: "q", livecrawl: "invalid" },
    { query: "q", contextMaxCharacters: -1 },
  ]) {
    await expect(tool.execute("invalid", input)).rejects.toThrow();
  }
  expect(requests).toHaveLength(0);
});

test("websearch aborts the provider body and enforces a total deadline", async () => {
  const { tool, requests } = service(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(": waiting\n\n"));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  const controller = new AbortController();
  const execution = tool.execute(
    "cancel",
    { query: "query" },
    controller.signal,
  );
  while (requests.length === 0) await Bun.sleep(1);
  controller.abort();
  await expect(execution).rejects.toThrow();
  await expect(tool.execute("timeout", { query: "query" })).rejects.toThrow(
    /timeout|timed out/i,
  );
  const aborted = new AbortController();
  aborted.abort();
  await expect(
    tool.execute("before", { query: "query" }, aborted.signal),
  ).rejects.toThrow();
  expect(requests).toHaveLength(2);
});

test("websearch applies permission rules to the query before external access", async () => {
  const { tool, requests } = service(() => Response.json(payload()));
  const broker = new PermissionBroker({
    sessionId: "ses_search",
    permission: { websearch: { "*": "allow", "private*": "deny" } },
    publish: () => {},
  });
  const [protectedTool] = protectToolsWithPermissions(
    [tool],
    broker,
    "/workspace",
  );
  await expect(
    protectedTool!.execute("denied", { query: "private query" }),
  ).rejects.toBeInstanceOf(PermissionDeniedError);
  expect(requests).toHaveLength(0);
  expect(
    (await protectedTool!.execute("allowed", { query: "public query" }))
      .content,
  ).toEqual([{ type: "text", text }]);
});

test("websearch releases a successful SSE response reader without waiting for EOF", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify(payload())}\n\n`),
        );
      },
      cancel() {
        cancelled = true;
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  const tool = createWebSearchTool({
    fetch: (async () => response) as unknown as typeof fetch,
  });
  expect((await tool.execute("release", { query: "query" })).content).toEqual([
    { type: "text", text },
  ]);
  expect(cancelled).toBe(true);
});
