#!/usr/bin/env bun
import {
  configureKortix,
  createAcpClient,
  type AcpEnvelope,
} from "../../../packages/sdk/src/index";

const API = process.env.E2E_API_URL || "http://localhost:19008/v1";
const SUPABASE = process.env.E2E_SUPABASE_URL || "http://127.0.0.1:54321";
const SERVICE_KEY = (process.env.E2E_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY)!;
const ANON_KEY = (process.env.E2E_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!;
const HARNESS = process.env.E2E_ACP_HARNESS || "opencode";
const AGENT =
  process.env.E2E_ACP_AGENT || (HARNESS === "opencode" ? "kortix" : HARNESS);
const PROVIDER = process.env.E2E_ACP_PROVIDER || "daytona";
const KEEP_PROJECT = process.env.E2E_ACP_KEEP_PROJECT === "1";
if (!["opencode", "claude", "codex", "pi"].includes(HARNESS))
  throw new Error(`Unsupported E2E_ACP_HARNESS=${HARNESS}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
if (!SERVICE_KEY || !ANON_KEY)
  throw new Error("Supabase service-role and anon keys are required");

let token = "";
async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { response, json, text };
}

async function main() {
  const email = `acp-smoke-${HARNESS}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}@example.test`;
  const password = "TestPass123!acp";
  const created = await fetch(`${SUPABASE}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!created.ok)
    throw new Error(
      `create user failed: ${created.status} ${await created.text()}`,
    );
  const login = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  token = ((await login.json()) as any).access_token;
  if (!token) throw new Error("password grant returned no token");
  configureKortix({ backendUrl: API, getToken: async () => token });

  const accounts = await api("GET", "/accounts");
  const accountId =
    accounts.json.find((account: any) => account.personal_account)
      ?.account_id ?? accounts.json[0]?.account_id;
  const provisioned = await api("POST", "/projects/provision", {
    account_id: accountId,
    name: `ACP ${HARNESS} smoke ${Date.now()}`,
    seed_starter: true,
  });
  const projectId = provisioned.json?.project_id ?? provisioned.json?.id;
  if (!projectId)
    throw new Error(
      `provision failed: ${provisioned.response.status} ${provisioned.text}`,
    );
  console.log(`[acp-smoke] project=${projectId}`);

  try {
    const unauthenticatedProfiles = await fetch(
      `${API}/projects/${projectId}/runtime-profiles`,
    );
    if (unauthenticatedProfiles.status !== 401)
      throw new Error(
        `runtime profiles auth gate returned ${unauthenticatedProfiles.status}, expected 401`,
      );

    const profiles = await api(
      "GET",
      `/projects/${projectId}/runtime-profiles`,
    );
    if (!profiles.response.ok || profiles.json?.schema_version !== 3)
      throw new Error(`runtime profiles unavailable: ${profiles.text}`);
    for (const harness of ["opencode", "claude", "codex", "pi"]) {
      if (profiles.json?.runtimes?.[harness]?.harness !== harness)
        throw new Error(
          `starter missing ${harness} runtime profile: ${profiles.text}`,
        );
    }
    const agentConfig = await api(
      "GET",
      `/projects/${projectId}/agents/${AGENT}/config`,
    );
    if (
      !agentConfig.response.ok ||
      agentConfig.json?.block?.runtime !== HARNESS
    )
      throw new Error(
        `starter agent ${AGENT} does not route to ${HARNESS}: ${agentConfig.text}`,
      );
    const projectDetail = await api("GET", `/projects/${projectId}/detail`);
    const agentSummary = projectDetail.json?.config?.agents?.find(
      (agent: any) => agent.name === AGENT,
    );
    if (agentSummary?.runtime !== HARNESS || agentSummary?.harness !== HARNESS)
      throw new Error(
        `project agent summary lost runtime identity for ${AGENT}: ${projectDetail.text}`,
      );
    console.log(`[acp-smoke] starter agent=${AGENT} harness=${HARNESS}`);

    const rejectedSession = await api(
      "POST",
      `/projects/${projectId}/sessions`,
      {
        session_id: crypto.randomUUID(),
        name: "Invalid agent must be rejected",
        provider: PROVIDER,
        agent_name: "not-a-declared-agent",
      },
    );
    if (
      rejectedSession.response.status < 400 ||
      rejectedSession.response.status >= 500
    )
      throw new Error(
        `undeclared agent returned ${rejectedSession.response.status}, expected a 4xx: ${rejectedSession.text}`,
      );

    const createdSession = await api(
      "POST",
      `/projects/${projectId}/sessions`,
      { name: `ACP ${HARNESS} smoke`, provider: PROVIDER, agent_name: AGENT },
    );
    const sessionId =
      createdSession.json?.session_id ?? createdSession.json?.id;
    if (!sessionId)
      throw new Error(
        `session create failed: ${createdSession.response.status} ${createdSession.text}`,
      );
    if (createdSession.json?.agent_name !== AGENT)
      throw new Error(`session did not bind ${AGENT}: ${createdSession.text}`);
    console.log(`[acp-smoke] session=${sessionId} provider=${PROVIDER}`);

    const listedSessions = await api("GET", `/projects/${projectId}/sessions`);
    const listed = Array.isArray(listedSessions.json)
      ? listedSessions.json
      : listedSessions.json?.sessions;
    const listedSession = listed?.find(
      (session: any) =>
        session.session_id === sessionId || session.id === sessionId,
    );
    if (!listedSessions.response.ok || listedSession?.agent_name !== AGENT)
      throw new Error(
        `session list lost immutable agent binding: ${listedSessions.text}`,
      );

    let start: any = null;
    // A cold runtime-layer build may take ~9 minutes and provider provisioning
    // may take another ~5. Keep this black-box proof above the documented worst
    // case instead of deleting the project while its first image is still baking.
    const startDeadline = Date.now() + 15 * 60_000;
    while (Date.now() < startDeadline) {
      const result = await api(
        "POST",
        `/projects/${projectId}/sessions/${sessionId}/start`,
      );
      start = result.json;
      console.log(
        `[acp-smoke] start=${start?.stage} protocol=${start?.runtime_protocol ?? "-"} reason=${start?.reason ?? "-"}`,
      );
      if (start?.stage === "ready") break;
      if (start?.stage === "failed") {
        const sessions = await api("GET", `/projects/${projectId}/sessions`);
        console.error(`[acp-smoke] failed session detail=${sessions.text}`);
        throw new Error(`session start failed: ${result.text}`);
      }
      await sleep(5_000);
    }
    if (
      start?.stage !== "ready" ||
      start.runtime_protocol !== "acp" ||
      !start.runtime_id
    )
      throw new Error(
        `ACP runtime did not become ready: ${JSON.stringify(start)}`,
      );

    const repeatedStart = await api(
      "POST",
      `/projects/${projectId}/sessions/${sessionId}/start`,
    );
    if (
      !repeatedStart.response.ok ||
      repeatedStart.json?.stage !== "ready" ||
      repeatedStart.json?.runtime_id !== start.runtime_id
    )
      throw new Error(
        `idempotent session start changed runtime identity: ${repeatedStart.text}`,
      );

    const endpoint = `${API}/projects/${projectId}/sessions/${sessionId}/acp`;
    const client = createAcpClient({ endpoint });
    let assistant = "";
    const toolCalls = new Set<string>();
    const completedTools = new Set<string>();
    const stream = client.connect({
      onEvent(event) {
        const envelope = event.envelope as any;
        if (
          envelope.method === "session/update" &&
          envelope.params?.update?.sessionUpdate === "agent_message_chunk"
        )
          assistant += envelope.params.update.content?.text ?? "";
        if (envelope.method === "session/update") {
          const update = envelope.params?.update;
          if (
            update?.sessionUpdate === "tool_call" ||
            update?.sessionUpdate === "tool_call_update"
          ) {
            const id = String(update.toolCallId ?? update.id ?? "");
            if (id) toolCalls.add(id);
            if (
              id &&
              (update.status === "completed" || update.status === "failed")
            )
              completedTools.add(id);
          }
        }
        if (
          envelope.method === "session/request_permission" &&
          "id" in envelope
        ) {
          const options = envelope.params?.options ?? [];
          const allowed = options.find(
            (option: any) =>
              option.kind === "allow_once" || option.optionId === "allow_once",
          );
          void client.respond(envelope.id, {
            outcome: allowed
              ? { outcome: "selected", optionId: allowed.optionId }
              : { outcome: "cancelled" },
          });
        }
      },
    });
    await client.initialize({
      protocolVersion: 1,
      clientCapabilities: { auth: { _meta: { gateway: true } } },
      clientInfo: { name: "kortix-e2e", version: "1" },
    });
    const sessionResult = start.runtime_session_id
      ? await client.loadSession({
          sessionId: start.runtime_session_id,
          cwd: "/workspace",
          mcpServers: [],
        })
      : await client.newSession({ cwd: "/workspace", mcpServers: [] });
    const conversationId =
      start.runtime_session_id ??
      ("sessionId" in sessionResult ? sessionResult.sessionId : null);
    if (!conversationId)
      throw new Error("ACP session/new returned no sessionId");
    const configurable = sessionResult.configOptions?.find(
      (option: any) => option.id && option.currentValue !== undefined,
    );
    if (configurable) {
      await client.setSessionConfigOption(
        conversationId,
        configurable.id,
        configurable.currentValue,
      );
    }
    const completed = await client.prompt(conversationId, [
      {
        type: "text",
        text: "Use your shell tool to run pwd, then reply with exactly: ACP_PONG",
      },
    ]);
    if (!completed.stopReason) throw new Error("prompt returned no stopReason");
    const streamDeadline = Date.now() + 10_000;
    while (completedTools.size === 0 && Date.now() < streamDeadline)
      await sleep(100);
    stream.close();
    if (!assistant.includes("ACP_PONG"))
      throw new Error(`assistant output missing ACP_PONG: ${assistant}`);
    if (toolCalls.size === 0 || completedTools.size === 0)
      throw new Error(
        `ACP turn did not stream a completed tool call (calls=${toolCalls.size}, completed=${completedTools.size})`,
      );

    const transcript = await client.transcript();
    const methods = transcript.envelopes
      .map((row) => (row.envelope as AcpEnvelope & { method?: string }).method)
      .filter(Boolean);
    if (
      !methods.includes("session/prompt") ||
      !methods.includes("session/update")
    )
      throw new Error(`persisted transcript incomplete: ${methods.join(",")}`);
    await client.loadSession({
      sessionId: conversationId,
      cwd: "/workspace",
      mcpServers: [],
    });
    console.log(
      `[acp-smoke] PASS agent=${AGENT} harness=${HARNESS} runtime=${start.runtime_id} conversation=${conversationId} tools=${toolCalls.size} config=${configurable?.id ?? "none"} stop=${completed.stopReason}`,
    );
    if (KEEP_PROJECT) {
      console.log(
        `[acp-smoke] KEEP email=${email} password=${password} project=${projectId} session=${sessionId}`,
      );
    }
  } finally {
    if (!KEEP_PROJECT) await api("DELETE", `/projects/${projectId}`);
  }
}

await main();
