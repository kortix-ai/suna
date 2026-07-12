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
  const email = `acp-smoke-${Date.now()}@example.test`;
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
        },
      );
      if (!updated.response.ok)
        throw new Error(`select ${HARNESS} runtime failed: ${updated.text}`);
      console.log(`[acp-smoke] selected harness=${HARNESS}`);
    }
    const createdSession = await api(
      "POST",
      `/projects/${projectId}/sessions`,
      { name: "ACP smoke" },
    );
    const sessionId =
      createdSession.json?.session_id ?? createdSession.json?.id;
    if (!sessionId)
      throw new Error(
        `session create failed: ${createdSession.response.status} ${createdSession.text}`,
      );
    console.log(`[acp-smoke] session=${sessionId}`);

    let start: any = null;
    const startDeadline = Date.now() + 8 * 60_000;
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
      if (start?.stage === "failed")
        throw new Error(`session start failed: ${result.text}`);
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
    const stream = client.connect({
      onEvent(event) {
        const envelope = event.envelope as any;
        if (
          envelope.method === "session/update" &&
          envelope.params?.update?.sessionUpdate === "agent_message_chunk"
        )
          assistant += envelope.params.update.content?.text ?? "";
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
      clientCapabilities: {},
      clientInfo: { name: "kortix-e2e", version: "1" },
    });
    const conversationId =
      start.runtime_session_id ??
      (await client.newSession({ cwd: "/workspace", mcpServers: [] }))
        .sessionId;
    if (start.runtime_session_id)
      await client.loadSession({
        sessionId: conversationId,
        cwd: "/workspace",
        mcpServers: [],
      });
    const completed = await client.prompt(conversationId, [
      { type: "text", text: "Reply with exactly: ACP_PONG" },
    ]);
    if (!completed.stopReason) throw new Error("prompt returned no stopReason");
    await sleep(500);
    stream.close();
    if (!assistant.includes("ACP_PONG"))
      throw new Error(`assistant output missing ACP_PONG: ${assistant}`);

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
      `[acp-smoke] PASS harness=${HARNESS} runtime=${start.runtime_id} conversation=${conversationId} stop=${completed.stopReason}`,
    );
  } finally {
    await api("DELETE", `/projects/${projectId}`);
  }
}

await main();
