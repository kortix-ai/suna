import { afterEach, expect, test } from "bun:test";
import { createConnectorTools } from "./connector-tools";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function fixture(data?: { value: unknown }) {
  const requests: { path: string; token: string | null; body?: any }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const token = request.headers.get("authorization");
      const body = request.method === "POST" ? await request.json() : undefined;
      requests.push({ path, token, body });
      if (token === "Bearer denied")
        return Response.json(
          { reason: "connector_not_assigned" },
          { status: 403 },
        );
      if (path.endsWith("/catalog"))
        return Response.json({
          connectors: [
            {
              slug: "fixture",
              name: "Fixture",
              provider: "mcp",
              status: "active",
              actions: [
                {
                  path: "read",
                  name: "Read",
                  description: "Read a fixture",
                  risk: "read",
                  inputSchema: {
                    type: "object",
                    properties: { name: { type: "string" } },
                    required: ["name"],
                  },
                },
              ],
            },
          ],
        });
      if (body?.action === "approve")
        return Response.json(
          {
            ok: false,
            status: "pending_approval",
            approval_url: "https://example.test/approve",
            execution_id: "approval-1",
          },
          { status: 202 },
        );
      if (body?.action === "image")
        return Response.json({
          ok: true,
          data: {
            content: [
              { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
              { type: "text", text: "captured" },
            ],
          },
        });
      if (data) return Response.json({ ok: true, data: data.value });
      return Response.json({
        ok: true,
        data: {
          content: [{ type: "text", text: "hello " + body?.args?.name }],
        },
      });
    },
  });
  servers.push(server);
  const create = (token = "worker-token", projectId = "project-one") =>
    createConnectorTools({
      apiUrl: server.url.toString().replace(/\/$/, "") + "/v1",
      token,
      projectId,
    });
  const call = async (name: string, args: unknown, signal?: AbortSignal) => {
    const tool = create().find((t) => t.name === name)!;
    return tool.execute("tool-1", args, signal);
  };
  return { requests, create, call };
}

test("MCP tools are discovered and described through the worker-scoped SDK without startup requests", async () => {
  const { requests, create, call } = fixture();
  const tools = create();
  expect(tools.map((t) => t.name)).toEqual([
    "connector_search",
    "connector_describe",
    "connector_call",
  ]);
  expect(requests).toHaveLength(0);
  const search = await call("connector_search", { query: "read" });
  expect(JSON.stringify(search.content)).toContain("fixture.read");
  const description = await call("connector_describe", {
    tool: "fixture.read",
  });
  expect(JSON.stringify(description.content)).toContain("required");
  expect(requests).toHaveLength(2);
  expect(
    requests.every(
      (r) =>
        r.path === "/v1/connectors/projects/project-one/catalog" &&
        r.token === "Bearer worker-token",
    ),
  ).toBe(true);
});

test("MCP execution preserves content and sends one exact action without retry", async () => {
  const { requests, call } = fixture();
  const result = await call("connector_call", {
    tool: "fixture.read",
    args: { name: "cobalt" },
  });
  expect(result.content).toEqual([{ type: "text", text: "hello cobalt" }]);
  expect(requests).toEqual([
    {
      path: "/v1/connectors/projects/project-one/call",
      token: "Bearer worker-token",
      body: { connector: "fixture", action: "read", args: { name: "cobalt" } },
    },
  ]);
});

