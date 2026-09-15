import { expect, test } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { captureLegacyWireIdentities } from "./legacy-wire-identity.ts";
import { mintRootId } from "./runtime-surface.ts";
import { startWorker } from "./worker.ts";
import type { SessionLogItem } from "./session-store.ts";

test("the real worker restores captured legacy identities and orders the next reply after them", async () => {
  const sessionId = "legacy-worker-restore";
  const sessionID = mintRootId(sessionId);
  const ids = [
    "msg_000000000010aaaaaaaaaaaaaa",
    "msg_000000000020bbbbbbbbbbbbbb",
  ];
  const entries = ["user", "assistant"].map((role, index) => ({
    id: `legacy-${index}`,
    type: "message",
    parentId: index ? "legacy-0" : null,
    seq: index,
    timestamp: index + 20,
    message: {
      role,
      content: [{ type: "text", text: `${role} old text` }],
      timestamp: index + 20,
      ...(role === "assistant"
        ? { stopReason: "stop", model: "old-model", provider: "old-provider" }
        : {}),
    },
  }));
  const wire = entries.map((entry, index) => ({
    info: {
      id: ids[index]!,
      role: entry.message.role,
      sessionID,
      time: { created: index + 10 },
    },
    parts: [
      {
        id: `legacy-part-${index}`,
        type: "text",
        messageID: ids[index]!,
        sessionID,
        text: entry.message.content[0]!.text,
      },
    ],
  }));
  const native = entries.map(
    (entry) => ({ kind: "entry", lane: "main", entry }) as SessionLogItem,
  );
  const items = [
    ...structuredClone(native),
    ...captureLegacyWireIdentities(sessionId, entries, wire),
  ];
  let writes = 0;
  const store = Bun.serve({
    port: 0,
    async fetch(r) {
      if (r.method === "GET") return Response.json(items);
      writes++;
      items.push((await r.json()) as SessionLogItem);
      return new Response(null, { status: 204 });
    },
  });
  const config = {
    port: 0,
    envUrl: "http://127.0.0.1:1",
    envUrlExplicit: true,
    envCwd: "/workspace",
    systemPrompt: "Follow the user.",
    modelMode: "faux" as const,
    sessionId,
    kortixToken: "legacy-fixture",
    storeUrl: store.url.toString(),
  };
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  const read = async () => {
    const r = await fetch(
      `http://127.0.0.1:${worker!.port}/session/${sessionID}/message`,
      { headers: { authorization: "Bearer legacy-fixture" } },
    );
    expect(r.status).toBe(200);
    return (await r.json()) as any[];
  };
  try {
    worker = await startWorker(config);
    const restored = await read();
    expect(restored.map((message) => message.info.id)).toEqual(ids);
    expect(restored.map((message) => message.info.time.created)).toEqual([
      10, 11,
    ]);
    expect(restored.map((message) => message.parts[0].id)).toEqual([
      "legacy-part-0",
      "legacy-part-1",
    ]);
    expect(restored[1].info.parentID).toBe(ids[0]);
    expect(writes).toBe(0);
    expect(items.slice(0, 2)).toEqual(native);
    worker.faux!.setResponses([fauxAssistantMessage("New reply.")]);
    const response = await fetch(
      `http://127.0.0.1:${worker.port}/session/${sessionID}/message`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer legacy-fixture",
          "content-type": "application/json",
        },
        body: JSON.stringify({ parts: [{ type: "text", text: "Continue." }] }),
      },
    );
    expect(response.status).toBe(200);
    const after = await read();
    expect(after).toHaveLength(4);
    expect(after.slice(0, 2)).toEqual(restored);
    expect(after[2].info.id > ids[1]!).toBe(true);
    expect(after[3].info.parentID).toBe(after[2].info.id);
    worker.server.closeAllConnections();
    await worker.close();
    worker = undefined;
    worker = await startWorker(config);
    expect(await read()).toEqual(after);
  } finally {
    if (worker) {
      worker.server.closeAllConnections();
      await worker.close();
    }
    store.stop(true);
  }
});
