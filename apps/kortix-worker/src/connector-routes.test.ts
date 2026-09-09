import { afterEach, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { startWorker } from "./worker";
import type { PermissionConfig } from "./permission-policy";

const globals = globalThis as Record<string, unknown>;
const previous = globals.__KORTIX_COMPILED__;
const workers: Awaited<ReturnType<typeof startWorker>>[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
const releases: (() => void)[] = [];

afterEach(async () => {
  globals.__KORTIX_COMPILED__ = previous;
  for (const release of releases.splice(0)) release();
  for (const worker of workers.splice(0)) {
    worker.agent.abort();
    worker.server.closeAllConnections();
    await worker.close();
  }
  for (const server of servers.splice(0)) server.stop(true);
});

async function until(predicate: () => boolean | Promise<boolean>) {
  const end = Date.now() + 2000;
  while (!(await predicate())) {
    if (Date.now() > end)
      throw new Error("Connector condition did not complete");
    await Bun.sleep(5);
  }
}

async function setup(permission?: PermissionConfig, slow = false) {
  const log: unknown[] = [];
  const calls: unknown[] = [];
  const paths: string[] = [];
  const release = Promise.withResolvers<void>();
  releases.push(release.resolve);
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path.startsWith("/log")) {
        if (request.method === "GET") return Response.json(log);
        const item = await request.json();
        if (
          !log.some(
            (entry: any) =>
              entry._kortixAppendId === (item as any)._kortixAppendId,
          )
        )
          log.push(item);
        return new Response(null, { status: 204 });
      }
      if (path === "/v1/connectors/projects/project-one/catalog")
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
                  description: "Read fixture",
                  risk: "read",
                  inputSchema: { type: "object" },
                },
              ],
            },
          ],
        });
      if (path === "/v1/connectors/projects/project-one/call") {
        expect(request.headers.get("authorization")).toBe(
          "Bearer worker-token",
        );
        calls.push(await request.json());
        if (slow) await release.promise;
        return Response.json({
          ok: true,
          data: { content: [{ type: "text", text: "cobalt fixture" }] },
        });
      }
      return new Response(null, { status: 204 });
    },
  });
  servers.push(server);
  globals.__KORTIX_COMPILED__ = {
    manifest: { default_agent: "build" },
    agentConfig: { agent: { build: { permission } } },
  };
  const config = {
    port: 0,
    envUrl: server.url.toString() + "environment",
    envCwd: "/workspace",
    systemPrompt: "Use the project connector.",
    modelMode: "faux" as const,
    kortixToken: "worker-token",
    sessionId: "connector-session",
    projectId: "project-one",
    apiUrl: server.url.toString() + "v1",
    storeUrl: server.url.toString() + "log",
  };
  const worker = await startWorker(config);
  workers.push(worker);
  const call = (path: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${worker.port}${path}`, {
      headers: {
        authorization: "Bearer worker-token",
        "content-type": "application/json",
      },
      ...(body === undefined
        ? {}
        : { method: "POST", body: JSON.stringify(body) }),
    });
  const [session] = (await (await call("/session")).json()) as { id: string }[];
  return {
    worker,
    config,
    call,
    session: session!,
    calls,
    paths,
    log,
    release,
  };
}

test("worker exposes connector discovery and execution without waking the environment, and restores the transcript", async () => {
  const { worker, config, call, session, calls, paths } = await setup();
  expect(worker.agent.state.tools.map((tool) => tool.name)).toContain(
    "connector_call",
  );
  expect(worker.agent.state.systemPrompt).toContain("Use connector_search");
  expect(paths.some((path) => path.includes("/connectors/"))).toBe(false);
  worker.faux!.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("connector_search", { query: "fixture" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      [fauxToolCall("connector_describe", { tool: "fixture.read" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      [
        fauxToolCall("connector_call", {
          tool: "fixture.read",
          args: { name: "cobalt" },
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("The fixture is cobalt."),
  ]);
  expect(
    (
      await call(`/session/${session.id}/message`, {
        parts: [{ type: "text", text: "Read the fixture." }],
      })
    ).status,
  ).toBe(200);
  expect(calls).toEqual([
    { connector: "fixture", action: "read", args: { name: "cobalt" } },
  ]);
  const messages = (await (
    await call(`/session/${session.id}/message`)
  ).json()) as any[];
  const parts = messages
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "tool");
  expect(parts.map((part) => [part.tool, part.state.status])).toEqual([
    ["connector_search", "completed"],
    ["connector_describe", "completed"],
    ["connector_call", "completed"],
  ]);
  expect(parts[2].state.output).toContain("cobalt fixture");
  await until(() => !worker.agent.state.isStreaming);
  worker.server.closeAllConnections();
  await worker.close();
  workers.splice(workers.indexOf(worker), 1);
  const restored = await startWorker(config);
  workers.push(restored);
  const history = await fetch(
    `http://127.0.0.1:${restored.port}/session/${session.id}/message`,
    { headers: { authorization: "Bearer worker-token" } },
  );
  expect(await history.json()).toEqual(messages);
  expect(paths.some((path) => path.includes("/environment"))).toBe(false);
});

