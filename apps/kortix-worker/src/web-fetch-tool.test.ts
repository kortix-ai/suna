import { afterEach, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import {
  createWebFetchTool,
  isPublicWebAddress,
  requestPinnedPage,
} from "./web-fetch-tool.ts";
import { PermissionBroker } from "./permission-broker.ts";
import { protectToolsWithPermissions } from "./permission-tools.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});
function fixture(
  handler: (request: Request) => Response | Promise<Response>,
  authorizeRedirect?: (url: string) => void,
) {
  const server = Bun.serve({ port: 0, fetch: handler });
  servers.push(server);
  const requests: string[] = [];
  const tool = createWebFetchTool({
    authorizeRedirect,
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async (url, address, signal) => {
      expect(address).toEqual({ address: "93.184.216.34", family: 4 });
      requests.push(url.href);
      const target = new URL(server.url);
      target.pathname = url.pathname;
      return requestPinnedPage(
        target,
        { address: "127.0.0.1", family: 4 },
        signal,
      );
    },
  });
  return { tool, requests };
}
const html =
  '<html><head><title>Ignored</title></head><body><h1>Page title</h1><p>Hello &amp; welcome.</p><a href="https://example.com/docs">Docs</a><script>privateScript()</script><style>badStyle</style></body></html>';

test("webfetch reads real HTTP and converts HTML to Markdown without executing scripts", async () => {
  const { tool, requests } = fixture(
    () =>
      new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
  );
  const result = await tool.execute("fetch_1", {
    url: "https://example.com/page",
  });
  expect(result.content[0]?.type).toBe("text");
  expect((result.content[0] as { text: string }).text).toContain(
    "# Page title",
  );
  expect(JSON.stringify(result)).toContain("[Docs](https://example.com/docs)");
  expect(JSON.stringify(result)).not.toContain("privateScript");
  expect(JSON.stringify(result)).not.toContain("badStyle");
  expect(result.details).toMatchObject({
    url: "https://example.com/page",
    format: "markdown",
    truncated: false,
  });
  expect(requests).toEqual(["https://example.com/page"]);
});

test("supports plain text and HTML formats and decompresses bounded gzip responses", async () => {
  const { tool } = fixture(
    () =>
      new Response(gzipSync(html), {
        headers: { "content-type": "text/html", "content-encoding": "gzip" },
      }),
  );
  const plain = await tool.execute("fetch_2", {
    url: "https://example.com",
    format: "text",
  });
  expect(JSON.stringify(plain.content)).toContain("Hello & welcome.");
  expect(JSON.stringify(plain.content)).not.toContain("<h1>");
  expect(JSON.stringify(plain.content)).not.toContain("[Docs]");
  const raw = await tool.execute("fetch_3", {
    url: "https://example.com",
    format: "html",
  });
  expect(raw.content).toEqual([{ type: "text", text: html }]);
});

test("follows relative redirects and validates each new target", async () => {
  const { tool, requests } = fixture((request) =>
    new URL(request.url).pathname === "/"
      ? new Response(null, { status: 302, headers: { location: "/docs" } })
      : new Response("final page", {
          headers: { "content-type": "text/plain" },
        }),
  );
  expect(
    (await tool.execute("fetch_4", { url: "https://example.com" })).content,
  ).toEqual([{ type: "text", text: "final page" }]);
  expect(requests).toEqual([
    "https://example.com/",
    "https://example.com/docs",
  ]);
});

test("blocks a redirect into the worker network before a second connection", async () => {
  const { tool, requests } = fixture(
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data" },
      }),
  );
  await expect(
    tool.execute("fetch_5", { url: "https://example.com" }),
  ).rejects.toThrow("public");
  expect(requests).toHaveLength(1);
});

test.each([
  "127.0.0.1",
  "10.0.0.1",
  "169.254.169.254",
  "100.64.1.1",
  "192.0.2.1",
  "198.18.0.1",
  "224.0.0.1",
  "::1",
  "::ffff:7f00:1",
  "fe80::1",
  "fc00::1",
  "2001:db8::1",
  "2002:7f00:1::1",
  "3fff::1",
])("blocks non-public address %s", (ip) => {
  expect(isPublicWebAddress(ip)).toBe(false);
});

test.each([
  "8.8.8.8",
  "1.1.1.1",
  "2606:4700:4700::1111",
  "2001:4860:4860::8888",
])("accepts public address %s", (ip) => {
  expect(isPublicWebAddress(ip)).toBe(true);
});

test("rejects a hostname with both public and private DNS answers", async () => {
  let calls = 0;
  const tool = createWebFetchTool({
    resolve: async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ],
    request: async () => {
      calls++;
      throw new Error("must not connect");
    },
  });
  await expect(
    tool.execute("fetch_6", { url: "https://mixed.example.com" }),
  ).rejects.toThrow("public");
  expect(calls).toBe(0);
});

