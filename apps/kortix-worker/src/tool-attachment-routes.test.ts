import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { startWorker } from "./worker.ts";

const globals = globalThis as any;
const original = {
  factory: globals.__KORTIX_PI_AGENT__,
  compiled: globals.__KORTIX_COMPILED__,
};
const workers: Awaited<ReturnType<typeof startWorker>>[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  globals.__KORTIX_PI_AGENT__ = original.factory;
  globals.__KORTIX_COMPILED__ = original.compiled;
  for (const worker of workers.splice(0)) {
    worker.agent.abort();
    worker.server.closeAllConnections();
    await worker.close();
  }
  for (const server of servers.splice(0)) server.stop(true);
});
const image = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9l8AAAAASUVORK5CYII=",
  "base64",
);
const digest = createHash("sha256").update(image).digest("hex");

async function fixture() {
  const items: any[] = [];
  const blobs = new Map<string, Uint8Array<ArrayBuffer>>();
  const writes: string[] = [];
  let executions = 0;
  let hookCalls = 0;
  const hookImages: string[] = [];
  const contextImages: string[] = [];
  let failStorage = false;
  let uploadGate: Promise<void> | undefined;
  let uploadStarted: (() => void) | undefined;
  const store = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.includes("/attachments/")) {
        expect(request.headers.get("authorization")).toBe(
          "Bearer storage-token",
        );
        if (failStorage) return new Response(null, { status: 503 });
        if (request.method === "PUT") {
          expect(request.headers.get("content-type")).toBe("image/png");
          const bytes = new Uint8Array(await request.arrayBuffer());
          writes.push(path);
          uploadStarted?.();
          if (uploadGate) await uploadGate;
          blobs.set(path, bytes);
          return new Response(null, { status: 204 });
        }
        return blobs.has(path)
          ? new Response(blobs.get(path), {
              headers: { "content-type": "image/png" },
            })
          : new Response(null, { status: 404 });
      }
      if (request.method === "GET") return Response.json(items);
      const item = await request.json();
      const id = request.headers.get("idempotency-key");
      if (!id || !items.some((row) => row._kortixAppendId === id))
        items.push(item);
      return new Response(null, { status: 204 });
    },
  });
  servers.push(store);
  globals.__KORTIX_COMPILED__ = {
    manifest: { default_agent: "build" },
    agentConfig: { agent: { build: { permission: "allow" } } },
  };
  globals.__KORTIX_PI_AGENT__ = () => ({
    onEvent(event: any) {
      if (event.type === "tool_execution_end") {
        for (const block of event.result.content)
          if (block.type === "image") hookImages.push(block.data);
      }
    },
    transformContext: async (messages: any[]) => {
      for (const message of messages)
        if (message.role === "toolResult") {
          for (const block of message.content)
            if (block.type === "image") contextImages.push(block.data);
        }
      return messages;
    },
    tools: [
      {
        name: "capture",
        label: "Capture",
        description: "Return a test image",
        parameters: Type.Object({}),
        execute: async () => {
          executions++;
          return {
            content: [
              {
                type: "image",
                mimeType: "image/png",
                data: image.toString("base64"),
              },
            ],
            details: { original: true },
          };
        },
      },
    ],
    afterToolCall: async ({ result }: any) => {
      hookCalls++;
      return {
        content: [
          ...result.content,
          { type: "text", text: "Capture complete" },
        ],
        details: { hook: true },
      };
    },
  });
  const cfg = {
    port: 0,
    envUrl: "http://127.0.0.1:1",
    envUrlExplicit: true,
    envCwd: "/workspace",
    systemPrompt: "Use capture when requested.",
    modelMode: "faux" as const,
    sessionId: "tool-images",
    kortixToken: "runtime-token",
    storeUrl: store.url.toString().replace(/\/$/, ""),
    storeHeaders: { authorization: "Bearer storage-token" },
  };
  let worker = await startWorker(cfg);
  workers.push(worker);
  const request = (path: string, body?: unknown, authorized = true) =>
    fetch(`http://127.0.0.1:${worker.port}${path}`, {
      headers: {
        ...(authorized ? { authorization: "Bearer runtime-token" } : {}),
        "content-type": "application/json",
      },
      ...(body === undefined
        ? {}
        : { method: "POST", body: JSON.stringify(body) }),
    });
  const id = (await (await request("/session")).json())[0].id;
  return {
    id,
    items,
    blobs,
    writes,
    hookImages,
    contextImages,
    request,
    get worker() {
      return worker;
    },
    get executions() {
      return executions;
    },
    get hookCalls() {
      return hookCalls;
    },
    holdUpload() {
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        uploadStarted = resolve;
      });
      uploadGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { started, release };
    },
    failStorage() {
      failStorage = true;
    },
    history: async () => (await request(`/session/${id}/message`)).json(),
    async restart() {
      await worker.close();
      worker = await startWorker(cfg);
      workers.push(worker);
    },
    async send() {
      worker.faux!.setResponses([
        fauxAssistantMessage(
          [fauxToolCall("capture", {}, { id: "image-call" })],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("Saw the image."),
      ]);
      return request(`/session/${id}/message`, {
        parts: [{ type: "text", text: "Capture an image." }],
      });
    },
  };
}

