#!/usr/bin/env bun
import {
  configureKortix,
  createAcpClient,
  type AcpEnvelope,
} from "../../../packages/sdk/src/index";

const API = process.env.E2E_API_URL || "http://localhost:19008/v1";
const SUPABASE = process.env.E2E_SUPABASE_URL || "http://127.0.0.1:54321";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const HARNESS = process.env.E2E_ACP_HARNESS || "opencode";
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
    if (HARNESS !== "opencode") {
      const current = await api(
        "GET",
        `/projects/${projectId}/agents/kortix/config`,
      );
      if (!current.response.ok || current.json?.schema_version !== 3)
        throw new Error(`read agent config failed: ${current.text}`);
      const updated = await api(
        "PUT",
        `/projects/${projectId}/agents/kortix/config`,
        {
          ...current.json.block,
          runtime: HARNESS,
          // `agent` is an OpenCode-native entrypoint selector. The other
          // official adapters select behavior through their runtime profile's
          // native config and ACP-discovered config options.
          agent: undefined,
        },
      );
      if (!updated.response.ok)
        throw new Error(`select ${HARNESS} runtime failed: ${updated.text}`);
      console.log(`[acp-smoke] selected harness=${HARNESS}`);
    }
    const createdSession = await api(
      "POST",
      `/projects/${projectId}/sessions`,
      { name: "ACP smoke", provider: PROVIDER },
    );
    const sessionId =
      createdSession.json?.session_id ?? createdSession.json?.id;
    if (!sessionId)
      throw new Error(
        `session create failed: ${createdSession.response.status} ${createdSession.text}`,
      );
    console.log(`[acp-smoke] session=${sessionId} provider=${PROVIDER}`);

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
          if (update?.sessionUpdate === "tool_call" || update?.sessionUpdate === "tool_call_update") {
            const id = String(update.toolCallId ?? update.id ?? "");
            if (id) toolCalls.add(id);
            if (id && (update.status === "completed" || update.status === "failed")) completedTools.add(id);
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
    const conversationId = start.runtime_session_id ?? ('sessionId' in sessionResult ? sessionResult.sessionId : null);
    if (!conversationId) throw new Error('ACP session/new returned no sessionId');
    const configurable = sessionResult.configOptions?.find(
      (option: any) => option.id && option.currentValue !== undefined,
    );
    if (configurable) {
      await client.setSessionConfigOption(conversationId, configurable.id, configurable.currentValue);
    }
    const completed = await client.prompt(conversationId, [
      { type: "text", text: "Use your shell tool to run pwd, then reply with exactly: ACP_PONG" },
    ]);
    if (!completed.stopReason) throw new Error("prompt returned no stopReason");
    await sleep(500);
    stream.close();
    if (!assistant.includes("ACP_PONG"))
      throw new Error(`assistant output missing ACP_PONG: ${assistant}`);
    if (toolCalls.size === 0 || completedTools.size === 0)
      throw new Error(`ACP turn did not stream a completed tool call (calls=${toolCalls.size}, completed=${completedTools.size})`);

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
      `[acp-smoke] PASS harness=${HARNESS} runtime=${start.runtime_id} conversation=${conversationId} tools=${toolCalls.size} config=${configurable?.id ?? 'none'} stop=${completed.stopReason}`,
    );
    if (KEEP_PROJECT) {
      console.log(`[acp-smoke] KEEP email=${email} password=${password} project=${projectId} session=${sessionId}`);
    }
  } finally {
    if (!KEEP_PROJECT) await api("DELETE", `/projects/${projectId}`);
  }
}

await main();