test.each([
  "file:///etc/passwd",
  "http://127.1",
  "http://2130706433",
  "http://[::ffff:127.0.0.1]",
  "https://user:pass@example.com",
])("rejects unsafe URL %s", async (url) => {
  const { tool, requests } = fixture(() => new Response("must not read"));
  await expect(tool.execute("fetch_7", { url })).rejects.toThrow();
  expect(requests).toEqual([]);
});

test("reports truncation instead of overflowing the durable log", async () => {
  const { tool } = fixture(
    () =>
      new Response("𠮷".repeat(80000), {
        headers: { "content-type": "text/plain" },
      }),
  );
  const result = await tool.execute("fetch_8", { url: "https://example.com" });
  expect(result.details).toMatchObject({ truncated: true });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(150000);
});

test("rejects a decompression bomb before returning tool output", async () => {
  const { tool } = fixture(
    () =>
      new Response(gzipSync("x".repeat(6 * 1024 * 1024)), {
        headers: { "content-type": "text/plain", "content-encoding": "gzip" },
      }),
  );
  await expect(
    tool.execute("fetch_9", { url: "https://example.com" }),
  ).rejects.toThrow("5 MiB");
});

test("Stop interrupts DNS resolution", async () => {
  const tool = createWebFetchTool({ resolve: () => new Promise(() => {}) });
  const controller = new AbortController();
  const pending = tool.execute(
    "fetch_10",
    { url: "https://example.com" },
    controller.signal,
  );
  controller.abort(new Error("Stopped by user"));
  await expect(pending).rejects.toThrow("Stopped by user");
});

test("URL permission denial occurs before any network request", async () => {
  const { tool, requests } = fixture(() => new Response("must not read"));
  const permissions = new PermissionBroker({
    sessionId: "ses_fetch",
    publish: () => {},
    permission: { webfetch: { "https://example.com/*": "deny" } },
  });
  const [protectedTool] = protectToolsWithPermissions(
    [tool],
    permissions,
    "/workspace",
  );
  await expect(
    protectedTool!.execute("fetch_11", { url: "https://example.com/private" }),
  ).rejects.toThrow();
  expect(requests).toEqual([]);
});

test.each(["deny", "ask"] as const)(
  "does not follow a public redirect with %s URL permission",
  async (action) => {
    const permissions = new PermissionBroker({
      sessionId: "ses_redirect",
      publish: () => {},
      permission: { webfetch: { "https://example.com/blocked": action } },
    });
    const { tool, requests } = fixture(
      () =>
        new Response(null, { status: 302, headers: { location: "/blocked" } }),
      (url) => permissions.requirePreauthorized("webfetch", url),
    );
    await expect(
      tool.execute("fetch_redirect", { url: "https://example.com/start" }),
    ).rejects.toThrow(
      action === "deny" ? "permission denied" : "separate webfetch call",
    );
    expect(requests).toEqual(["https://example.com/start"]);
  },
);

test("Stop interrupts a response body that has started streaming", async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { tool } = fixture(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("partial"));
            started();
          },
        }),
        { headers: { "content-type": "text/plain" } },
      ),
  );
  const controller = new AbortController();
  const pending = tool.execute(
    "fetch_stop_body",
    { url: "https://example.com" },
    controller.signal,
  );
  await ready;
  controller.abort(new Error("Stopped by user"));
  await expect(pending).rejects.toThrow("Stopped by user");
});

test("enforces the request deadline while waiting for response headers", async () => {
  const { tool } = fixture(() => new Promise(() => {}));
  const started = Date.now();
  await expect(
    tool.execute("fetch_timeout", { url: "https://example.com", timeout: 1 }),
  ).rejects.toThrow("timed out");
  expect(Date.now() - started).toBeLessThan(2000);
});

test("bounds redirect loops and reports HTTP and binary errors", async () => {
  const { tool, requests } = fixture(
    () => new Response(null, { status: 302, headers: { location: "/" } }),
  );
  await expect(
    tool.execute("fetch_loop", { url: "https://example.com" }),
  ).rejects.toThrow("5 redirects");
  expect(requests).toHaveLength(6);
  const error = fixture(() => new Response("missing", { status: 404 }));
  await expect(
    error.tool.execute("fetch_404", { url: "https://example.com" }),
  ).rejects.toThrow("HTTP 404");
  const binary = fixture(
    () =>
      new Response("binary", {
        headers: { "content-type": "application/octet-stream" },
      }),
  );
  await expect(
    binary.tool.execute("fetch_binary", { url: "https://example.com" }),
  ).rejects.toThrow("binary content");
});
