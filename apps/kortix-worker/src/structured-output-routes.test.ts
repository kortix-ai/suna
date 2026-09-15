import { afterEach, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { isDeepStrictEqual } from "node:util";
import { startWorker } from "./worker.ts";
import { mintWireMessageId } from "./wire-message-id.ts";

const workers: Awaited<ReturnType<typeof startWorker>>[] = [];
const stores: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  for (const worker of workers.splice(0)) {
    worker.server.closeAllConnections();
    await worker.close();
  }
  for (const store of stores.splice(0)) store.stop(true);
});

const schema = {
  type: "object",
  properties: { answer: { type: "integer" } },
  required: ["answer"],
  additionalProperties: false,
};
const format = { type: "json_schema", schema };
const output = (value: unknown) =>
  fauxAssistantMessage(
    [fauxToolCall("StructuredOutput", value as Record<string, unknown>)],
    {
      stopReason: "toolUse",
    },
  );

async function fixture() {
  const items: unknown[] = [];
  const keys = new Map<string, unknown>();
  const store = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.method === "GET") return Response.json(items);
      const item = await request.json();
      const key = request.headers.get("idempotency-key") ?? "";
      if (key && keys.has(key))
        return new Response(null, {
          status: isDeepStrictEqual(keys.get(key), item) ? 204 : 409,
        });
      items.push(item);
      if (key) keys.set(key, item);
      return new Response(null, { status: 204 });
    },
  });
  stores.push(store);
  const config = {
    port: 0,
    envUrl: "http://127.0.0.1:1",
    envUrlExplicit: true,
    envCwd: "/workspace",
    systemPrompt: "Follow the request.",
    modelMode: "faux" as const,
    sessionId: "structured-output",
    kortixToken: "test-runtime-token",
    storeUrl: store.url.toString(),
    turnOwnerLeaseMs: 500,
    turnOwnerHeartbeatMs: 50,
  };
  let worker = await startWorker(config);
  workers.push(worker);
  const request = (
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ) =>
    fetch(`http://127.0.0.1:${worker.port}${path}`, {
      headers: {
        authorization: "Bearer test-runtime-token",
        "content-type": "application/json",
      },
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const session = (await (await request("/session")).json())[0].id;
  return {
    items,
    get worker() {
      return worker;
    },
    send: (body: object) =>
      request(`/session/${session}/message`, {
        parts: [{ type: "text", text: "Return the answer." }],
        ...body,
      }),
    abort: () => request(`/session/${session}/abort`, undefined, "POST"),
    questions: async () =>
      (await request("/question")).json() as Promise<any[]>,
    reply: (id: string) =>
      request(`/question/${id}/reply`, { answers: [["Go"]] }),
    history: async () =>
      (await request(`/session/${session}/message`)).json() as Promise<any[]>,
    async restart(snapshot?: unknown[]) {
      await worker.close();
      if (snapshot) {
        items.splice(0, items.length, ...structuredClone(snapshot));
        keys.clear();
      }
      worker = await startWorker(config);
      workers.push(worker);
    },
  };
}

test("validated structured output and its requested schema survive worker replacement", async () => {
  const f = await fixture();
  f.worker.faux!.setResponses([output({ answer: 42 })]);
  const response = await f.send({ format });
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.info.structured).toEqual({ answer: 42 });
  expect(result.info.error).toBeUndefined();
  expect(f.worker.faux!.state.callCount).toBe(1);
  const before = await f.history();
  expect(before[0].info.format).toEqual(format);
  expect(before.at(-1).info.structured).toEqual({ answer: 42 });
  await f.restart();
  expect(await f.history()).toEqual(before);
  expect(f.worker.env.calls).toHaveLength(0);
});

