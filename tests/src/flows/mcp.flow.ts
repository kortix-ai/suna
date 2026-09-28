/**
 * The hosted MCP server (apps/api/src/mcp) and the OAuth pieces an MCP client
 * needs from "Sign in with Kortix": the 401 challenge, RFC 9728 resource
 * metadata, RFC 7591 registration, and a PKCE exchange that yields a token the
 * MCP endpoint accepts. Maps to spec MCP-*.
 */
import { flow } from "../core/flow";
import { waitFor } from "../core/poll";

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
async function pkcePair() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
};
const rpc = (id: number, method: string, params: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id, method, params });

// ── MCP-1: challenge + discovery ─────────────────────────────────────────────
flow(
  "MCP-1",
  {
    domain: "mcp",
    routes: [
      "POST /v1/projects/:projectId/mcp",
      "GET /.well-known/oauth-protected-resource/v1/projects/:projectId/mcp",
      "GET /.well-known/oauth-authorization-server",
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    let issuer = "";
    await ctx.step("authorization-server metadata names the RFC 7591 registration endpoint", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/.well-known/oauth-authorization-server");
      r.status(200);
      issuer = r.json<any>().issuer;
      if (r.json<any>().registration_endpoint !== `${issuer}/v1/oauth/register`) {
        throw new Error(`registration_endpoint: ${r.json<any>().registration_endpoint}`);
      }
    });
    let metadataUrl = "";
    await ctx.step("no token → 401 with a Bearer challenge naming the resource metadata and the kortix scope", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/projects/:projectId/mcp", rpc(1, "initialize"), { params: { projectId: p.id } });
      r.status(401);
      const challenge = r.header("www-authenticate") ?? "";
      metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1] ?? "";
      if (metadataUrl !== `${issuer}/.well-known/oauth-protected-resource/v1/projects/${p.id}/mcp`) throw new Error(`challenge: ${challenge}`);
      if (!challenge.includes('scope="kortix"')) throw new Error(`scope missing: ${challenge}`);
    });
    await ctx.step("a bad token → the same 401 challenge, not a bare error", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/projects/:projectId/mcp", rpc(1, "initialize"), {
        params: { projectId: p.id },
        headers: { Authorization: "Bearer kortix_oat_not-a-real-token" },
      });
      r.status(401);
      if (!r.header("www-authenticate")?.includes("resource_metadata=")) throw new Error("no challenge on a bad token");
    });
    await ctx.step("RFC 9728 metadata names the MCP URL as the resource and Kortix as its authorization server", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/.well-known/oauth-protected-resource/v1/projects/:projectId/mcp", { params: { projectId: p.id } });
      r.status(200).body().has("$.resource", `${issuer}/v1/projects/${p.id}/mcp`).has("$.authorization_servers[0]", issuer).has("$.scopes_supported[0]", "kortix");
    });
  },
);