test("MCP images remain native images for the durable attachment pipeline", async () => {
  const { call } = fixture();
  const result = await call("connector_call", {
    tool: "fixture.image",
    args: {},
  });
  expect(result.content).toEqual([
    { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
    { type: "text", text: "captured" },
  ]);
});

test("the gateway JSON-RPC envelope becomes native MCP content", async () => {
  const content = [{ type: "text", text: "wire result" }, { type: "image", mimeType: "image/png", data: "aW1hZ2U=" }];
  const { call } = fixture({ value: { jsonrpc: "2.0", id: 1, result: { content } } });
  expect((await call("connector_call", { tool: "fixture.read", args: {} })).content).toEqual(content as any);
});

test("an HTTP-success JSON-RPC error fails the tool", async () => {
  const { call } = fixture({ value: { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid fixture arguments" } } });
  await expect(call("connector_call", { tool: "fixture.read", args: {} })).rejects.toThrow("Invalid fixture arguments");
});

test("approval handoff returns the existing approval link without another request", async () => {
  const { requests, call } = fixture();
  const result = await call("connector_call", {
    tool: "fixture.approve",
    args: {},
  });
  expect(JSON.stringify(result.content)).toContain(
    "https://example.test/approve",
  );
  expect(requests).toHaveLength(1);
});

test("concurrent workers keep tokens and projects isolated", async () => {
  const { requests, create } = fixture();
  const first = create("one", "p1").find((t) => t.name === "connector_call")!;
  const second = create("two", "p2").find((t) => t.name === "connector_call")!;
  await Promise.all([
    first.execute("one", { tool: "fixture.read", args: { name: "one" } }),
    second.execute("two", { tool: "fixture.read", args: { name: "two" } }),
  ]);
  expect(
    requests
      .map((r) => ({ path: r.path, token: r.token }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  ).toEqual([
    { path: "/v1/connectors/projects/p1/call", token: "Bearer one" },
    { path: "/v1/connectors/projects/p2/call", token: "Bearer two" },
  ]);
});

test("a denied connector surfaces the backend reason and is not retried", async () => {
  const { requests, create } = fixture();
  const tool = create("denied").find((t) => t.name === "connector_call")!;
  await expect(
    tool.execute("denied", { tool: "fixture.read", args: {} }),
  ).rejects.toThrow("connector_not_assigned");
  expect(requests).toHaveLength(1);
});

test("Stop before a connector call reaches no transport or environment", async () => {
  const { requests, call } = fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(
    call(
      "connector_call",
      { tool: "fixture.read", args: {} },
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(requests).toHaveLength(0);
});

test("an empty connector result is valid JSON content", async () => {
  const { call } = fixture({ value: undefined });
  expect(
    (await call("connector_call", { tool: "fixture.empty", args: {} })).content,
  ).toEqual([{ type: "text", text: "null" }]);
});

test.each([
  { type: "image", mimeType: "image/svg+xml", data: "PRIVATE_BINARY" },
  { type: "image", mimeType: "image/png", data: 42 },
  { type: "audio", mimeType: "audio/wav", data: "PRIVATE_BINARY" },
  {
    type: "resource",
    resource: { uri: "fixture://binary", blob: "PRIVATE_BINARY" },
  },
  { type: "resource", resource: { uri: "fixture://svg", mimeType: "image/svg+xml", blob: "PRIVATE_BINARY" } },
  { type: "resource", resource: { uri: "fixture://image", mimeType: "image/png", blob: 42 } },
  { type: "resource", resource: { mimeType: "image/png", blob: "PRIVATE_BINARY" } },
  { type: "resource", resource: { uri: "fixture://mixed", mimeType: "image/png", blob: "PRIVATE_BINARY", text: "ambiguous" } },
  { type: "text", text: 42 },
])(
  "unsupported or malformed MCP content is rejected without returning binary text: %j",
  async (block) => {
    const { call } = fixture({ value: { content: [block] } });
    await expect(
      call("connector_call", { tool: "fixture.bad", args: {} }),
    ).rejects.toThrow("Unsupported or malformed MCP content");
  },
);

test.each(["image/png", "image/jpeg", "image/gif", "image/webp"])(
  "embedded %s resources preserve their URI and use native image content",
  async (mimeType) => {
    const resource = { uri: "fixture://capture/image", mimeType, blob: "aW1hZ2U=" };
    const { call } = fixture({ value: { jsonrpc: "2.0", id: 1, result: {
      content: [{ type: "text", text: "capture" }, { type: "resource", resource }],
      structuredContent: { color: "cobalt" },
    } } });
    const result = await call("connector_call", { tool: "fixture.capture", args: {} });
    expect(result.content).toEqual([
      { type: "text", text: "capture" },
      { type: "text", text: JSON.stringify({ type: "resource", resource: { uri: resource.uri, mimeType } }) },
      { type: "image", mimeType, data: resource.blob },
      { type: "text", text: '{"color":"cobalt"}' },
    ]);
    expect(result.content.filter((part) => part.type === "text").map((part) => part.text).join("")).not.toContain(resource.blob);
  },
);

test("MCP text resources, links and structured output remain readable", async () => {
  const content = [
    {
      type: "resource",
      resource: { uri: "fixture://text", text: "resource text" },
    },
    {
      type: "resource_link",
      uri: "https://example.test/resource",
      name: "Resource",
    },
  ];
  const { call } = fixture({
    value: { content, structuredContent: { color: "cobalt" } },
  });
  expect(
    (await call("connector_call", { tool: "fixture.read", args: {} })).content,
  ).toEqual([
    ...content.map((block) => ({
      type: "text" as const,
      text: JSON.stringify(block),
    })),
    { type: "text", text: '{"color":"cobalt"}' },
  ]);
});

test("MCP errors and oversized text fail the tool", async () => {
  const error = fixture({
    value: {
      isError: true,
      content: [{ type: "text", text: "fixture failed" }],
    },
  });
  await expect(
    error.call("connector_call", { tool: "fixture.read", args: {} }),
  ).rejects.toThrow("fixture failed");
  const large = fixture({
    value: { content: [{ type: "text", text: "x".repeat(512 * 1024 + 1) }] },
  });
  await expect(
    large.call("connector_call", { tool: "fixture.read", args: {} }),
  ).rejects.toThrow("512 KiB");
});

test("Stop cancels an in-flight HTTP connector call without a second execution", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    async fetch() {
      requests++;
      started.resolve();
      await release.promise;
      return Response.json({ ok: true, data: "late" });
    },
  });
  servers.push(server);
  const controller = new AbortController();
  const tool = createConnectorTools({
    apiUrl: server.url.toString() + "v1",
    projectId: "project-one",
    token: "worker-token",
  }).find((t) => t.name === "connector_call")!;
  const result = tool
    .execute("slow", { tool: "fixture.slow", args: {} }, controller.signal)
    .then(
      () => "completed",
      () => "aborted",
    );
  try {
    await started.promise;
    controller.abort();
    expect(
      await Promise.race([result, Bun.sleep(200).then(() => "still running")]),
    ).toBe("aborted");
    expect(requests).toBe(1);
  } finally {
    release.resolve();
    await result;
  }
});