test("question recovery retains the remaining structured validation budget without counting cached failures twice", async () => {
  const f = await fixture();
  f.worker.faux!.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("StructuredOutput", { answer: "invalid" }),
        fauxToolCall("question", {
          questions: [
            {
              header: "Continue",
              question: "Continue?",
              options: [{ label: "Go", description: "Continue the request." }],
            },
          ],
        }),
      ],
      { stopReason: "toolUse" },
    ),
  ]);
  const pending = f
    .send({ format: { ...format, retryCount: 1 } })
    .then((response) => response.arrayBuffer())
    .catch(() => null);
  let questions: any[] = [];
  const deadline = Date.now() + 2000;
  while (!(questions = await f.questions()).length) {
    if (Date.now() > deadline) throw new Error("question did not appear");
    await Bun.sleep(5);
  }
  const snapshot = structuredClone(f.items);
  await f.restart(snapshot);
  await pending;
  const restoreDeadline = Date.now() + 2000;
  let restored: any[] = [];
  while (!(restored = await f.questions()).length) {
    if (Date.now() > restoreDeadline)
      throw new Error("question did not reappear");
    await Bun.sleep(5);
  }
  expect(restored.map((question) => question.id)).toEqual(
    questions.map((question) => question.id),
  );
  f.worker.faux!.setResponses([output({ answer: 42 })]);
  expect((await f.reply(questions[0].id)).status).toBe(200);
  const resumedDeadline = Date.now() + 2000;
  while (!(await f.history()).at(-1).info.structured) {
    if (Date.now() > resumedDeadline)
      throw new Error("structured output did not complete after the question");
    await Bun.sleep(5);
  }
  expect((await f.history()).at(-1).info.structured).toEqual({ answer: 42 });
  expect(f.worker.faux!.state.callCount).toBe(1);
});

test("format is part of retry identity and completed retries do not call the model again", async () => {
  const f = await fixture();
  f.worker.faux!.setResponses([output({ answer: 42 })]);
  const body = {
    messageID: mintWireMessageId({ nowMs: Date.now() }).id,
    format,
  };
  const response = await f.send(body);
  expect(response.status).toBe(200);
  const first = await response.json();
  const retry = await f.send(body);
  expect(retry.status).toBe(200);
  expect(await retry.json()).toEqual(first);
  expect(
    (await f.send({ ...body, format: { ...format, retryCount: 1 } })).status,
  ).toBe(409);
  expect(f.worker.faux!.state.callCount).toBe(1);
});

test("a noReply prompt saves its format without running the model", async () => {
  const f = await fixture();
  expect((await f.send({ format, noReply: true })).status).toBe(200);
  const before = await f.history();
  expect(before).toHaveLength(1);
  expect(before[0].info.format).toEqual(format);
  expect(f.worker.faux!.state.callCount).toBe(0);
  await f.restart();
  expect(await f.history()).toEqual(before);
});

test("Stop preserves cancellation instead of changing it to a format error", async () => {
  const f = await fixture();
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.worker.faux!.setResponses([
    async (_context, options) => {
      entered();
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve();
        else
          options?.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
      });
      return fauxAssistantMessage([], {
        stopReason: "aborted",
        errorMessage: "stopped",
      });
    },
  ]);
  const pending = f.send({ format });
  await ready;
  expect((await f.abort()).status).toBe(200);
  expect((await (await pending).json()).info.error.name).toBe(
    "MessageAbortedError",
  );
  const before = await f.history();
  await f.restart();
  expect(await f.history()).toEqual(before);
});

test("a partial structured tool batch never becomes a completed result after a crash", async () => {
  const f = await fixture();
  f.worker.faux!.setResponses([output({ answer: 42 })]);
  expect((await f.send({ format })).status).toBe(200);
  const toolResult = f.items.findIndex(
    (item: any) =>
      item.kind === "entry" && item.entry.message?.role === "toolResult",
  );
  expect(toolResult).toBeGreaterThan(0);
  await f.restart(f.items.slice(0, toolResult));
  const after = await f.history();
  expect(after.at(-1).info.error.name).toBe("MessageAbortedError");
  expect(after.some((message) => message.info.structured !== undefined)).toBe(
    false,
  );
  expect(after[0].info.format).toEqual(format);
  expect(f.worker.faux!.state.callCount).toBe(0);
});