// ── MCP-2: dynamic client registration ───────────────────────────────────────
flow("MCP-2", { domain: "mcp", routes: ["POST /v1/oauth/register"] }, async (ctx) => {
  await ctx.step("a loopback client registers as a public PKCE client with the kortix scope", async () => {
    const r = await ctx.client.as(ctx.P.ANON).post("/v1/oauth/register", {
      client_name: "Flow MCP client",
      redirect_uris: ["http://127.0.0.1:33418/callback"],
      token_endpoint_auth_method: "none",
    });
    r.status(201).body().exists("$.client_id").has("$.token_endpoint_auth_method", "none").has("$.scope", "kortix").has("$.client_name", "Flow MCP client");
    if (r.json<any>().client_secret) throw new Error("a public client got a secret");
  });
  await ctx.step("a native app scheme (cursor://) registers", async () => {
    const r = await ctx.client.as(ctx.P.ANON).post("/v1/oauth/register", { redirect_uris: ["cursor://anysphere.cursor-mcp/oauth/callback"] });
    r.status(201).body().has("$.client_name", "MCP client");
  });
  await ctx.step("javascript:, plain http off loopback, and a missing redirect list are refused", async () => {
    const js = await ctx.client.as(ctx.P.ANON).post("/v1/oauth/register", { redirect_uris: ["javascript:alert(1)"] });
    js.status(400).body().has("$.error", "invalid_redirect_uri");
    const http = await ctx.client.as(ctx.P.ANON).post("/v1/oauth/register", { redirect_uris: ["http://evil.example.test/cb"] });
    http.status(400).body().has("$.error", "invalid_redirect_uri");
    const none = await ctx.client.as(ctx.P.ANON).post("/v1/oauth/register", { client_name: "x" });
    none.status(400);
  });
  await ctx.step("an unknown scope is refused", async () => {
    const r = await ctx.client.as(ctx.P.ANON).post("/v1/oauth/register", { redirect_uris: ["http://localhost:1/cb"], scope: "admin" });
    r.status(400).body().has("$.error", "invalid_client_metadata");
  });
});

