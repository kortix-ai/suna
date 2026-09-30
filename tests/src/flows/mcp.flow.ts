/**
 * The hosted MCP server (apps/api/src/mcp, `POST /v1/mcp`) and the OAuth pieces
 * an MCP client needs from "Sign in with Kortix": the 401 challenge, RFC 9728
 * resource metadata, RFC 7591 registration, and a PKCE exchange that yields a
 * token the MCP endpoint accepts. One endpoint per person, bound to the token
 * like the CLI, never to a project. Maps to spec MCP-*.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subscribe } from "../fixtures/billing";
import { flow } from "../core/flow";
import { AgentPrincipalsWorld } from "../fixtures/agent-principals";
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
      "POST /v1/mcp",
      "GET /.well-known/oauth-protected-resource/v1/mcp",
      "GET /.well-known/oauth-authorization-server",
      "GET /.well-known/openid-configuration",
      "GET /.well-known/oauth-protected-resource",
      "POST /v1/oauth/register",
      "GET /v1/oauth/authorize",
      "POST /v1/oauth/authorize/consent",
      "POST /v1/oauth/token",
    ],
  },
  async (ctx) => {
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
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/mcp", rpc(1, "initialize"));
      r.status(401);
      const challenge = r.header("www-authenticate") ?? "";
      metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1] ?? "";
      if (metadataUrl !== `${issuer}/.well-known/oauth-protected-resource/v1/mcp`) throw new Error(`challenge: ${challenge}`);
      if (!challenge.includes('scope="kortix"')) throw new Error(`scope missing: ${challenge}`);
      if (challenge.includes("invalid_token")) throw new Error(`no token sent, yet invalid_token: ${challenge}`);
    });
    await ctx.step("a bad token → the same 401 challenge, not a bare error", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/mcp", rpc(1, "initialize"), {
        headers: { Authorization: "Bearer kortix_oat_not-a-real-token" },
      });
      r.status(401);
      const challenge = r.header("www-authenticate") ?? "";
      if (!challenge.includes("resource_metadata=")) throw new Error("no challenge on a bad token");
      // RFC 6750 3.1: a token that was sent and refused is `invalid_token`.
      if (!challenge.includes('error="invalid_token"')) throw new Error(`invalid_token missing: ${challenge}`);
    });
    await ctx.step("a token without the kortix scope → 403 insufficient_scope whose challenge names the scope to ask for", async () => {
      const redirectUri = "http://127.0.0.1:33417/callback";
      const reg = await ctx.client.as(ctx.P.ANON).post("/v1/oauth/register", { client_name: "Flow profile-only", redirect_uris: [redirectUri], scope: "profile" });
      reg.status(201).body().has("$.scope", "profile");
      const clientId = reg.json<any>().client_id;
      const { verifier, challenge: pkce } = await pkcePair();
      const authz = await ctx.client.as(ctx.P.ANON).get("/v1/oauth/authorize", {
        query: { client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: "profile", code_challenge: pkce, code_challenge_method: "S256" },
      });
      authz.status(302);
      const requestId = new URL(authz.header("location")!).searchParams.get("request_id")!;
      const ok = await ctx.client.as(ctx.P.OWNER).post("/v1/oauth/authorize/consent", { request_id: requestId, approved: true });
      const code = new URL(ok.json<any>().redirect_uri).searchParams.get("code")!;
      const tok = await ctx.client.as(ctx.P.ANON).post("/v1/oauth/token", form({ grant_type: "authorization_code", client_id: clientId, code, redirect_uri: redirectUri, code_verifier: verifier }));
      tok.status(200);
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/mcp", rpc(1, "initialize"), { headers: { Authorization: `Bearer ${tok.json<any>().access_token}` } });
      r.status(403);
      const challenge = r.header("www-authenticate") ?? "";
      if (!challenge.includes('error="insufficient_scope"') || !challenge.includes('scope="kortix"') || !challenge.includes("resource_metadata=")) {
        throw new Error(`403 challenge: ${challenge}`);
      }
    });
    await ctx.step("OIDC discovery path serves the authorization-server document; the root protected-resource path serves the MCP resource", async () => {
      const oidc = await ctx.client.as(ctx.P.ANON).get("/.well-known/openid-configuration");
      oidc.status(200).body().has("$.issuer", issuer).has("$.registration_endpoint", `${issuer}/v1/oauth/register`);
      const root = await ctx.client.as(ctx.P.ANON).get("/.well-known/oauth-protected-resource");
      root.status(200).body().has("$.resource", `${issuer}/v1/mcp`).has("$.authorization_servers[0]", issuer);
    });
    await ctx.step("RFC 9728 metadata names the MCP URL as the resource and Kortix as its authorization server", async () => {
      const r = await ctx.client.as(ctx.P.ANON).get("/.well-known/oauth-protected-resource/v1/mcp");
      r.status(200).body().has("$.resource", `${issuer}/v1/mcp`).has("$.authorization_servers[0]", issuer).has("$.scopes_supported[0]", "kortix");
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
  await ctx.step("unknown scopes (openid, offline_access, mcp:tools, admin) are ignored: known ones stay, none left → kortix", async () => {
    const some = await ctx.client.as(ctx.P.ANON).post("/v1/oauth/register", { redirect_uris: ["http://localhost:1/cb"], scope: "openid profile offline_access" });
    some.status(201).body().has("$.scope", "profile");
    const none = await ctx.client.as(ctx.P.ANON).post("/v1/oauth/register", { redirect_uris: ["http://localhost:1/cb"], scope: "mcp:tools admin" });
    none.status(201).body().has("$.scope", "kortix");
  });
});

// ── MCP-3: OAuth → tools ─────────────────────────────────────────────────────
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
      "POST /v1/mcp",
      "GET /v1/mcp",
      "DELETE /v1/mcp",
      "GET /v1/accounts",
      "GET /v1/projects",
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
    // A freshly created team account starts on no_subscription/0 credits: the
    // `read_session` tool step below creates a real session, which 503s with
    // `insufficient_credits` on an unfunded account (gate run 36497729410,
    // api shard 4, MCP-3). Fund it the same way every other flow that creates
    // a session under a fresh `ctx.fixtures.team()` does (secrets.flow.ts
    // SEC-POOL-4, config-releases.flow.ts, llm-gateway.flow.ts).
    if (ctx.env.target !== "local") {
      await ctx.step("fund the isolated account so its session can be created", async () => {
        await subscribe(ctx.env, ctx.client.as(ctx.P.OWNER), team.id);
      });
    }
    const p = await team.project({ seed: true });
    const redirectUri = "http://127.0.0.1:33419/callback";
    const { verifier, challenge } = await pkcePair();
    const issuer = (await ctx.client.as(ctx.P.ANON).get("/.well-known/oauth-authorization-server")).json<any>().issuer;
    const resource = `${issuer}/v1/mcp`;
    let clientId = "";
    let token = "";
    const mcp = (body: unknown, headers: Record<string, string> = {}) =>
      ctx.client.as(ctx.P.ANON).post("/v1/mcp", body, {
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
    await ctx.step("authorize edge cases: no scope and no resource → the registered scope; offline_access ignored; a foreign resource → error=invalid_target on the redirect; a known unregistered scope → error=invalid_scope", async () => {
      const authz = (extra: Record<string, string>) =>
        ctx.client.as(ctx.P.ANON).get("/v1/oauth/authorize", {
          query: { client_id: clientId, redirect_uri: redirectUri, response_type: "code", state: "st", code_challenge: challenge, code_challenge_method: "S256", ...extra },
        });
      const scopeOf = async (extra: Record<string, string>) => {
        const r = await authz(extra);
        r.status(302);
        const rid = new URL(r.header("location")!).searchParams.get("request_id") ?? "";
        if (!rid) throw new Error(`no request_id: ${r.header("location")}`);
        const meta = await ctx.client.as(ctx.P.OWNER).get("/v1/oauth/authorize/consent/:requestId", { params: { requestId: rid } });
        meta.status(200);
        return meta.json<any>().scope as string;
      };
      if ((await scopeOf({})) !== "kortix") throw new Error("no scope, no resource: not kortix");
      if ((await scopeOf({ scope: "offline_access openid kortix" })) !== "kortix") throw new Error("unknown scopes not ignored");
      for (const [extra, error] of [
        [{ resource: "https://evil.example.test/mcp" }, "invalid_target"],
        [{ scope: "email" }, "invalid_scope"],
      ] as const) {
        const r = await authz(extra);
        r.status(302);
        const back = new URL(r.header("location")!);
        if (back.origin + back.pathname !== redirectUri || back.searchParams.get("error") !== error || back.searchParams.get("state") !== "st") {
          throw new Error(`expected error=${error} on the redirect: ${back}`);
        }
      }
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
    await ctx.step("initialize → the requested protocol version, tools capability, instructions that start at list_projects (no feature flag)", async () => {
      const r = await mcp(rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "flow", version: "1" } }));
      r.status(200).body().has("$.result.protocolVersion", "2025-06-18").has("$.result.serverInfo.name", "kortix").exists("$.result.capabilities.tools");
      if (!r.json<any>().result.instructions.includes("list_projects")) throw new Error("instructions do not point at list_projects");
    });
    await ctx.step("notifications/initialized → 202; GET and DELETE → 405 (stateless: no stream, no session)", async () => {
      const n = await mcp({ jsonrpc: "2.0", method: "notifications/initialized" });
      n.status(202);
      const g = await ctx.client.as(ctx.P.ANON).get("/v1/mcp", { headers: { Authorization: `Bearer ${token}` } });
      g.status(405);
      const d = await ctx.client.as(ctx.P.ANON).del("/v1/mcp", { headers: { Authorization: `Bearer ${token}` } });
      d.status(405);
    });
    await ctx.step("tools/list → the thirteen session/API tools, the nine connector tools and `kortix`", async () => {
      const r = await mcp(rpc(2, "tools/list"));
      r.status(200);
      const names = r.json<any>().result.tools.map((t: { name: string }) => t.name).sort();
      const want = [
        "add_connector", "call_api", "call_connector", "connect_connector", "describe_api", "describe_connector_action", "kortix",
        "list_connectors", "list_files", "list_projects", "list_sessions", "read_file", "read_session", "read_skill",
        "remove_connector", "run_command", "search_api", "search_connector_actions", "search_connector_apps",
        "send_message", "start_session", "upload_connector_attachment", "write_file",
      ];
      if (JSON.stringify(names) !== JSON.stringify(want)) throw new Error(`tools: ${names}`);
      const tool = (name: string) => r.json<any>().result.tools.find((t: { name: string }) => t.name === name);
      if (!tool("read_file").inputSchema.properties.offset || !tool("read_file").inputSchema.properties.limit || !tool("list_files").inputSchema.properties.offset) {
        throw new Error("read_file / list_files lack offset and limit");
      }
      const hints = (name: string) => JSON.stringify(tool(name).annotations);
      if (hints("read_file") !== '{"readOnlyHint":true,"openWorldHint":false}' || hints("list_files") !== '{"readOnlyHint":true,"openWorldHint":false}') throw new Error("read annotations");
      if (!tool("write_file").annotations.idempotentHint || !tool("write_file").annotations.destructiveHint || !tool("run_command").annotations.destructiveHint) throw new Error("write annotations");
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
    await ctx.step("list_projects names the project; call_api runs as the user and fills {projectId} from project_id", async () => {
      const projects = JSON.parse(await toolText(30, "list_projects", {})) as Array<{ project_id: string; account_id: string; role: string | null }>;
      const listed = projects.find((x) => x.project_id === p.id && x.account_id === team.id);
      if (!listed) throw new Error(`list_projects: ${JSON.stringify(projects)}`);
      if (listed.role !== "manager") throw new Error(`list_projects role for the owner: ${JSON.stringify(listed.role)}`);
      const me = await mcp(rpc(5, "tools/call", { name: "call_api", arguments: { method: "GET", path: "/v1/accounts/me" } }));
      const text: string = me.json<any>().result.content[0].text;
      if (!text.startsWith("GET /v1/accounts/me → HTTP 200") || !text.includes('"auth_type":"oauth"')) throw new Error(`me: ${JSON.stringify(text.slice(0, 400))}`);
      const proj = await mcp(rpc(6, "tools/call", { name: "call_api", arguments: { method: "GET", path: "/v1/projects/{projectId}", project_id: p.id } }));
      const body: string = proj.json<any>().result.content[0].text;
      if (!body.startsWith(`GET /v1/projects/${p.id} → HTTP 200`) || !body.includes(p.id)) throw new Error(`project: ${JSON.stringify(body.slice(0, 400))}`);
      const noProject = await mcp(rpc(31, "tools/call", { name: "call_api", arguments: { method: "GET", path: "/v1/projects/{projectId}" } }));
      noProject.status(200).body().has("$.result.isError", true);
    });
    await ctx.step("call_api refuses /v1/oauth and MCP paths; a missing session is an isError 404", async () => {
      const oauth = await mcp(rpc(7, "tools/call", { name: "call_api", arguments: { method: "POST", path: "/v1/oauth/register" } }));
      oauth.status(200).body().has("$.result.isError", true);
      const loop = await mcp(rpc(8, "tools/call", { name: "call_api", arguments: { method: "POST", path: "/v1/mcp" } }));
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
    // Files the seeded repository lacks: a binary and a unicode name. The local
    // profile's repository is a bare directory, so a clone + push adds them.
    // Before the first repository read: the API mirrors the repository on read.
    let extraFiles = false;
    if (ctx.env.target === "local") {
      await ctx.step("commit a binary file and a unicode-named file to the project repository", async () => {
        const projects = JSON.parse(await toolText(40, "list_projects", {})) as Array<{ project_id: string; repository: string | null }>;
        const url = projects.find((x) => x.project_id === p.id)?.repository;
        if (!url) throw new Error("list_projects: no repository for the project");
        const dir = mkdtempSync(join(tmpdir(), "ke2e-mcp-"));
        try {
          const git = (...args: string[]) => {
            const r = spawnSync("git", ["-c", "user.name=KE2E", "-c", "user.email=ke2e@kortix.invalid", ...args], { cwd: dir, encoding: "utf8" });
            if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
          };
          git("clone", "-q", url, ".");
          writeFileSync(join(dir, "img.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]));
          mkdirSync(join(dir, "t"));
          writeFileSync(join(dir, "t", "ü ñ 日本.txt"), "unicode name\n");
          git("add", "-A");
          git("commit", "-qm", "add a binary and a unicode-named file");
          git("push", "-q", "origin", "HEAD");
          extraFiles = true;
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
    await ctx.step("list_files and read_file without a session read the project repository", async () => {
      const files = (await toolText(13, "list_files", { project_id: p.id })).split("\n");
      if (!files.includes("kortix.yaml")) throw new Error(`repo files: ${files.slice(0, 20)}`);
      const manifest = await toolText(14, "read_file", { path: "kortix.yaml", project_id: p.id });
      if (!manifest.includes("\n")) throw new Error(`kortix.yaml: ${JSON.stringify(manifest.slice(0, 200))}`);
      const missing = await mcp(rpc(15, "tools/call", { name: "read_file", arguments: { path: "no/such/file.txt", project_id: p.id } }));
      missing.status(200).body().has("$.result.isError", true);
    });
    await ctx.step("repository reads: a bad ref is a 404 on read and a named empty listing, paths and unicode names list cleanly, a binary is named, long text pages by offset, and no target says what to pass", async () => {
      const fail = async (id: number, name: string, args: Record<string, unknown>) => {
        const r = await mcp(rpc(id, "tools/call", { name, arguments: args }));
        const result = r.json<any>().result;
        if (!result.isError) throw new Error(`${name} ${JSON.stringify(args)} was not an error: ${JSON.stringify(result).slice(0, 200)}`);
        return result.content[0].text as string;
      };
      const badRef = await fail(41, "read_file", { path: "kortix.yaml", project_id: p.id, ref: "nope" });
      if (!badRef.startsWith("HTTP 404") || !badRef.includes("ref not found")) throw new Error(`read_file bad ref: ${badRef}`);
      const badList = await toolText(42, "list_files", { project_id: p.id, ref: "nope" });
      if (badList !== "No files at nope (or that ref does not exist).") throw new Error(`list_files bad ref: ${badList}`);
      const root = (await toolText(43, "list_files", { project_id: p.id, path: "/" })).split("\n");
      if (!root.includes("kortix.yaml")) throw new Error(`list_files path "/": ${root}`);
      const none = await toolText(44, "list_files", { project_id: p.id, path: "no-such-dir" });
      if (none !== "No files under no-such-dir at the default branch.") throw new Error(`empty listing: ${none}`);
      if (extraFiles) {
        const sub = await toolText(45, "list_files", { project_id: p.id, path: "/t" });
        if (sub !== "t/ü ñ 日本.txt") throw new Error(`unicode listing: ${JSON.stringify(sub)}`);
        const binary = await toolText(46, "read_file", { project_id: p.id, path: "img.png" });
        if (!binary.includes("binary file") || binary.includes("\uFFFD")) throw new Error(`binary read: ${JSON.stringify(binary)}`);
        const uni = await toolText(47, "read_file", { project_id: p.id, path: "t/ü ñ 日本.txt" });
        if (uni !== "unicode name") throw new Error(`unicode read: ${JSON.stringify(uni)}`);
      }
      const lines = (await toolText(48, "read_file", { project_id: p.id, path: "kortix.yaml" })).replace(/\n$/, "").split("\n");
      const first = await toolText(49, "read_file", { project_id: p.id, path: "kortix.yaml", limit: 2 });
      if (first !== `${lines.slice(0, 2).join("\n")}\n… ${lines.length - 2} more lines; call again with offset=2`) throw new Error(`first page: ${JSON.stringify(first)}`);
      const rest = await toolText(50, "read_file", { project_id: p.id, path: "kortix.yaml", offset: 2 });
      if (rest !== lines.slice(2).join("\n")) throw new Error(`offset page: ${JSON.stringify(rest)}`);
      for (const [id, name] of [[51, "list_files"], [52, "read_file"]] as const) {
        const t = await fail(id, name, name === "read_file" ? { path: "kortix.yaml" } : {});
        if (t !== "pass session_id (live sandbox) or project_id (repository)") throw new Error(`${name} with no target: ${t}`);
      }
      await fail(53, "read_file", { project_id: p.id, path: "kortix.yaml", offset: -1 });
    });
    await ctx.step("list_sessions → a JSON array; sandbox tools on a missing session → isError 404", async () => {
      if (!Array.isArray(JSON.parse(await toolText(16, "list_sessions", { project_id: p.id })).sessions)) throw new Error("list_sessions has no sessions array");
      for (const [id, name, args] of [
        [17, "run_command", { command: "true" }],
        [18, "list_files", {}],
        [19, "write_file", { path: "x.txt", content: "x" }],
      ] as const) {
        const r = await mcp(rpc(id, "tools/call", { name, arguments: { session_id: "00000000-0000-4000-a000-000000000000", ...args } }));
        const result = r.json<any>().result;
        if (!result.isError || !result.content[0].text.startsWith("HTTP 404")) throw new Error(`${name}: ${JSON.stringify(result)}`);
      }
      // A command runs as a job; its id is the 16-hex id a running result returned.
      for (const [id, args] of [
        [23, { job_id: "../../etc" }],
        [24, {}],
      ] as const) {
        const r = await mcp(rpc(id, "tools/call", { name: "run_command", arguments: { session_id: "00000000-0000-4000-a000-000000000000", ...args } }));
        const result = r.json<any>().result;
        if (!result.isError || result.content[0].text.startsWith("HTTP")) throw new Error(`run_command ${JSON.stringify(args)}: ${JSON.stringify(result)}`);
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
      const listed = (JSON.parse(await toolText(21, "list_sessions", { project_id: p.id })) as { sessions: Array<{ session_id: string; owner: string | null }> }).sessions;
      if (!listed.some((s) => s.session_id === session.id && s.owner)) throw new Error(`list_sessions: ${JSON.stringify(listed)}`);
      const read = JSON.parse(await toolText(22, "read_session", { session_id: session.id }));
      // The session_id alone finds its project: no project_id argument.
      if (read.session_id !== session.id || read.project_id !== p.id || !["idle", "running", "booting", "queued"].includes(read.turn) || !Array.isArray(read.messages)) {
        throw new Error(`read_session: ${JSON.stringify(read).slice(0, 400)}`);
      }
    });
    await ctx.step("tool calls are audited by the credential the API authenticated: an oauth_app named for the client, with its client id (never a reported client)", async () => {
      const correlationId = ctx.fixtures.name("mcp-audit");
      const r = await mcp(rpc(20, "tools/call", { name: "call_api", arguments: { method: "GET", path: "/v1/projects/{projectId}", project_id: p.id } }), {
        "x-correlation-id": correlationId,
        // A self-reported client changes nothing: the API never reads it.
        "x-kortix-client": "web",
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
      // The tool's own API call carries the OAuth token; the outer row is `mcp.request`.
      const read = events.find((e) => e.action === "project.read");
      if (
        read?.credential_kind !== "oauth_app" ||
        read.credential_id !== clientId ||
        read.credential_name !== "Flow MCP" ||
        read.client_reported_source != null
      ) {
        throw new Error(`audit: ${JSON.stringify(read)}`);
      }
    });
    await ctx.step("protocol: -32700 on bad JSON, -32600 on a batch / a wrong jsonrpc, 202 for a client response, -32602 for an unknown tool, latest version for an unknown one, 400 for a bad MCP-Protocol-Version", async () => {
      const raw = (body: string, headers: Record<string, string> = {}) =>
        fetch(`${ctx.env.apiUrl.replace(/\/v1$/, "")}/v1/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers }, body });
      const bad = await raw("{not json");
      const badBody: any = await bad.json();
      if (bad.status !== 400 || badBody.error.code !== -32700) throw new Error(`bad json: ${bad.status} ${JSON.stringify(badBody)}`);
      const batch = await raw(JSON.stringify([rpc(1, "ping"), rpc(2, "ping")]));
      const batchBody: any = await batch.json();
      if (batch.status !== 400 || batchBody.error.code !== -32600 || !/batch/i.test(batchBody.error.message)) throw new Error(`batch: ${JSON.stringify(batchBody)}`);
      const v1 = await raw(JSON.stringify({ id: 1, method: "ping" }));
      if (v1.status !== 400 || ((await v1.json()) as any).error.code !== -32600) throw new Error("a message without jsonrpc was accepted");
      const response = await raw(JSON.stringify({ jsonrpc: "2.0", id: 5, result: {} }));
      if (response.status !== 202) throw new Error(`client response: ${response.status}`);
      const unknown = await mcp(rpc(40, "tools/call", { name: "nope", arguments: {} }));
      unknown.status(200).body().has("$.error.code", -32602);
      const noName = await mcp(rpc(41, "tools/call", { name: { a: 1 } }));
      noName.status(200).body().has("$.error.code", -32602);
      const init = await mcp(rpc(42, "initialize", { protocolVersion: "1999-01-01" }));
      init.status(200).body().has("$.result.protocolVersion", "2025-11-25");
      const header = await raw(JSON.stringify(rpc(43, "ping")), { "MCP-Protocol-Version": "9999-01-01" });
      if (header.status !== 400) throw new Error(`bad MCP-Protocol-Version: ${header.status}`);
      const ok = await raw(JSON.stringify(rpc(44, "ping")), { "MCP-Protocol-Version": "2025-06-18" });
      if (ok.status !== 200) throw new Error(`good MCP-Protocol-Version: ${ok.status}`);
    });
    await ctx.step("tools/list: titles, and annotations that tell an approval UI what is safe", async () => {
      const tools = (await (await mcp(rpc(45, "tools/list"))).json<any>()).result.tools as Array<{ name: string; title?: string; annotations: Record<string, boolean> }>;
      const by = (n: string) => tools.find((t) => t.name === n)!;
      for (const n of ["list_projects", "start_session", "send_message", "read_session", "list_sessions", "read_skill", "search_api", "describe_api", "call_api"]) {
        if (!by(n).title || typeof by(n).annotations.readOnlyHint !== "boolean") throw new Error(`${n}: ${JSON.stringify(by(n))}`);
      }
      for (const n of ["list_projects", "read_session", "list_sessions", "read_skill", "search_api", "describe_api"]) {
        if (by(n).annotations.readOnlyHint !== true || by(n).annotations.openWorldHint !== false) throw new Error(`${n} annotations: ${JSON.stringify(by(n).annotations)}`);
      }
      for (const n of ["start_session", "send_message"]) if (by(n).annotations.destructiveHint !== false) throw new Error(`${n} is not marked non-destructive`);
      if (by("call_api").annotations.destructiveHint !== true) throw new Error("call_api must stay destructive");
      const body = (by("call_api") as any).inputSchema.properties.body;
      if (body.type !== "object") throw new Error(`call_api body schema: ${JSON.stringify(body)}`);
    });
    await ctx.step("call_api: no bypass of the /v1/oauth and MCP block by dot segments, %-escapes or double slashes", async () => {
      for (const path of ["/v1/projects/../oauth/grants", "/v1/%6fauth/grants", "/v1/projects/%2e%2e/oauth/grants", "/v1/%6dcp", "/v1//oauth/grants"]) {
        const r = await mcp(rpc(46, "tools/call", { name: "call_api", arguments: { method: "GET", path } }));
        const result = r.json<any>().result;
        if (!result.isError || !result.content[0].text.startsWith("path must")) throw new Error(`${path}: ${JSON.stringify(result).slice(0, 200)}`);
      }
    });
    await ctx.step("call_api: a JSON-string body is parsed (not double-encoded); an unfilled {name} is refused naming it; the result leads with METHOD path; array query values repeat", async () => {
      const name = `MCP_FLOW_${Date.now()}`;
      const created = await mcp(rpc(47, "tools/call", { name: "call_api", arguments: { method: "POST", path: "/v1/projects/{projectId}/secrets", project_id: p.id, body: JSON.stringify({ name, value: "x" }) } }));
      const createdText: string = created.json<any>().result.content[0].text;
      if (!createdText.startsWith(`POST /v1/projects/${p.id}/secrets → HTTP 2`)) throw new Error(`string body: ${createdText.slice(0, 300)}`);
      const open = await mcp(rpc(48, "tools/call", { name: "call_api", arguments: { method: "DELETE", path: "/v1/projects/{projectId}/secrets/{name}", project_id: p.id } }));
      const openResult = open.json<any>().result;
      if (!openResult.isError || !openResult.content[0].text.includes("{name}")) throw new Error(`unfilled: ${JSON.stringify(openResult)}`);
      const del = await mcp(rpc(49, "tools/call", { name: "call_api", arguments: { method: "DELETE", path: `/v1/projects/{projectId}/secrets/${name}`, project_id: p.id } }));
      if (!del.json<any>().result.content[0].text.startsWith(`DELETE /v1/projects/${p.id}/secrets/${name} → HTTP 200`)) throw new Error("secret delete failed");
      const repeat = await mcp(rpc(50, "tools/call", { name: "call_api", arguments: { method: "GET", path: "/v1/projects", query: { account_id: [team.id, team.id] } } }));
      if (repeat.json<any>().result.isError) throw new Error(`array query: ${JSON.stringify(repeat.json<any>().result).slice(0, 200)}`);
    });
    await ctx.step("list_sessions pages: limit=1 returns next_cursor, the cursor returns the next session; created_at and branch are present; a non-numeric limit is isError", async () => {
      const a = await ctx.fixtures.session(p);
      const b = await ctx.fixtures.session(p);
      const first = JSON.parse(await toolText(51, "list_sessions", { project_id: p.id, limit: 1 })) as { sessions: any[]; next_cursor: string | null };
      if (first.sessions.length !== 1 || !first.next_cursor || !first.sessions[0].created_at || !("branch" in first.sessions[0])) throw new Error(`page 1: ${JSON.stringify(first)}`);
      const second = JSON.parse(await toolText(52, "list_sessions", { project_id: p.id, limit: 1, cursor: first.next_cursor })) as { sessions: any[] };
      if (second.sessions.length !== 1 || second.sessions[0].session_id === first.sessions[0].session_id) throw new Error(`page 2: ${JSON.stringify(second)}`);
      void a; void b;
      const bad = await mcp(rpc(53, "tools/call", { name: "list_sessions", arguments: { project_id: p.id, limit: "abc" } }));
      bad.status(200).body().has("$.result.isError", true);
    });
    await ctx.step("search_api: a stopword or a 1-letter term matches nothing; `secret` finds the secrets routes", async () => {
      const none = await toolText(54, "search_api", { query: "a the" });
      if (!none.startsWith("No matching routes")) throw new Error(`stopwords: ${none.slice(0, 200)}`);
      const hits = await toolText(55, "search_api", { query: "set a secret" });
      if (!hits.includes("/v1/projects/{projectId}/secrets")) throw new Error(`secret: ${hits.slice(0, 300)}`);
    });
    await ctx.step("an unknown JSON-RPC method → -32601", async () => {
      const r = await mcp(rpc(10, "resources/list"));
      r.status(200).body().has("$.error.code", -32601);
    });
  },
);

// ── MCP-4: one server per person, like the CLI ───────────────────────────────
// The endpoint is bound to the token, never to a project: a `kortix_pat_` (the
// CLI's token) works as the Bearer, one connection reaches projects in every
// account the user belongs to, and a session in someone else's account is the
// same 404 as a session that does not exist.
flow(
  "MCP-4",
  {
    domain: "mcp",
    routes: ["POST /v1/accounts/tokens", "POST /v1/mcp", "GET /v1/accounts", "GET /v1/projects", "GET /v1/projects/:projectId/files"],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const personal = await ctx.fixtures.project({ seed: true });
    const teamProject = await team.project({ seed: true });
    const personalSession = await ctx.fixtures.session(personal);
    let pat = "";
    let outsiderPat = "";
    const mcp = (body: unknown, token = pat) => ctx.client.as(ctx.P.ANON).post("/v1/mcp", body, { headers: { Authorization: `Bearer ${token}` } });
    const tool = async (id: number, name: string, args: Record<string, unknown>, token = pat) =>
      (await mcp(rpc(id, "tools/call", { name, arguments: args }), token)).json<any>().result as { isError?: boolean; content: Array<{ text: string }> };

    await ctx.step("a kortix_pat_ (the CLI's token) opens the MCP server with no OAuth", async () => {
      const created = await ctx.client.as(ctx.P.OWNER).post("/v1/accounts/tokens", { name: "MCP-4 flow" });
      created.status(201);
      pat = created.json<{ secret_key: string }>().secret_key;
      if (!pat.startsWith("kortix_pat_")) throw new Error(`not a PAT: ${pat.slice(0, 11)}`);
      const r = await mcp(rpc(1, "initialize", { protocolVersion: "2025-06-18" }));
      r.status(200).body().has("$.result.serverInfo.name", "kortix");
    });
    await ctx.step("list_projects spans both accounts: the personal project and the team project", async () => {
      const result = await tool(2, "list_projects", {});
      if (result.isError) throw new Error(result.content[0]!.text);
      const ids = (JSON.parse(result.content[0]!.text) as Array<{ project_id: string }>).map((x) => x.project_id);
      for (const want of [personal.id, teamProject.id]) if (!ids.includes(want)) throw new Error(`missing ${want} in ${ids}`);
    });
    await ctx.step("the same connection reads the repository of each project by project_id", async () => {
      for (const [id, project] of [[3, personal], [4, teamProject]] as const) {
        const result = await tool(id, "list_files", { project_id: project.id });
        if (result.isError || !result.content[0]!.text.split("\n").includes("kortix.yaml")) throw new Error(`${project.id}: ${result.content[0]!.text.slice(0, 200)}`);
      }
    });
    // The API itself answers 403 for a project in another account and 404 for a
    // missing one, to every client; the MCP adds nothing to that. What it must
    // never do is reach the data, or name the project in the refusal.
    await ctx.step("to an outsider's MCP connection, OWNER's project and session are refused and never named", async () => {
      const created = await ctx.client.as(ctx.P.NONMEMBER).post("/v1/accounts/tokens", { name: "MCP-4 outsider" });
      created.status(201);
      outsiderPat = created.json<{ secret_key: string }>().secret_key;
      const listed = await tool(5, "list_projects", {}, outsiderPat);
      if (listed.content[0]!.text.includes(personal.id) || listed.content[0]!.text.includes(teamProject.id)) throw new Error("list_projects leaked OWNER's projects");
      const files = await tool(6, "list_files", { project_id: personal.id }, outsiderPat);
      const refused = (r: { isError?: boolean; content: Array<{ text: string }> }) => !!r.isError && /^HTTP 40[34]\n/.test(r.content[0]!.text);
      if (!refused(files)) throw new Error(`foreign project: ${JSON.stringify(files)}`);
      const foreignRead = await tool(7, "read_session", { session_id: personalSession.id }, outsiderPat);
      const missingRead = await tool(8, "read_session", { session_id: "00000000-0000-4000-a000-000000000000" }, outsiderPat);
      for (const [label, r] of [["foreign", foreignRead], ["missing", missingRead]] as const) {
        if (!refused(r)) throw new Error(`${label} session: ${JSON.stringify(r)}`);
      }
      if (foreignRead.content[0]!.text.includes(personal.id)) throw new Error("the 404 names OWNER's project");
      // The owner's own connection reads the same session by session_id alone.
      const own = await tool(9, "read_session", { session_id: personalSession.id });
      if (own.isError || JSON.parse(own.content[0]!.text).project_id !== personal.id) throw new Error(`own session: ${JSON.stringify(own)}`);
    });
  },
);

// ── MCP-5: the project's connectors, through MCP ─────────────────────────────
// `kortix connectors` as MCP tools: list → search → describe → call, the gateway's
// approval and policy answers relayed intact, an attachment staged, an outsider
// refused. Every tool calls the connector REST routes in-process as the token.
flow(
  "MCP-5",
  {
    domain: "mcp",
    requires: ["database"],
    timeoutMs: 120_000,
    routes: [
      "POST /v1/accounts/tokens",
      "POST /v1/mcp",
      "GET /v1/connectors/projects/:projectId/catalog",
      "GET /v1/connectors/projects/:projectId/connectors",
      "GET /v1/connectors/projects/:projectId/connectors/:slug/accounts",
      "POST /v1/connectors/projects/:projectId/call",
      "POST /v1/connectors/projects/:projectId/attachments",
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const p = await team.project();
    const { createServer } = await import("node:http");
    const { Client: PgClient } = await import("pg");
    const databaseUrl = ctx.env.databaseUrl as string;
    const local = databaseUrl.includes("localhost") || databaseUrl.includes("127.0.0.1");
    const db = new PgClient({ connectionString: databaseUrl, ssl: local ? false : { rejectUnauthorized: false } });
    const hits: string[] = [];
    const upstream = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url?.startsWith("/big") ? { rows: "x".repeat(90_000) } : { items: [{ id: 1, name: "widget" }] }));
    });
    const port = await new Promise<number>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve((upstream.address() as { port: number }).port)));
    const slug = `ke2e-mcp-${Date.now().toString(36)}`;
    const idle = `${slug}-idle`;
    let pat = "";
    let outsiderPat = "";
    const mcp = (id: number, name: string, args: Record<string, unknown>, token = pat) =>
      ctx.client.as(ctx.P.ANON).post("/v1/mcp", rpc(id, "tools/call", { name, arguments: args }), { headers: { Authorization: `Bearer ${token}` } });
    const tool = async (id: number, name: string, args: Record<string, unknown>, token = pat) => {
      const r = await mcp(id, name, args, token);
      r.status(200);
      const result = r.json<any>().result as { isError?: boolean; content: Array<{ text: string }> };
      return { isError: !!result.isError, text: result.content[0]!.text, json: () => JSON.parse(result.content[0]!.text) };
    };
    const insertAction = (connectorId: string, path: string, description: string, risk: string, schema: unknown, binding: unknown) =>
      db.query(`INSERT INTO kortix.connector_actions (connector_id, path, name, description, input_schema, risk, binding) VALUES ($1, $2, $2, $3, $4::jsonb, $5, $6::jsonb)`, [
        connectorId, path, description, JSON.stringify(schema), risk, JSON.stringify(binding),
      ]);

    try {
      await db.connect();
      await ctx.step("mint an owner token and an outsider token (the CLI's kortix_pat_)", async () => {
        for (const [who, name] of [[ctx.P.OWNER, "owner"], [ctx.P.NONMEMBER, "outsider"]] as const) {
          const created = await ctx.client.as(who).post("/v1/accounts/tokens", { name: `MCP-5 ${name}` });
          created.status(201);
          if (name === "owner") pat = created.json<{ secret_key: string }>().secret_key;
          else outsiderPat = created.json<{ secret_key: string }>().secret_key;
        }
      });
      await ctx.step("tools/list carries the nine connector tools with titles and honest annotations", async () => {
        const r = await ctx.client.as(ctx.P.ANON).post("/v1/mcp", rpc(1, "tools/list"), { headers: { Authorization: `Bearer ${pat}` } });
        const tools = r.json<any>().result.tools as Array<{ name: string; title?: string; description: string; annotations: Record<string, boolean>; inputSchema: { additionalProperties?: boolean } }>;
        const by = (n: string) => tools.find((t) => t.name === n)!;
        const readOnly = ["list_connectors", "search_connector_actions", "describe_connector_action", "search_connector_apps"];
        const writes = ["call_connector", "upload_connector_attachment", "connect_connector", "add_connector", "remove_connector"];
        for (const n of [...readOnly, ...writes]) {
          if (!by(n)?.title || by(n).description.length < 80 || by(n).inputSchema.additionalProperties !== false) throw new Error(`${n}: ${JSON.stringify(by(n))?.slice(0, 200)}`);
        }
        for (const n of readOnly) if (by(n).annotations.readOnlyHint !== true) throw new Error(`${n} must be readOnly`);
        for (const n of ["call_connector", "remove_connector"]) if (by(n).annotations.destructiveHint !== true) throw new Error(`${n} must be destructive`);
        if (by("call_connector").annotations.openWorldHint !== true) throw new Error("call_connector reaches the outside world");
        if (by("upload_connector_attachment").annotations.destructiveHint !== false) throw new Error("upload is not destructive");
      });
      await ctx.step("seed one connected OpenAPI connector (read, write, destructive, big-result actions) and one never-connected one", async () => {
        const seeded = await db.query<{ connector_id: string }>(
          `INSERT INTO kortix.connectors (account_id, project_id, slug, name, provider_type, config, status)
           VALUES ($1, $2, $3, 'KE2E Warehouse', 'openapi', $4::jsonb, 'active') RETURNING connector_id`,
          [team.id, p.id, slug, JSON.stringify({ auth: { type: "none" } })],
        );
        const id = seeded.rows[0]!.connector_id;
        await db.query(
          `INSERT INTO kortix.connector_connections (account_id, project_id, connector_id, owner_type, label, status, is_default, metadata)
           VALUES ($1, $2, $3, 'project', 'Warehouse team', 'active', true, $4::jsonb)`,
          [team.id, p.id, id, JSON.stringify({ provider: "openapi", connector_slug: slug })],
        );
        const server = `http://127.0.0.1:${port}`;
        const empty = { type: "object", properties: {} };
        await insertAction(id, "list_items", "List the widgets stored in the warehouse", "read", { type: "object", properties: { limit: { type: "number" } } }, { kind: "openapi", method: "GET", path: "/items", server });
        await insertAction(id, "big_report", "Download the full stock report", "read", empty, { kind: "openapi", method: "GET", path: "/big", server });
        await insertAction(id, "send_note", "Send a note to the warehouse team", "write", { type: "object", properties: { body: { type: "object", properties: { text: { type: "string" } } } } }, { kind: "openapi", method: "POST", path: "/notes", server });
        await insertAction(id, "purge", "Delete every widget", "destructive", empty, { kind: "openapi", method: "DELETE", path: "/items", server });
        // A fresh project runs every action (default_mode allow_all): the two policies make one ask and one block.
        await db.query(`INSERT INTO kortix.connector_policies (connector_id, match, action, position) VALUES ($1, 'purge', 'block', 0), ($1, 'send_note', 'require_approval', 1)`, [id]);
        // Needs a credential nobody stored: listed by the admin route, never usable.
        await db.query(
          `INSERT INTO kortix.connectors (account_id, project_id, slug, name, provider_type, config, status)
           VALUES ($1, $2, $3, 'KE2E Idle', 'openapi', $4::jsonb, 'needs_auth')`,
          [team.id, p.id, idle, JSON.stringify({ auth: { type: "bearer" } })],
        );
      });
      await ctx.step("list_connectors: the connected connector shows its account and action count; the idle one says how to connect it", async () => {
        const all = (await tool(2, "list_connectors", { project_id: p.id })).json().connectors as Array<Record<string, any>>;
        const live = all.find((c) => c.slug === slug);
        const dead = all.find((c) => c.slug === idle);
        if (!live?.connected || live.provider !== "openapi") throw new Error(`live: ${JSON.stringify(live)}`);
        if (live.accounts[0]?.label !== "Warehouse team" || live.accounts[0].owner !== "shared" || live.default_account !== "Warehouse team") throw new Error(`accounts: ${JSON.stringify(live.accounts)}`);
        if (dead?.connected !== false || !String(dead.next).includes("connect_connector")) throw new Error(`idle: ${JSON.stringify(dead)}`);
        const one = (await tool(3, "list_connectors", { project_id: p.id, connector: slug })).json().connectors as Array<Record<string, any>>;
        if (one.length !== 1 || one[0]!.accounts[0].connection_id === undefined || one[0]!.accounts[0].default !== true) throw new Error(`one: ${JSON.stringify(one)}`);
        const missing = await tool(4, "list_connectors", { project_id: p.id, connector: "no-such-connector" });
        if (!missing.isError) throw new Error("an unknown connector must be isError");
      });
      await ctx.step("search_connector_actions finds the action by intent, ranks by phrase, carries risk, and never a schema", async () => {
        const r = (await tool(5, "search_connector_actions", { project_id: p.id, query: "widgets warehouse" })).json();
        const top = r.matches.find((m: any) => m.tool === `${slug}.list_items`);
        if (!top || top.risk !== "read" || !top.description.includes("widgets")) throw new Error(`search: ${JSON.stringify(r)}`);
        if (JSON.stringify(r).includes("input_schema") || JSON.stringify(r).includes("inputSchema")) throw new Error("search returned a schema");
        const scoped = (await tool(6, "search_connector_actions", { project_id: p.id, connector: slug, limit: 1 })).json();
        if (scoped.matches.length !== 1 || scoped.total < 3 || !scoped.more) throw new Error(`limit: ${JSON.stringify(scoped)}`);
        const none = (await tool(7, "search_connector_actions", { project_id: p.id, query: "zzzz-nothing" })).json();
        if (none.total !== 0 || !none.note) throw new Error(`no match: ${JSON.stringify(none)}`);
      });
      await ctx.step("describe_connector_action returns the input schema and risk; an unknown action names the fix", async () => {
        const r = (await tool(8, "describe_connector_action", { project_id: p.id, tool: `${slug}.list_items` })).json();
        if (r.risk !== "read" || r.input_schema?.properties?.limit?.type !== "number" || r.accounts[0]?.label !== "Warehouse team") throw new Error(`describe: ${JSON.stringify(r)}`);
        const bad = await tool(9, "describe_connector_action", { project_id: p.id, tool: `${slug}.nope` });
        if (!bad.isError || !bad.text.includes("search_connector_actions")) throw new Error(`unknown action: ${bad.text}`);
        const malformed = await tool(10, "describe_connector_action", { project_id: p.id, tool: "nodot" });
        if (!malformed.isError) throw new Error("a tool without a dot must be isError");
      });
      await ctx.step("call_connector runs the read action and returns its data and the account that ran it", async () => {
        const before = hits.length;
        const r = await tool(11, "call_connector", { project_id: p.id, tool: `${slug}.list_items`, args: JSON.stringify({ limit: 5 }) });
        const body = r.json();
        if (r.isError || body.ok !== true || body.data?.items?.[0]?.name !== "widget" || body.account?.label !== "Warehouse team" || body.risk !== "read") throw new Error(`call: ${r.text}`);
        if (hits.length !== before + 1 || !hits.at(-1)!.startsWith("GET /items")) throw new Error(`upstream: ${hits.at(-1)}`);
        const wrong = await tool(12, "call_connector", { project_id: p.id, tool: `${slug}.list_items`, account: "No such account" });
        if (!wrong.isError || wrong.json().reason !== "connector_not_connected" || wrong.json().available_accounts?.[0] !== "Warehouse team" || !wrong.json().next) throw new Error(`wrong account: ${wrong.text}`);
      });
      await ctx.step("a result over the cap is replaced by a marked preview: the reply stays valid JSON", async () => {
        const r = await tool(13, "call_connector", { project_id: p.id, tool: `${slug}.big_report` });
        const body = r.json();
        if (r.isError || body.data_truncated !== true || body.data_chars < 90_000 || body.data_preview.length > 40_000 || !String(body.note).includes("Narrow")) throw new Error(`big: ${r.text.slice(0, 300)}`);
        if (body.ok !== true || body.account?.label !== "Warehouse team") throw new Error("the head of a truncated result lost its account");
      });
      await ctx.step("a write is held for approval: the link and the summary come back, the reason is stored for the approver, the upstream is untouched", async () => {
        const before = hits.length;
        const reason = "Tell the warehouse team the delivery is late";
        const r = await tool(14, "call_connector", { project_id: p.id, tool: `${slug}.send_note`, args: { body: { text: "late" } }, reason });
        const body = r.json();
        if (r.isError || body.status !== "pending_approval" || !body.execution_id || !body.next.includes("same tool")) throw new Error(`pending: ${r.text}`);
        if (ctx.env.target === "local" && !String(body.approval_url ?? "").includes("/")) throw new Error(`no approval link: ${r.text}`);
        if (hits.length !== before) throw new Error("the upstream ran before approval");
        const row = await db.query<{ result_summary: { approval_context?: string } }>(`SELECT result_summary FROM kortix.connector_calls WHERE execution_id = $1`, [body.execution_id]);
        if (row.rows[0]?.result_summary?.approval_context !== reason) throw new Error(`reason not stored: ${JSON.stringify(row.rows)}`);
      });
      await ctx.step("a policy block is a denial with its reason and 'do not retry'", async () => {
        const r = await tool(15, "call_connector", { project_id: p.id, tool: `${slug}.purge` });
        const body = r.json();
        if (!r.isError || body.status !== "denied" || body.reason !== "policy_block" || !body.next.includes("Do not retry")) throw new Error(`block: ${r.text}`);
      });
      await ctx.step("upload_connector_attachment stages base64 and returns the $kortix_attachment ref with where to put it", async () => {
        const bytes = Buffer.from("weekly report ✓");
        const r = await tool(16, "upload_connector_attachment", { project_id: p.id, connector: slug, filename: "weekly report.txt", content_type: "text/plain", content_base64: bytes.toString("base64") });
        const body = r.json();
        if (r.isError || body.ref?.$kortix_attachment !== body.attachment_id || body.size !== bytes.byteLength || body.filename !== "weekly report.txt" || !body.use.includes("attachments[]")) throw new Error(`upload: ${r.text}`);
        const junk = await tool(17, "upload_connector_attachment", { project_id: p.id, connector: slug, filename: "x.txt", content_base64: "not base64!!" });
        if (!junk.isError || !junk.text.includes("base64")) throw new Error(`bad base64: ${junk.text}`);
        const neither = await tool(18, "upload_connector_attachment", { project_id: p.id, connector: slug, filename: "x.txt" });
        if (!neither.isError) throw new Error("no content must be isError");
      });
      await ctx.step("connect_connector on a connector that does not exist is refused with the API's answer, not a url", async () => {
        const r = await tool(19, "connect_connector", { project_id: p.id, connector: "no-such-connector" });
        if (!r.isError || r.text.includes("\"url\"")) throw new Error(`connect: ${r.text}`);
      });
      await ctx.step("an outsider's token reaches none of it: list, search, describe, call, upload, add and remove are all refused, and the upstream never runs", async () => {
        const before = hits.length;
        for (const [id, name, args] of [
          [20, "list_connectors", {}],
          [21, "search_connector_actions", { query: "widgets" }],
          [22, "describe_connector_action", { tool: `${slug}.list_items` }],
          [23, "call_connector", { tool: `${slug}.list_items` }],
          [24, "upload_connector_attachment", { connector: slug, filename: "x.txt", content_base64: "eA==" }],
          [25, "add_connector", { provider: "http", slug: "intruder", base_url: "https://example.com" }],
          [26, "remove_connector", { connector: slug }],
        ] as const) {
          const r = await tool(id, name, { project_id: p.id, ...args }, outsiderPat);
          if (!r.isError || !/HTTP 40[34]/.test(r.text) && !/forbidden|Not found/i.test(r.text) || r.text.includes("widget")) throw new Error(`${name}: ${r.text.slice(0, 200)}`);
        }
        if (hits.length !== before) throw new Error("an outsider's call reached the upstream");
      });
    } finally {
      upstream.close();
      await db.query(`DELETE FROM kortix.connectors WHERE project_id = $1 AND slug IN ($2, $3)`, [p.id, slug, idle]).catch(() => {});
      await db.end().catch(() => {});
    }
  },
);

// ── MCP-6: the whole CLI through MCP ─────────────────────────────────────────
// The `kortix` tool runs the real CLI as the token holder: exit code, stdout and
// stderr come back, the credential is the caller's own, machine-local commands
// are refused before anything starts, and a project's own skills are readable.
flow(
  "MCP-6",
  {
    domain: "mcp",
    requires: ["database"],
    timeoutMs: 180_000,
    routes: ["POST /v1/accounts/tokens", "POST /v1/mcp", "GET /v1/projects/:projectId/detail", "GET /v1/projects/:projectId/files/content"],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const p = await team.project({ seed: true });
    let pat = "";
    let outsiderPat = "";
    const call = async (id: number, name: string, args: Record<string, unknown>, token = pat) => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/mcp", rpc(id, "tools/call", { name, arguments: args }), { headers: { Authorization: `Bearer ${token}` } });
      r.status(200);
      const body = r.json<any>();
      if (!body.result) throw new Error(`${name} ${JSON.stringify(args).slice(0, 80)}: JSON-RPC error ${JSON.stringify(body.error)}`);
      const result = body.result as { isError?: boolean; content: Array<{ text: string }> };
      return { isError: !!result.isError, text: result.content[0]!.text };
    };
    /** `kortix <args>`: the tool's JSON reply, or the refusal text. */
    const cli = async (id: number, args: string[], extra: Record<string, unknown> = {}, token = pat) => {
      const r = await call(id, "kortix", { args, ...extra }, token);
      let out: { exit_code: number | null; stdout: string; json?: any; stderr: string; timed_out?: string; truncated?: string } | null = null;
      try {
        out = JSON.parse(r.text);
      } catch {
        // a refusal is plain text
      }
      return { ...r, out };
    };

    await ctx.step("mint an owner token and an outsider token", async () => {
      for (const [who, name] of [[ctx.P.OWNER, "owner"], [ctx.P.NONMEMBER, "outsider"]] as const) {
        const created = await ctx.client.as(who).post("/v1/accounts/tokens", { name: `MCP-6 ${name}` });
        created.status(201);
        if (name === "owner") pat = created.json<{ secret_key: string }>().secret_key;
        else outsiderPat = created.json<{ secret_key: string }>().secret_key;
      }
    });
    await ctx.step("commit one project skill with a reference file to the project repository (the API mirror picks it up within 60 s: later steps wait for it)", async () => {
      const world = await AgentPrincipalsWorld.open(ctx, { accountId: team.id, projectId: p.id });
      try {
        await world.commitToMain(
          {
            "skills/mcp-demo/SKILL.md": "---\nname: mcp-demo\ndescription: Demo skill for the MCP flow\n---\n# MCP demo\nUse the demo.\n",
            "skills/mcp-demo/references/notes.md": "reference notes\n",
          },
          "ke2e MCP-6: a project skill",
        );
      } finally {
        await world.close();
      }
    });
    await ctx.step("tools/list: `kortix` takes args (required), project_id and session_id, and its description teaches discovery and the refusals", async () => {
      const r = await ctx.client.as(ctx.P.ANON).post("/v1/mcp", rpc(1, "tools/list"), { headers: { Authorization: `Bearer ${pat}` } });
      const tool = r.json<any>().result.tools.find((t: { name: string }) => t.name === "kortix");
      if (!tool?.title || tool.inputSchema.required?.join() !== "args" || tool.inputSchema.additionalProperties !== false) throw new Error(JSON.stringify(tool)?.slice(0, 300));
      for (const k of ["args", "project_id", "session_id"]) if (!tool.inputSchema.properties[k]) throw new Error(`no ${k}`);
      for (const word of ["--help", "--json", "start_session", "--host", "apps deploy"]) if (!tool.description.includes(word)) throw new Error(`description lacks ${word}`);
      const init = await ctx.client.as(ctx.P.ANON).post("/v1/mcp", rpc(2, "initialize", { protocolVersion: "2025-06-18" }), { headers: { Authorization: `Bearer ${pat}` } });
      if (!String(init.json<any>().result.instructions).includes("`kortix` tool")) throw new Error("instructions do not name the kortix tool");
    });
    await ctx.step("[\"--help\"] lists the command groups; [\"secrets\",\"--help\"] lists its subcommands", async () => {
      const top = await cli(3, ["--help"]);
      if (top.isError || top.out?.exit_code !== 0) throw new Error(top.text.slice(0, 300));
      for (const group of ["secrets", "triggers", "cr", "sessions", "system-skills", "connectors", "billing"]) if (!top.out!.stdout.includes(group)) throw new Error(`--help lacks ${group}`);
      const secrets = await cli(4, ["secrets", "--help"]);
      if (secrets.out?.exit_code !== 0 || !secrets.out.stdout.includes("ls")) throw new Error(secrets.text.slice(0, 300));
    });
    await ctx.step("[\"whoami\",\"--json\"] answers as the token's user through this API", async () => {
      const r = await cli(5, ["whoami", "--json"]);
      if (r.isError || r.out?.exit_code !== 0) throw new Error(r.text.slice(0, 500));
      // `--json` output arrives as a JSON value (`json`), never as a cut string, even for a user with many accounts.
      if (r.out.json === undefined || r.out.truncated) throw new Error(`whoami --json is not whole JSON: ${r.text.slice(0, 300)}`);
      const who = r.out.json;
      const me = JSON.parse((await call(6, "call_api", { method: "GET", path: "/v1/accounts/me" })).text.split("\n").slice(1).join("\n"));
      const id = who.user_id ?? who.user?.user_id ?? who.user?.id;
      if (!id || ![me.user_id, me.id, me.user?.id, me.user?.user_id].includes(id)) throw new Error(`whoami ${JSON.stringify(who).slice(0, 300)} vs me ${JSON.stringify(me).slice(0, 300)}`);
    });
    await ctx.step("secrets set then ls with project_id: the key is listed, the value is in no output", async () => {
      const value = `mcp-secret-${Date.now().toString(36)}`;
      const set = await cli(7, ["secrets", "set", `MCP_T=${value}`], { project_id: p.id });
      if (set.isError || set.out?.exit_code !== 0) throw new Error(set.text.slice(0, 500));
      const ls = await cli(8, ["secrets", "ls", "--json"], { project_id: p.id });
      if (ls.isError || !JSON.stringify(ls.out!.json ?? ls.out!.stdout).includes("MCP_T")) throw new Error(ls.text.slice(0, 500));
      if (ls.text.includes(value) || set.text.includes(value)) throw new Error("the secret value appeared in a tool result");
      const without = await cli(9, ["secrets", "ls", "--json"]);
      if (JSON.stringify(without.out?.json ?? without.out?.stdout ?? "").includes("MCP_T") && without.out?.exit_code === 0) throw new Error("secrets ls without a project answered for one");
      await cli(10, ["secrets", "rm", "MCP_T", "--yes"], { project_id: p.id });
    });
    await ctx.step("triggers ls, system-skills and a failing command: exit code and stderr come back, a non-zero exit is isError", async () => {
      const triggers = await cli(11, ["triggers", "ls", "--json"], { project_id: p.id });
      if (triggers.isError || triggers.out?.exit_code !== 0) throw new Error(triggers.text.slice(0, 400));
      if (triggers.out.json === undefined) throw new Error(`triggers ls --json is not a JSON value: ${triggers.text.slice(0, 300)}`);
      const skills = await cli(12, ["system-skills"]);
      if (skills.isError || !skills.out?.stdout.includes("kortix-system")) throw new Error(skills.text.slice(0, 400));
      const bad = await cli(13, ["secrets", "no-such-subcommand"]);
      if (!bad.isError || !bad.out || bad.out.exit_code === 0 || !(bad.out.stderr + (bad.out.stdout ?? "")).trim()) throw new Error(bad.text.slice(0, 300));
      const unknown = await cli(29, ["no-such-command"]);
      if (!unknown.isError || !unknown.text.includes("not a kortix command")) throw new Error(`unknown command: ${unknown.text.slice(0, 300)}`);
      const leadingFlag = await cli(30, ["--project", p.id, "update"]);
      if (!leadingFlag.isError || !leadingFlag.text.includes("not a kortix command")) throw new Error(`leading flag: ${leadingFlag.text.slice(0, 300)}`);
    });
    await ctx.step("refused before any process starts: --host, login, ship, token, env pull, apps deploy, chat without --prompt — each with the reason and the alternative", async () => {
      for (const [id, args, alternative] of [
        [14, ["--host", "x", "whoami"], "already acts as you"],
        [15, ["whoami", "--host=evil"], "already acts as you"],
        [16, ["login"], "already signed in"],
        [17, ["ship"], "run_command in a session sandbox"],
        [18, ["token"], "whoami --json"],
        [19, ["env", "pull"], "secrets"],
        [20, ["apps", "deploy", "."], "run_command in a session sandbox"],
        [21, ["chat"], "start_session"],
      ] as const) {
        const r = await cli(id, [...args]);
        if (!r.isError || r.out || !r.text.startsWith("Refused:") || !r.text.includes(alternative)) throw new Error(`${args.join(" ")}: ${r.text.slice(0, 300)}`);
      }
      const bad = await call(22, "kortix", { args: "whoami" });
      if (!bad.isError || !bad.text.includes("array")) throw new Error(`string args: ${bad.text}`);
      const badId = await call(23, "kortix", { args: ["whoami"], project_id: "not-a-uuid" });
      if (!badId.isError || !badId.text.includes("UUID")) throw new Error(`project_id: ${badId.text}`);
    });
    await ctx.step("the outsider's token reaches nothing of the owner's project through the CLI either", async () => {
      const r = await cli(24, ["secrets", "ls", "--json"], { project_id: p.id }, outsiderPat);
      if (!r.isError || !r.out || r.out.exit_code === 0 || r.text.includes("MCP_T")) throw new Error(r.text.slice(0, 400));
    });
    await ctx.step("read_skill with project_id lists the project's own skills before the guides; a name reads that skill's SKILL.md and its references", async () => {
      // The repository listing is cached for a moment: wait for the API to see the commit.
      await waitFor(() => call(31, "list_files", { project_id: p.id }), {
        until: (r) => r.text.includes("skills/mcp-demo/SKILL.md"),
        timeoutMs: 90_000,
        intervalMs: 3_000,
        description: "the committed skill in the repository listing",
      });
      const list = await call(25, "read_skill", { project_id: p.id });
      if (list.isError || !list.text.includes("kortix-system") || !list.text.includes("Project skills (read_skill")) throw new Error(list.text.slice(0, 500));
      const own = list.text.split("Platform guides:")[0]!.split("\n\n").map((l) => l.split(" — ")[0]!.trim()).filter((l) => /^[a-z0-9][a-z0-9._-]*$/i.test(l));
      if (!own.includes("mcp-demo") || !list.text.includes("Demo skill for the MCP flow")) throw new Error(`the project skill is not listed: ${list.text.slice(0, 400)}`);
      const one = await call(26, "read_skill", { project_id: p.id, name: "mcp-demo" });
      if (one.isError || !one.text.startsWith("---\nname: mcp-demo") || !one.text.includes("- references/notes.md")) throw new Error(`SKILL.md: ${one.text.slice(0, 300)}`);
      const ref = await call(30, "read_skill", { project_id: p.id, name: "mcp-demo", file: "references/notes.md" });
      if (ref.isError || ref.text !== "reference notes\n") throw new Error(`reference: ${ref.text.slice(0, 200)}`);
      const plain = await call(27, "read_skill", {});
      if (plain.text.includes("Project skills (read_skill")) throw new Error("read_skill without project_id lists project skills");
      const escape = await call(28, "read_skill", { project_id: p.id, name: "mcp-demo", file: "../../kortix.yaml" });
      if (!escape.isError) throw new Error("a reference path may not leave the skill directory");
      const outsider = await call(29, "read_skill", { project_id: p.id }, outsiderPat);
      if (!outsider.isError) throw new Error(`an outsider listed the project's skills: ${outsider.text.slice(0, 200)}`);
    });
  },
);