test.each([
  "http://json-schema.org/draft-07/schema#",
  "https://json-schema.org/draft/2020-12/schema",
])(
  "structured output validates local schema references in %s",
  async ($schema) => {
    const f = await fixture();
    const referenced = {
      $schema,
      type: "object",
      $defs: { code: { type: "string", const: "cobalt" } },
      properties: { code: { $ref: "#/$defs/code" } },
      required: ["code"],
      additionalProperties: false,
    };
    f.worker.faux!.setResponses([output({ code: "cobalt" })]);
    const response = await f.send({
      format: { type: "json_schema", schema: referenced },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).info.structured).toEqual({ code: "cobalt" });
    expect(f.worker.faux!.state.callCount).toBe(1);
  },
);

test("invalid structured output retries within the requested budget and accepts the corrected result", async () => {
  const f = await fixture();
  f.worker.faux!.setResponses([
    output({ answer: "invalid" }),
    output({ answer: 42 }),
  ]);
  const response = await f.send({ format: { ...format, retryCount: 1 } });
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.info.structured).toEqual({ answer: 42 });
  expect(result.info.error).toBeUndefined();
  expect(f.worker.faux!.state.callCount).toBe(2);
});

test("exhausted structured output stops with a durable error and leaves the next text turn unrestricted", async () => {
  const f = await fixture();
  f.worker.faux!.setResponses([
    output({ answer: "invalid" }),
    output({ answer: 42 }),
  ]);
  const response = await f.send({ format: { ...format, retryCount: 0 } });
  expect(response.status).toBe(200);
  expect((await response.json()).info.error).toMatchObject({
    name: "StructuredOutputError",
    data: { retries: 0 },
  });
  expect(f.worker.faux!.state.callCount).toBe(1);
  const before = await f.history();
  await f.restart();
  expect(await f.history()).toEqual(before);
  f.worker.faux!.setResponses([fauxAssistantMessage("ordinary answer")]);
  const plain = await f.send({ format: { type: "text" } });
  expect(plain.status).toBe(200);
  const result = await plain.json();
  expect(result.info.error).toBeUndefined();
  expect(result.info.structured).toBeUndefined();
  expect(
    result.parts.some((part: any) => part.text === "ordinary answer"),
  ).toBe(true);
});

test("a provider ending without the required structured tool returns a structured output error", async () => {
  const f = await fixture();
  f.worker.faux!.setResponses([fauxAssistantMessage("not structured")]);
  const response = await f.send({ format });
  expect(response.status).toBe(200);
  expect((await response.json()).info.error).toMatchObject({
    name: "StructuredOutputError",
  });
});

test("a failed automatic summary keeps its provider error on a structured request", async () => {
  const f = await fixture();
  expect(
    (
      await f.send({
        noReply: true,
        parts: [{ type: "text", text: "archive ".repeat(3000) }],
      })
    ).status,
  ).toBe(200);
  f.worker.agent.state.model!.contextWindow = 4096;
  f.worker.faux!.setResponses([
    fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage: "summary provider unavailable",
    }),
  ]);
  const response = await f.send({ format });
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.info.error.name).toBe("UnknownError");
  expect(result.info.error.data.message).toContain(
    "summary provider unavailable",
  );
  expect(f.worker.faux!.state.callCount).toBe(1);
  const before = await f.history();
  await f.restart();
  expect(await f.history()).toEqual(before);
});

test("an early lifecycle stop returns a durable structured output error", async () => {
  const f = await fixture();
  f.worker.agent.shouldStopAfterTurn = () => true;
  f.worker.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall("todoread", {})], {
      stopReason: "toolUse",
    }),
  ]);
  const response = await f.send({ format });
  expect(response.status).toBe(200);
  expect((await response.json()).info.error).toMatchObject({
    name: "StructuredOutputError",
    data: { retries: 0 },
  });
  expect(f.worker.faux!.state.callCount).toBe(1);
  const before = await f.history();
  await f.restart();
  expect(await f.history()).toEqual(before);
});

