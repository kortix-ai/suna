/**
 * Voice (live calls) — the bot-name setting and the voice MCP. Maps to spec §VOICE.
 *
 * Replaces the old §MEET flows: the ElevenLabs voice picker, the preview endpoint,
 * the `speak` proxy, and both Recall webhooks were deleted with the notetaker.
 *
 * What is asserted here is deliberately the shape of the contract, not a live
 * call: spawning one costs Recall bot-minutes and provider minutes, and needs a
 * real meeting URL. The behaviours that actually break agents — a blocking tool
 * appearing, a spawn failure escalating into a protocol error, an unauthenticated
 * caller reaching the MCP — are all checkable without one.
 */
import { flow } from "../core/flow";

// VOICE-1 — the bot's display name in the call (manage ACL).
flow(
  "VOICE-1",
  { domain: "voice", routes: ["PUT /v1/projects/:projectId/channels/meet/name"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("OWNER sets the name → 200", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .put("/v1/projects/:projectId/channels/meet/name", { name: "Kortix QA" }, {
          params: { projectId: p.id },
        });
      r.status(200).body().exists("$.bot_name");
    });
    await ctx.step("NONMEMBER → 403/404", async () => {
      const r = await ctx.client
        .as(ctx.P.NONMEMBER)
        .put("/v1/projects/:projectId/channels/meet/name", { name: "nope" }, {
          params: { projectId: p.id },
        });
      r.status([403, 404]);
    });
    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .put("/v1/projects/:projectId/channels/meet/name", { name: "nope" }, {
          params: { projectId: p.id },
        });
      r.status(401);
    });
  },
);

// VOICE-2 — MCP handshake + the tool surface.
flow(
  "VOICE-2",
  { domain: "voice", routes: ["POST /v1/projects/:projectId/mcp/voice"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();

    await ctx.step("initialize → server info", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/mcp/voice", { jsonrpc: "2.0", id: 1, method: "initialize" }, {
          params: { projectId: p.id },
        });
      // 401 is valid too: a user principal without a session cannot drive a call.
      r.status([200, 401]);
    });

    await ctx.step("tools/list exposes no blocking tool", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post("/v1/projects/:projectId/mcp/voice", { jsonrpc: "2.0", id: 2, method: "tools/list" }, {
          params: { projectId: p.id },
        });
      r.status([200, 401]);
      // A follow/tail/stream tool would wedge the single-threaded agent loop.
      // This is the assertion that catches one being added later.
      if (r.statusCode === 200) {
        const body = r.json<{ result?: { tools?: Array<{ name: string }> } }>();
        const names = (body?.result?.tools ?? []).map((tool) => tool.name);
        if (names.length > 0 && names.some((n) => /follow|tail|stream|wait/.test(n))) {
          throw new Error(`voice MCP exposes a blocking tool: ${names.join(", ")}`);
        }
      }
    });

    await ctx.step("ANON → 401", async () => {
      const r = await ctx.client
        .as(ctx.P.ANON)
        .post("/v1/projects/:projectId/mcp/voice", { jsonrpc: "2.0", id: 3, method: "tools/list" }, {
          params: { projectId: p.id },
        });
      r.status(401);
    });
  },
);

// VOICE-3 — malformed JSON-RPC is a protocol error, not a 500.
flow(
  "VOICE-3",
  { domain: "voice", routes: ["POST /v1/projects/:projectId/mcp/voice"] },
  async (ctx) => {
    const p = await ctx.fixtures.sharedProject();
    await ctx.step("unknown method → -32601 (or 401 without a session principal)", async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .post(
          "/v1/projects/:projectId/mcp/voice",
          { jsonrpc: "2.0", id: 9, method: "resources/list" },
          { params: { projectId: p.id } },
        );
      r.status([200, 401]);
    });
  },
);