test("tool images survive native hooks, lazy reads, provider conversion, and worker restart", async () => {
  const f = await fixture();
  const contexts: any[][] = [];
  const convert = f.worker.agent.convertToLlm;
  f.worker.agent.convertToLlm = async (messages) => {
    const result = await convert(messages);
    contexts.push(structuredClone(result));
    return result;
  };
  expect((await f.send()).status).toBe(200);
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0]).toBe(`/sessions/tool-images/attachments/${digest}`);
  expect(f.blobs.get(f.writes[0]!)).toEqual(new Uint8Array(image));
  expect(f.executions).toBe(1);
  expect(f.hookCalls).toBe(1);
  expect(f.hookImages).toEqual([image.toString("base64")]);
  expect(f.contextImages).toEqual([image.toString("base64")]);
  expect(JSON.stringify(f.items)).not.toContain(image.toString("base64"));
  const providerResult = contexts
    .flat()
    .find((message) => message.role === "toolResult");
  expect(providerResult.content).toEqual([
    { type: "image", data: image.toString("base64"), mimeType: "image/png" },
    { type: "text", text: "Capture complete" },
  ]);
  const history = await f.history();
  const tool = history
    .flatMap((message: any) => message.parts)
    .find((part: any) => part.type === "tool");
  expect(tool.state).toMatchObject({
    status: "completed",
    output: "Capture complete",
    metadata: { hook: true },
  });
  expect(tool.state.attachments).toHaveLength(1);
  const file = tool.state.attachments[0];
  expect(file).toMatchObject({
    type: "file",
    mime: "image/png",
    messageID: tool.messageID,
    sessionID: f.id,
  });
  expect(file.url).toBe(`/kortix/part/${f.id}/${tool.messageID}/${file.id}`);
  expect(Buffer.from(await (await f.request(file.url)).arrayBuffer())).toEqual(
    image,
  );
  expect((await f.request(file.url, undefined, false)).status).toBe(401);
  expect(
    (await f.request(file.url.replace(tool.messageID, "another-message")))
      .status,
  ).toBe(404);
  await f.restart();
  expect(await f.history()).toEqual(history);
  expect(Buffer.from(await (await f.request(file.url)).arrayBuffer())).toEqual(
    image,
  );
  expect(f.executions).toBe(1);
  expect(f.worker.env.calls).toHaveLength(0);
});

test("an unacknowledged image becomes a tool error without leaking base64 into history", async () => {
  const f = await fixture();
  f.failStorage();
  expect((await f.send()).status).toBe(200);
  const tool = (await f.history())
    .flatMap((message: any) => message.parts)
    .find((part: any) => part.type === "tool");
  expect(tool.state.status).toBe("error");
  expect(tool.state.error).toContain("503");
  expect(tool.state.attachments).toBeUndefined();
  expect(JSON.stringify(f.items)).not.toContain(image.toString("base64"));
  expect(f.executions).toBe(1);
});

test("Stop cancels a pending tool-image upload before another model request", async () => {
  const f = await fixture();
  const upload = f.holdUpload();
  try {
    const sent = f.send();
    await upload.started;
    expect((await f.request(`/session/${f.id}/abort`, {})).status).toBe(200);
    expect((await sent).status).toBe(200);
    const history = await f.history();
    expect(history.at(-1).info.error.name).toBe("MessageAbortedError");
    expect(f.worker.faux!.state.callCount).toBe(1);
    expect(JSON.stringify(f.items)).not.toContain(image.toString("base64"));
    expect(
      history
        .flatMap((message: any) => message.parts)
        .some((part: any) => part.state?.attachments?.length),
    ).toBe(false);
    expect(f.executions).toBe(1);
  } finally {
    upload.release();
  }
});