test("connector action permissions expose the action pattern and Stop dismisses an unanswered request", async () => {
  const { worker, call, session, calls } = await setup({
    connector_call: { "fixture.*": "ask" },
  });
  worker.faux!.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("connector_call", { tool: "fixture.read", args: {} })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("done"),
  ]);
  expect(
    (
      await call(`/session/${session.id}/prompt_async`, {
        parts: [{ type: "text", text: "Read fixture." }],
      })
    ).status,
  ).toBe(204);
  let pending: any[] = [];
  await until(async () => {
    pending = (await (await call("/permission")).json()) as any[];
    return pending.length > 0;
  });
  expect(pending[0]).toMatchObject({
    permission: "connector_call",
    patterns: ["fixture.read"],
    always: ["fixture.read"],
  });
  expect(calls).toEqual([]);
  expect((await call(`/session/${session.id}/abort`, {})).status).toBe(200);
  await until(() => !worker.agent.state.isStreaming);
  expect(await (await call("/permission")).json()).toEqual([]);
  expect(calls).toEqual([]);
});

test("a denied action cannot execute through an otherwise visible connector tool", async () => {
  const { worker, call, session, calls } = await setup({
    connector_call: { "fixture.read": "deny" },
  });
  worker.faux!.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("connector_call", { tool: "fixture.read", args: {} })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("denied"),
  ]);
  expect(
    (
      await call(`/session/${session.id}/message`, {
        parts: [{ type: "text", text: "Read fixture." }],
      })
    ).status,
  ).toBe(200);
  expect(calls).toEqual([]);
  const messages = (await (
    await call(`/session/${session.id}/message`)
  ).json()) as any[];
  const part = messages
    .flatMap((message) => message.parts)
    .find((part) => part.tool === "connector_call");
  expect(part.state.status).toBe("error");
  expect(part.state.error).toContain("permission denied");
});

test("Stop during a connector request settles the turn and allows the next prompt without replaying the action", async () => {
  const { worker, call, session, calls, release } = await setup(
    undefined,
    true,
  );
  worker.faux!.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("connector_call", { tool: "fixture.read", args: {} })],
      { stopReason: "toolUse" },
    ),
  ]);
  expect(
    (
      await call(`/session/${session.id}/prompt_async`, {
        parts: [{ type: "text", text: "Read fixture." }],
      })
    ).status,
  ).toBe(204);
  await until(() => calls.length === 1);
  expect((await call(`/session/${session.id}/abort`, {})).status).toBe(200);
  await until(() => !worker.agent.state.isStreaming);
  worker.faux!.setResponses([fauxAssistantMessage("NEXT_PROMPT")]);
  const next = await call(`/session/${session.id}/message`, {
    parts: [{ type: "text", text: "Reply NEXT_PROMPT without tools." }],
  });
  expect(next.status).toBe(200);
  expect(await next.text()).toContain("NEXT_PROMPT");
  expect(calls).toHaveLength(1);
  release.resolve();
});
