import { afterEach, expect, test } from "bun:test";
import { Type } from "typebox";
import { startWorker } from "./worker.ts";
import type { PermissionConfig } from "./permission-policy.ts";

const globals = globalThis as Record<string, unknown>;
const previous = {
  compiled: globals.__KORTIX_COMPILED__,
  factory: globals.__KORTIX_PI_AGENT__,
  agent: process.env.KORTIX_AGENT,
};
const workers: Awaited<ReturnType<typeof startWorker>>[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
  for (const worker of workers.splice(0)) {
    worker.server.closeAllConnections();
    await worker.close();
  }
  for (const server of servers.splice(0)) server.stop(true);
  globals.__KORTIX_COMPILED__ = previous.compiled;
  globals.__KORTIX_PI_AGENT__ = previous.factory;
  if (previous.agent === undefined) delete process.env.KORTIX_AGENT;
  else process.env.KORTIX_AGENT = previous.agent;
});

async function setup(
  permission?: PermissionConfig,
  steps?: number,
  custom = false,
) {
  const requests: {
    messages: { role: string; content: string }[];
    tools?: { function: { name: string } }[];
  }[] = [];
  const log: any[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/log")) {
        if (request.method === "GET") return Response.json(log);
        const item = await request.json();
        if (
          !log.some((entry) => entry._kortixAppendId === item._kortixAppendId)
        )
          log.push(item);
        return new Response(null, { status: 204 });
      }
      if (!path.endsWith("/chat/completions"))
        return new Response(null, { status: 204 });
      const body = await request.json();
      requests.push(body);
      const frames = [
        {
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "Done." },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ];
      return new Response(
        frames
          .map(
            (frame) =>
              `data: ${JSON.stringify({ id: "guidance", model: body.model, ...frame })}\n\n`,
          )
          .join("") + "data: [DONE]\n\n",
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    },
  });
  servers.push(server);
  process.env.KORTIX_AGENT = "reader";
  globals.__KORTIX_COMPILED__ = {
    manifest: { default_agent: "reader" },
    agentConfig: { agent: { reader: { permission, steps } } },
  };
  globals.__KORTIX_PI_AGENT__ = custom
    ? () => ({
        tools: [
          {
            name: "custom_probe",
            label: "Custom probe",
            description: "Inspect custom state.",
            parameters: Type.Object({}),
            execute: async () => ({
              content: [{ type: "text", text: "custom" }],
            }),
          },
        ],
      })
    : undefined;
  const compiled = "Review carefully. You have four tools and no skill loader.";
  const worker = await startWorker({
    port: 0,
    envUrl: "http://127.0.0.1:1",
    envUrlExplicit: true,
    envCwd: "/workspace",
    systemPrompt: compiled,
    modelMode: "real",
    providerId: "openrouter",
    modelId: "openai/gpt-4.1",
    gatewayUrl: server.url.toString() + "v1",
    apiKey: "fixture-token",
    kortixToken: "runtime-token",
    storeUrl: server.url.toString() + "log",
    apiUrl: server.url.toString() + "v1",
    projectId: "guidance-project",
    sessionId: "tool-guidance",
  });
  workers.push(worker);
  const call = (path: string, body?: unknown, method = "POST") =>
    fetch(`http://127.0.0.1:${worker.port}${path}`, {
      headers: {
        authorization: "Bearer runtime-token",
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { method, body: JSON.stringify(body) }),
    });
  const [session] = (await (await call("/session")).json()) as { id: string }[];
  const prompt = async (options: Record<string, unknown> = {}) => {
    const response = await call(`/session/${session!.id}/message`, {
      parts: [{ type: "text", text: "Describe available tools." }],
      ...options,
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as any).info.error).toBeUndefined();
    const request = requests.at(-1)!;
    const text = request.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n");
    const names = (request.tools ?? []).map((tool) => tool.function.name);
    expect(text.split("## Current runtime capabilities")).toHaveLength(2);
    expect(text).toContain(
      `Registered tools: ${names.length ? names.join(", ") : "none"}.`,
    );
    expect(text.startsWith(compiled)).toBe(true);
    return { text, names };
  };
  return { worker, prompt, call, session: session!.id };
}

test("provider guidance includes current built-ins after an older compiled prompt", async () => {
  const { prompt } = await setup();
  const { text, names } = await prompt();
  expect(names).toContain("bash");
  expect(text).toContain(
    "Use question to collect answers through the interactive question UI.",
  );
  expect(text).toContain(
    "Use connector_search to find authorized project tools",
  );
  expect(text).toContain("Keep the agent-specific restrictions on tool use.");
});

test("connector-only reader guidance does not advertise denied workspace and UI tools", async () => {
  const { prompt } = await setup({
    "*": "deny",
    connector_search: "allow",
    connector_describe: "allow",
    connector_call: "allow",
  });
  const { text, names } = await prompt();
  expect(names).toEqual([
    "connector_search",
    "connector_describe",
    "connector_call",
  ]);
  expect(text).not.toContain("Use question");
  expect(text).not.toContain("Use skill");
  expect(text).toContain("Do not call tools that are absent from this list.");
});

test("session permission changes and reset refresh guidance without changing the compiled prompt", async () => {
  const { worker, prompt, call, session } = await setup();
  const before = worker.agent.state.systemPrompt;
  const narrowed = await prompt({
    tools: { "*": false, read: true },
    system: "Count project files.",
  });
  expect(narrowed.text).toContain("Count project files.");
  const restricted = await prompt();
  expect(restricted.names).toEqual(["read"]);
  expect(restricted.text).not.toContain("Count project files.");
  expect(
    (await call(`/session/${session}`, { permission: [] }, "PATCH")).status,
  ).toBe(200);
  expect((await prompt()).names).toContain("bash");
  expect(worker.agent.state.systemPrompt).toBe(before);
});

test("ask permissions and path-specific denies keep tools discoverable", async () => {
  const { prompt } = await setup({
    "*": "deny",
    bash: "ask",
    read: { "*": "deny", "/workspace/docs/*": "allow" },
  });
  const { text, names } = await prompt();
  expect(names).toEqual(["bash", "read"]);
  expect(text).toContain(
    "Call tools normally; the runtime requests permission",
  );
});

test.each([
  ["denied", "deny", undefined],
  ["step limit", "allow", 1],
] as const)(
  "%s advertises no tools at the provider boundary",
  async (_name, permission, steps) => {
    const { prompt } = await setup(permission, steps);
    const { text, names } = await prompt();
    expect(names).toEqual([]);
    expect(text).not.toContain("Use question");
    expect(text).not.toContain("Use connector_search");
    expect(text).toContain("Explain the limitation");
  },
);

test("custom tools appear only when enabled for the selected agent", async () => {
  const { prompt } = await setup(
    { "*": "deny", custom_probe: "allow" },
    undefined,
    true,
  );
  expect((await prompt()).names).toEqual(["custom_probe"]);
  expect((await prompt({ tools: { custom_probe: false } })).names).toEqual([]);
});