test("queued prompts use their own schema and restore plain text after both finish", async () => {
  const f = await fixture();
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const secondFormat = {
    type: "json_schema",
    schema: {
      type: "object",
      properties: { code: { type: "string", const: "cobalt" } },
      required: ["code"],
    },
  };
  const schemas: unknown[] = [];
  f.worker.faux!.setResponses([
    async (context) => {
      schemas.push(
        context.tools?.find((tool) => tool.name === "StructuredOutput")
          ?.parameters,
      );
      entered();
      await wait;
      return output({ answer: 42 });
    },
    (context) => {
      schemas.push(
        context.tools?.find((tool) => tool.name === "StructuredOutput")
          ?.parameters,
      );
      return output({ code: "cobalt" });
    },
    (context) => {
      expect(
        context.tools?.some((tool) => tool.name === "StructuredOutput"),
      ).toBe(false);
      return fauxAssistantMessage("READY");
    },
  ]);
  const first = f.send({ format });
  await ready;
  const second = f.send({ format: secondFormat });
  release();
  expect((await (await first).json()).info.structured).toEqual({ answer: 42 });
  expect((await (await second).json()).info.structured).toEqual({
    code: "cobalt",
  });
  expect(schemas).toEqual([schema, secondFormat.schema]);
  expect((await (await f.send({})).json()).info.structured).toBeUndefined();
  expect(f.worker.faux!.state.callCount).toBe(3);
});

test.each([
  { type: "json_schema", schema: { type: "nonsense" } },
  { type: "json_schema", schema: { $ref: "#/missing" } },
  { type: "json_schema", schema, retryCount: -1 },
  { type: "json_schema", schema, retryCount: 0.5 },
  { type: "json_schema", schema: { $async: true as const, ...schema } },
])(
  "rejects invalid output format before acknowledging or invoking the provider: %j",
  async (invalid) => {
    const f = await fixture();
    const response = await f.send({ format: invalid });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("format"),
    });
    expect(f.worker.faux!.state.callCount).toBe(0);
    expect(await f.history()).toEqual([]);
  },
);

test.each([true, false])(
  "a crash after saving structured completion preserves its outcome, valid=%s",
  async (valid) => {
    const f = await fixture();
    f.worker.faux!.setResponses([output({ answer: valid ? 42 : "invalid" })]);
    expect(
      (await f.send({ format: { ...format, retryCount: 0 } })).status,
    ).toBe(200);
    const before = await f.history();
    const completion = f.items.findIndex(
      (item: any) =>
        item.kind === "journal" && item.record.type === "completed",
    );
    expect(completion).toBeGreaterThan(0);
    await f.restart(f.items.slice(0, completion));
    expect(await f.history()).toEqual(before);
    expect(f.worker.faux!.state.callCount).toBe(0);
  },
);

test("the default validation budget stops after three failed attempts", async () => {
  const f = await fixture();
  f.worker.faux!.setResponses([
    output({}),
    output({}),
    output({}),
    output({ answer: 42 }),
  ]);
  const response = await f.send({ format });
  expect(response.status).toBe(200);
  expect((await response.json()).info.error).toMatchObject({
    name: "StructuredOutputError",
    data: { retries: 2 },
  });
  expect(f.worker.faux!.state.callCount).toBe(3);
});

test.each([true, false])(
  "a finished structured request prevents later work in the same tool batch, valid=%s",
  async (valid) => {
    const f = await fixture();
    let calls = 0;
    f.worker.agent.state.tools.push({
      name: "later_work",
      label: "Later work",
      description: "Run more work.",
      parameters: { type: "object", properties: {} } as any,
      execute: async () => {
        calls++;
        return { content: [{ type: "text", text: "ran" }], details: {} };
      },
    });
    f.worker.faux!.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("StructuredOutput", { answer: valid ? 42 : "invalid" }),
          fauxToolCall("StructuredOutput", { answer: 99 }),
          fauxToolCall("later_work", {}),
        ],
        { stopReason: "toolUse" },
      ),
    ]);
    const response = await f.send({ format: { ...format, retryCount: 0 } });
    expect(response.status).toBe(200);
    const result = await response.json();
    if (valid) expect(result.info.structured).toEqual({ answer: 42 });
    else
      expect(result.info.error).toMatchObject({
        name: "StructuredOutputError",
        data: { retries: 0 },
      });
    expect(calls).toBe(0);
    expect(f.worker.faux!.state.callCount).toBe(1);
  },
);