// ── MCP-3: OAuth → flag gate → tools ─────────────────────────────────────────
flow(
  "MCP-3",
  {
    domain: "mcp",
    routes: [
      "POST /v1/oauth/register",
      "GET /v1/oauth/authorize",
      "GET /v1/oauth/authorize/consent/:requestId",
      "POST /v1/oauth/authorize/consent",
      "POST /v1/oauth/token",
      "PATCH /v1/projects/:projectId/features",
      "POST /v1/projects/:projectId/mcp",
      "GET /v1/projects/:projectId/mcp",
      "DELETE /v1/projects/:projectId/mcp",
      "GET /v1/accounts/me",
      "GET /v1/accounts/:accountId/audit",
      "GET /v1/skills",
      "GET /v1/skills/:name",
      "GET /v1/projects/:projectId/files",
      "GET /v1/projects/:projectId/files/content",
      "GET /v1/projects/:projectId/sessions",
      "GET /v1/projects/:projectId/sessions/:sessionId",
      "GET /v1/projects/:projectId/sessions/:sessionId/turn",
      "GET /v1/projects/:projectId/sessions/:sessionId/prompts",
      "GET /v1/projects/:projectId/sessions/:sessionId/transcript",
    ],
  },
  async (ctx) => {
    // Seeded: a real git repository, so list_files / read_file have a tree to read.
    // Enterprise: reading the audit trail back needs the auditAccess entitlement.
    const team = await ctx.fixtures.team({ enterprise: true });
    const p = await team.project({ seed: true });
    const redirectUri = "http://127.0.0.1:33419/callback";
    const { verifier, challenge } = await pkcePair();
    const issuer = (await ctx.client.as(ctx.P.ANON).get("/.well-known/oauth-authorization-server")).json<any>().issuer;
    const resource = `${issuer}/v1/projects/${p.id}/mcp`;
    let clientId = "";
    let token = "";
    const mcp = (body: unknown, headers: Record<string, string> = {}) =>
      ctx.client.as(ctx.P.ANON).post("/v1/projects/:projectId/mcp", body, {
        params: { projectId: p.id },
        // Real MCP clients ask for compression; tool calls must still read plain bodies.
        headers: { Authorization: `Bearer ${token}`, "Accept-Encoding": "gzip, deflate, br", ...headers },
      });
    const toolText = async (id: number, name: string, args: Record<string, unknown>) => {
      const r = await mcp(rpc(id, "tools/call", { name, arguments: args }));
      r.status(200);
      const result = r.json<any>().result;
      if (result.isError) throw new Error(`${name} → isError: ${result.content[0].text.slice(0, 300)}`);
      return result.content[0].text as string;
    };

    await ctx.step("register, authorize for the MCP resource with no scope, and see a self-registered consent for kortix", async () => {
      const reg = await ctx.client.as(ctx.P.ANON).post("/v1/oauth/register", { client_name: "Flow MCP", redirect_uris: [redirectUri] });
      reg.status(201);
      clientId = reg.json<any>().client_id;
    });
    let requestId = "";
    await ctx.step("authorize (resource = the MCP URL, no scope) → 302 consent", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/v1/oauth/authorize", {
        query: { client_id: clientId, redirect_uri: redirectUri, response_type: "code", state: "st", code_challenge: challenge, code_challenge_method: "S256", resource },
      });
      r.status(302);
      requestId = new URL(r.header("location")!).searchParams.get("request_id") ?? "";
      if (!requestId) throw new Error("no request_id");
    });
    let code = "";
    await ctx.step("consent shows the kortix scope, self_registered, and the loopback target; approve → code", async () => {
      const meta = await ctx.client.as(ctx.P.OWNER).get("/v1/oauth/authorize/consent/:requestId", { params: { requestId } });
      meta.status(200).body().has("$.scopes[0]", "kortix").has("$.self_registered", true).has("$.redirect_to", "127.0.0.1:33419").has("$.client_type", "public");
      const ok = await ctx.client.as(ctx.P.OWNER).post("/v1/oauth/authorize/consent", { request_id: requestId, approved: true });
      ok.status(200);
      code = new URL(ok.json<any>().redirect_uri).searchParams.get("code") ?? "";
      if (!code) throw new Error("no code");
    });
    await ctx.step("token: PKCE alone (no secret) → a kortix-scoped access token that acts as the user", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/oauth/token", form({ grant_type: "authorization_code", client_id: clientId, code, redirect_uri: redirectUri, code_verifier: verifier, resource }));
      r.status(200).body().has("$.scope", "kortix");
      token = r.json<any>().access_token;
      const me = await ctx.client.as(ctx.P.ANON).get("/v1/accounts/me", { headers: { Authorization: `Bearer ${token}` } });
      me.status(200).body().has("$.token_context.auth_type", "oauth");
    });
    await ctx.step("flag off (the default) → 403 feature_disabled", async () => {
      const r = await mcp(rpc(1, "initialize", { protocolVersion: "2025-06-18" }));
      r.status(403).body().has("$.code", "feature_disabled").has("$.feature", "mcp");
    });
    await ctx.step("OWNER turns the mcp flag on", async () => {
      const r = await ctx.client.as(ctx.P.OWNER).patch("/v1/projects/:projectId/features", { feature: "mcp", enabled: true }, { params: { projectId: p.id } });
      r.status(200);
    });
    await ctx.step("initialize → the requested protocol version, tools capability, project-named instructions", async () => {
      const r = await mcp(rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "flow", version: "1" } }));
      r.status(200).body().has("$.result.protocolVersion", "2025-06-18").has("$.result.serverInfo.name", "kortix").exists("$.result.capabilities.tools");
      if (!r.json<any>().result.instructions.includes(p.id)) throw new Error("instructions do not name the project");
    });
    await ctx.step("notifications/initialized → 202; GET and DELETE → 405 (stateless: no stream, no session)", async () => {
      const n = await mcp({ jsonrpc: "2.0", method: "notifications/initialized" });
      n.status(202);
      const g = await ctx.client.as(ctx.P.ANON).get("/v1/projects/:projectId/mcp", { params: { projectId: p.id }, headers: { Authorization: `Bearer ${token}` } });
      g.status(405);
      const d = await ctx.client.as(ctx.P.ANON).del("/v1/projects/:projectId/mcp", { params: { projectId: p.id }, headers: { Authorization: `Bearer ${token}` } });
      d.status(405);
    });
    await ctx.step("tools/list → the twelve tools", async () => {
      const r = await mcp(rpc(2, "tools/list"));
      r.status(200);
      const names = r.json<any>().result.tools.map((t: { name: string }) => t.name).sort();
      const want = [
        "call_api", "describe_api", "list_files", "list_sessions", "read_file", "read_session",
        "read_skill", "run_command", "search_api", "send_message", "start_session", "write_file",
      ];
      if (JSON.stringify(names) !== JSON.stringify(want)) throw new Error(`tools: ${names}`);
    });
    await ctx.step("search_api finds the secrets routes; describe_api reads one", async () => {
      const s = await mcp(rpc(3, "tools/call", { name: "search_api", arguments: { query: "secrets" } }));
      const hits: string = s.json<any>().result.content[0].text;
      if (!hits.includes("/v1/projects/{projectId}/secrets")) throw new Error(`search: ${hits.slice(0, 300)}`);
      if (hits.includes("/v1/oauth")) throw new Error("search leaks OAuth routes");
      const d = await mcp(rpc(4, "tools/call", { name: "describe_api", arguments: { method: "GET", path: "/v1/projects/:projectId/secrets" } }));
      const doc = JSON.parse(d.json<any>().result.content[0].text);
      if (doc.path !== "/v1/projects/{projectId}/secrets") throw new Error(`describe: ${JSON.stringify(doc).slice(0, 200)}`);
    });
    await ctx.step("call_api runs as the user: GET /v1/accounts/me → HTTP 200 auth_type oauth; {projectId} → this project", async () => {
      const me = await mcp(rpc(5, "tools/call", { name: "call_api", arguments: { method: "GET", path: "/v1/accounts/me" } }));
      const text: string = me.json<any>().result.content[0].text;
      if (!text.startsWith("HTTP 200") || !text.includes('"auth_type":"oauth"')) throw new Error(`me: ${JSON.stringify(text.slice(0, 400))}`);
      const proj = await mcp(rpc(6, "tools/call", { name: "call_api", arguments: { method: "GET", path: "/v1/projects/{projectId}" } }));
      const body: string = proj.json<any>().result.content[0].text;
      if (!body.startsWith("HTTP 200") || !body.includes(p.id)) throw new Error(`project: ${JSON.stringify(body.slice(0, 400))}`);
    });
    await ctx.step("call_api refuses /v1/oauth and MCP paths; a missing session is an isError 404", async () => {
      const oauth = await mcp(rpc(7, "tools/call", { name: "call_api", arguments: { method: "POST", path: "/v1/oauth/register" } }));
      oauth.status(200).body().has("$.result.isError", true);
      const loop = await mcp(rpc(8, "tools/call", { name: "call_api", arguments: { method: "POST", path: "/v1/projects/{projectId}/mcp" } }));
      loop.status(200).body().has("$.result.isError", true);
      const missing = await mcp(rpc(9, "tools/call", { name: "read_session", arguments: { session_id: "00000000-0000-4000-a000-000000000000" } }));
      missing.status(200).body().has("$.result.isError", true);
    });
    await ctx.step("read_skill lists the platform guides and reads kortix-system in full", async () => {
      const list = await toolText(11, "read_skill", {});
      if (!list.includes("kortix-system — ")) throw new Error(`skills: ${list.slice(0, 300)}`);
      const guide = await toolText(12, "read_skill", { name: "kortix-system" });
      if (!guide.includes("kortix.yaml") || guide.startsWith("{")) throw new Error(`guide: ${guide.slice(0, 300)}`);
    });
    await ctx.step("list_files and read_file without a session read the project repository", async () => {
      const files = (await toolText(13, "list_files", {})).split("\n");
      if (!files.includes("kortix.yaml")) throw new Error(`repo files: ${files.slice(0, 20)}`);
      const manifest = await toolText(14, "read_file", { path: "kortix.yaml" });
      if (!manifest.includes("\n")) throw new Error(`kortix.yaml: ${JSON.stringify(manifest.slice(0, 200))}`);
      const missing = await mcp(rpc(15, "tools/call", { name: "read_file", arguments: { path: "no/such/file.txt" } }));
      missing.status(200).body().has("$.result.isError", true);
    });
    await ctx.step("list_sessions → a JSON array; sandbox tools on a missing session → isError 404", async () => {
      if (!Array.isArray(JSON.parse(await toolText(16, "list_sessions", {})))) throw new Error("list_sessions is not an array");
      for (const [id, name, args] of [
        [17, "run_command", { command: "true" }],
        [18, "list_files", {}],
        [19, "write_file", { path: "x.txt", content: "x" }],
      ] as const) {
        const r = await mcp(rpc(id, "tools/call", { name, arguments: { session_id: "00000000-0000-4000-a000-000000000000", ...args } }));
        const result = r.json<any>().result;
        if (!result.isError || !result.content[0].text.startsWith("HTTP 404")) throw new Error(`${name}: ${JSON.stringify(result)}`);
      }
    });
    await ctx.step("a session read by id names its owner exactly as the list does; list_sessions and read_session show it", async () => {
      const session = await ctx.fixtures.session(p);
      const params = { projectId: p.id, sessionId: session.id };
      const one = (await ctx.client.as(ctx.P.OWNER).get("/v1/projects/:projectId/sessions/:sessionId", { params })).json<any>();
      const row = (await ctx.client.as(ctx.P.OWNER).get("/v1/projects/:projectId/sessions", { params: { projectId: p.id } }))
        .json<any[]>()
        .find((s) => s.session_id === session.id);
      if (one.owner_type !== "user" || !one.owner_email || one.owner_email !== row?.owner_email || one.owner_name !== row?.owner_name) {
        throw new Error(`owner by id ${JSON.stringify([one.owner_type, one.owner_email, one.owner_name])} vs list ${JSON.stringify([row?.owner_type, row?.owner_email, row?.owner_name])}`);
      }
      const listed = JSON.parse(await toolText(21, "list_sessions", {})) as Array<{ session_id: string; owner: string | null }>;
      if (!listed.some((s) => s.session_id === session.id && s.owner)) throw new Error(`list_sessions: ${JSON.stringify(listed)}`);
      const read = JSON.parse(await toolText(22, "read_session", { session_id: session.id }));
      if (read.session_id !== session.id || !["idle", "running", "booting"].includes(read.turn) || !Array.isArray(read.messages)) {
        throw new Error(`read_session: ${JSON.stringify(read).slice(0, 400)}`);
      }
    });
    await ctx.step("tool calls are audited as the mcp client (client_reported_source = mcp)", async () => {
      const correlationId = ctx.fixtures.name("mcp-audit");
      const r = await mcp(rpc(20, "tools/call", { name: "call_api", arguments: { method: "GET", path: "/v1/projects/{projectId}" } }), {
        "x-correlation-id": correlationId,
      });
      r.status(200);
      const audit = await waitFor(
        () =>
          ctx.client.as(ctx.P.OWNER).get("/v1/accounts/:accountId/audit", {
            params: { accountId: team.id },
            query: { project_id: p.id, correlation_id: correlationId },
          }),
        {
          until: (res) =>
            res.statusCode === 200 &&
            (res.json<{ events?: Array<{ action?: string }> }>().events ?? []).some((e) => e.action === "project.read"),
          timeoutMs: 15_000,
          intervalMs: 500,
          description: `the audit event for ${correlationId}`,
        },
      );
      const events = audit.json<{ events: Array<Record<string, unknown>> }>().events;
      // The tool's own API call carries the client; the outer row is `mcp.request`.
      const read = events.find((e) => e.action === "project.read");
      if (read?.client_reported_source !== "mcp") throw new Error(`audit: ${JSON.stringify(read)}`);
    });
    await ctx.step("an unknown JSON-RPC method → -32601", async () => {
      const r = await mcp(rpc(10, "resources/list"));
      r.status(200).body().has("$.error.code", -32601);
    });
  },
);
