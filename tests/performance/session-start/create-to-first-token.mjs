#!/usr/bin/env bun

/**
 * Measure one real starter session from POST /sessions through ACP session
 * readiness or the first model-generated ACP token.
 *
 * Required:
 *   BENCH_API         API v1 base, for example http://localhost:8018/v1
 *   BENCH_PROJECT_ID  Project that contains the starter under test. Omit when
 *                     BENCH_PROVISION_STARTER=1.
 *
 * Optional:
 *   BENCH_TOKEN       PAT or JWT for BENCH_API. When omitted, the script can
 *                     authenticate a local BENCH_UID through local Supabase.
 *   BENCH_DB_URL      Database URL for host provisionTimeline attribution
 *   BENCH_PROVIDER    daytona, platinum, e2b, or local-docker
 *   BENCH_MODEL       Session model
 *   BENCH_MODEL_CONFIG_VALUE
 *                     Optional harness-specific ACP model option value
 *   BENCH_PROMPT      Prompt text
 *   BENCH_TIMEOUT_S   Total timeout, default 180
 *   BENCH_KEEP        Keep the session when set to 1
 *   BENCH_PROVISION_STARTER
 *                     Create and later archive a disposable starter project
 *   BENCH_PROVISION_API
 *                     API v1 base used to create the starter project. Defaults
 *                     to BENCH_API. This supports old-vs-new starter A/B runs.
 *   BENCH_KEEP_PROJECT
 *                     Keep a disposable project when set to 1
 *   BENCH_ENABLE_ACP
 *                     Enable the ACP project experiment before the session.
 *                     Use this for a v2 OpenCode control project.
 *   BENCH_SKIP_MODEL_SELECT
 *                     Keep the model selected at session creation. Use this
 *                     when a harness rejects a redundant ACP model update.
 *   BENCH_STARTUP_ONLY Stop after ACP model selection. Do not dispatch a
 *                     prompt or call the model gateway.
 *   BENCH_GUEST_NETWORK_PROBE
 *                     Probe the fresh guest-to-API route before ACP when set
 *                     to 1. This intentionally warms that route.
 *   BENCH_OUT         Write the JSON result to this path
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { SQL } from 'bun';

import { createAcpClient } from '../../../packages/sdk/src/core/acp/client.ts';
import { buildProjectAcpEndpoint } from '../../../packages/sdk/src/core/session/runtime-transport.ts';

const apiBase = required('BENCH_API').replace(/\/+$/, '');
let token = process.env.BENCH_TOKEN?.trim() || '';
let projectId = process.env.BENCH_PROJECT_ID?.trim() || '';
const provisionStarter = process.env.BENCH_PROVISION_STARTER === '1';
const provisionApiBase = (
  process.env.BENCH_PROVISION_API?.trim() || apiBase
).replace(/\/+$/, '');
const keepProject = process.env.BENCH_KEEP_PROJECT === '1';
const enableAcp = process.env.BENCH_ENABLE_ACP === '1';
const skipModelSelect = process.env.BENCH_SKIP_MODEL_SELECT === '1';
const startupOnly = process.env.BENCH_STARTUP_ONLY === '1';
const provider = process.env.BENCH_PROVIDER?.trim() || undefined;
const model = process.env.BENCH_MODEL?.trim() || 'kortix/deepseek-v4-flash';
const modelConfigValue =
  process.env.BENCH_MODEL_CONFIG_VALUE?.trim() || model;
const promptText =
  process.env.BENCH_PROMPT?.trim() ||
  'Reply with exactly READY and no other text.';
const timeoutMs = Number(process.env.BENCH_TIMEOUT_S || 180) * 1_000;
const keep = process.env.BENCH_KEEP === '1';
const guestNetworkProbe = process.env.BENCH_GUEST_NETWORK_PROBE === '1';
const outputPath = process.env.BENCH_OUT?.trim() || '';
const databaseUrl = process.env.BENCH_DB_URL?.trim() || '';
const sql = databaseUrl ? new SQL(databaseUrl) : null;
let provisionedProject = null;
let projectProvisionDurationMs = null;
let projectRuntimePreparation = null;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function resolveLocalToken() {
  const supabaseUrl = required('SUPABASE_URL').replace(/\/+$/, '');
  const hostname = new URL(supabaseUrl).hostname;
  if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
    throw new Error(
      'BENCH_TOKEN is required for non-local Supabase. The benchmark never resets a remote user password.',
    );
  }
  const serviceKey = required('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = required('SUPABASE_ANON_KEY');
  const userId = required('BENCH_UID');
  const email = required('BENCH_EMAIL');
  const password = process.env.BENCH_PW || 'BenchPass123!';

  const reset = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
    method: 'PUT',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      password,
      email_confirm: true,
    }),
  });
  if (!reset.ok) {
    throw new Error(
      `local benchmark user reset returned ${reset.status}: ${await reset.text()}`,
    );
  }

  const signIn = await fetch(
    `${supabaseUrl}/auth/v1/token?grant_type=password`,
    {
      method: 'POST',
      headers: {
        apikey: anonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password }),
    },
  );
  const body = await signIn.json();
  if (!signIn.ok || typeof body?.access_token !== 'string') {
    throw new Error(
      `local benchmark sign-in returned ${signIn.status}: ${JSON.stringify(body)}`,
    );
  }
  return body.access_token;
}

async function prepareProject() {
  if (!provisionStarter) {
    if (!projectId) {
      throw new Error(
        'BENCH_PROJECT_ID is required unless BENCH_PROVISION_STARTER=1',
      );
    }
    return;
  }

  const name = `pi-starter-latency-${Math.floor(Date.now() / 1_000)}`;
  const startedAt = nowMs();
  const response = await fetch(`${provisionApiBase}/projects/provision`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      seed_starter: true,
      starter_template: 'minimal',
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  projectProvisionDurationMs = rounded(nowMs() - startedAt);
  if (response.status !== 201) {
    throw new Error(
      `starter project provision returned ${response.status}: ${JSON.stringify(body)}`,
    );
  }
  projectId = body?.project_id || body?.projectId || body?.id || '';
  if (!projectId) {
    throw new Error('starter project provision returned no project id');
  }
  provisionedProject = {
    id: projectId,
    name: body?.name ?? name,
    repo_url: body?.repo_url ?? body?.repoUrl ?? null,
    api_base: provisionApiBase,
  };
}

async function prepareProjectRuntime() {
  if (!enableAcp) return;
  const startedAt = nowMs();
  const response = await fetch(`${apiBase}/projects/${projectId}/experimental`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      feature: 'acp_runtime',
      enabled: true,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  projectRuntimePreparation = {
    operation: 'enable_acp_runtime',
    status: response.status,
    duration_ms: rounded(nowMs() - startedAt),
  };
  if (!response.ok) {
    throw new Error(
      `ACP runtime enable returned ${response.status}: ${JSON.stringify(body)}`,
    );
  }
}

function nowMs() {
  return performance.now();
}

function rounded(value) {
  return Math.round(value * 1_000) / 1_000;
}

function textPreview(value, maxLength = 240) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}…`
    : normalized;
}

function updateDetails(update) {
  if (!update || typeof update !== 'object') return null;
  return Object.fromEntries(
    Object.entries(update)
      .filter(([key]) => key !== 'content')
      .map(([key, value]) => [
        key,
        typeof value === 'string' ? textPreview(value) : value,
      ]),
  );
}

const apiRequests = [];

async function api(path, init = {}, label = null) {
  const requestStartedAt = nowMs();
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  apiRequests.push({
    label: label ?? `${init.method ?? 'GET'} ${path}`,
    method: init.method ?? 'GET',
    path,
    status: response.status,
    started_at_ms: rounded(requestStartedAt - benchmarkStartedAt),
    completed_at_ms: rounded(nowMs() - benchmarkStartedAt),
    duration_ms: rounded(nowMs() - requestStartedAt),
  });
  return { response, body };
}

function authorizedFetch(input, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}

async function runGuestNetworkProbe(externalId) {
  const output = `/tmp/kortix-gateway-network-probe-${Date.now()}.json`;
  const command = [
    'set -euo pipefail',
    'adapter_pid="$(pgrep -f \'pi-acp/dist/index.js\' | head -1)"',
    'base_url="$(tr \'\\0\' \'\\n\' < "/proc/$adapter_pid/environ" | sed -n \'s/^KORTIX_LLM_BASE_URL=//p\')"',
    'health_url="$(node -e \'console.log(new URL(process.argv[1]).origin + "/v1/health")\' "$base_url")"',
    `curl -sS -o /dev/null -w '{"http_code":%{http_code},"dns_s":%{time_namelookup},"tcp_s":%{time_connect},"tls_s":%{time_appconnect},"pretransfer_s":%{time_pretransfer},"ttfb_s":%{time_starttransfer},"total_s":%{time_total}}' "$health_url" > '${output}'`,
  ].join('; ');
  const startedAt = nowMs();
  const launched = await api(
    `/p/${externalId}/8000/kortix/pty`,
    {
      method: 'POST',
      body: JSON.stringify({
        command: '/bin/bash',
        args: ['-lc', command],
        cwd: '/workspace',
        title: 'gateway-network-probe',
      }),
    },
    'telemetry.guest.gateway-network-probe.start',
  );
  if (!launched.response.ok) {
    return {
      error: `PTY returned ${launched.response.status}`,
      duration_ms: rounded(nowMs() - startedAt),
    };
  }

  const deadline = nowMs() + 60_000;
  while (nowMs() < deadline) {
    await Bun.sleep(100);
    const file = await api(
      `/p/${externalId}/8000/file/content?path=${encodeURIComponent(output)}`,
      {},
      'telemetry.guest.gateway-network-probe.poll',
    );
    if (file.response.status === 404) continue;
    if (!file.response.ok) {
      return {
        error: `file read returned ${file.response.status}`,
        duration_ms: rounded(nowMs() - startedAt),
      };
    }
    try {
      return {
        ...JSON.parse(file.body?.content ?? ''),
        duration_ms: rounded(nowMs() - startedAt),
      };
    } catch {
      return {
        error: 'probe returned invalid JSON',
        raw: textPreview(file.body?.content),
        duration_ms: rounded(nowMs() - startedAt),
      };
    }
  }
  return {
    error: 'probe timed out',
    duration_ms: rounded(nowMs() - startedAt),
  };
}

function textChunk(envelope, kind) {
  if (!envelope || envelope.method !== 'session/update') return '';
  const update = envelope.params?.update;
  if (update?.sessionUpdate !== kind) return '';
  return update.content?.type === 'text' && typeof update.content.text === 'string'
    ? update.content.text
    : '';
}

function classifyAgentMessage(text) {
  const normalized = text.trim();
  if (!normalized) return 'empty';
  return (
    /^pi v\d+\.\d+\.\d+/i.test(normalized) ||
    (normalized.includes('## Context') && normalized.includes('## Skills')) ||
    normalized.includes('New version available:')
  )
    ? 'harness_startup'
    : /^Retrying \(attempt \d+\/\d+, waiting /i.test(normalized) ||
        /^Request failed(?: after \d+ attempts)?:/i.test(normalized)
      ? 'transport_notice'
      : 'model_text';
}

function buildSequentialBreakdown(result) {
  const cumulative = result.cumulative_ms;
  const runtimeReady = cumulative.runtime_ready;
  const acpInitialized = cumulative.acp_initialized;
  const acpSessionCreated = cumulative.acp_session_created;
  const modelSelected = cumulative.acp_model_selected;
  const promptDispatched = cumulative.prompt_dispatched;
  const firstModelToken = cumulative.first_model_token;
  if (
    typeof runtimeReady !== 'number' ||
    typeof acpInitialized !== 'number' ||
    typeof acpSessionCreated !== 'number' ||
    typeof modelSelected !== 'number'
  ) {
    return null;
  }

  const startup = [
    {
      phase: 'create_to_runtime_ready',
      start_ms: 0,
      end_ms: runtimeReady,
      duration_ms: rounded(runtimeReady),
    },
    {
      phase: 'acp_connect_and_initialize',
      start_ms: runtimeReady,
      end_ms: acpInitialized,
      duration_ms: rounded(acpInitialized - runtimeReady),
    },
    {
      phase: 'acp_session_new',
      start_ms: acpInitialized,
      end_ms: acpSessionCreated,
      duration_ms: rounded(acpSessionCreated - acpInitialized),
    },
    {
      phase: 'acp_model_select',
      start_ms: acpSessionCreated,
      end_ms: modelSelected,
      duration_ms: rounded(modelSelected - acpSessionCreated),
    },
  ];
  if (typeof promptDispatched !== 'number') return startup;
  return [
    ...startup,
    {
      phase: 'model_select_to_prompt_dispatch',
      start_ms: modelSelected,
      end_ms: promptDispatched,
      duration_ms: rounded(promptDispatched - modelSelected),
    },
    ...(typeof firstModelToken === 'number'
      ? [
          {
            phase: 'prompt_to_first_model_token',
            start_ms: promptDispatched,
            end_ms: firstModelToken,
            duration_ms: rounded(firstModelToken - promptDispatched),
          },
        ]
      : []),
  ];
}

function buildGatewayAttribution(result) {
  const promptDispatched = result.cumulative_ms.prompt_dispatched;
  const firstModelToken = result.cumulative_ms.first_model_token;
  const request = result.gateway_request_timeline[0];
  if (
    typeof promptDispatched !== 'number' ||
    typeof firstModelToken !== 'number' ||
    !request
  ) {
    return null;
  }
  return {
    prompt_to_gateway_start_ms_estimate: rounded(
      request.started_at_ms_estimate - promptDispatched,
    ),
    gateway_logged_latency_ms: request.latency_ms,
    gateway_complete_to_first_model_token_ms: rounded(
      firstModelToken - request.completed_at_ms,
    ),
  };
}

async function readHostTimelines(sessionId) {
  if (!sql) return null;
  const [sandboxRows, sessionRows] = await Promise.all([
    sql`
      select metadata
      from kortix.session_sandboxes
      where sandbox_id = ${sessionId}
      limit 1
    `,
    sql`
      select metadata
      from kortix.project_sessions
      where session_id = ${sessionId}
      limit 1
    `,
  ]);
  return {
    provision: sandboxRows[0]?.metadata?.provisionTimeline ?? null,
    prompt_env_sync:
      sandboxRows[0]?.metadata?.promptEnvSyncTimeline ?? null,
    session_create:
      sessionRows[0]?.metadata?.session_start_timeline ?? null,
  };
}

async function readGatewayRequests(sessionId) {
  if (!sql) return [];
  const rows = await sql`
    select
      request_id,
      requested_model,
      resolved_model,
      provider,
      status,
      ok,
      error_code,
      latency_ms,
      attempts,
      candidates_tried,
      input_tokens,
      output_tokens,
      streaming,
      extract(epoch from created_at) * 1000 as completed_epoch_ms
    from kortix.gateway_request_logs
    where session_id = ${sessionId}
    order by created_at
  `;
  return rows.map((row) => {
    const completedEpochMs = Number(row.completed_epoch_ms);
    const latencyMs = Number(row.latency_ms);
    const completedAtMs = rounded(completedEpochMs - benchmarkStartedEpochMs);
    const startedAtMs = rounded(completedAtMs - latencyMs);
    return {
      request_id: row.request_id,
      requested_model: row.requested_model,
      resolved_model: row.resolved_model,
      provider: row.provider,
      status: row.status,
      ok: row.ok,
      error_code: row.error_code,
      latency_ms: latencyMs,
      attempts: row.attempts,
      candidates_tried: row.candidates_tried,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      streaming: row.streaming,
      started_at_ms_estimate: startedAtMs,
      completed_at_ms: completedAtMs,
    };
  });
}

let benchmarkStartedAt = nowMs();
let benchmarkStartedEpochMs = Date.now();

async function main() {
  const result = {
    schema_version: 3,
    recorded_at: new Date(benchmarkStartedEpochMs).toISOString(),
    api_base: apiBase,
    project_id: projectId,
    project_provision: provisionedProject
      ? {
          ...provisionedProject,
          duration_ms: projectProvisionDurationMs,
        }
      : null,
    project_runtime_preparation: projectRuntimePreparation,
    provider: provider ?? null,
    boundary: startupOnly ? 'session_ready' : 'first_model_token',
    model,
    model_config_value: modelConfigValue,
    prompt: startupOnly ? null : promptText,
    session_id: null,
    runtime_harness: null,
    runtime_transport: null,
    acp_session_id: null,
    acp_session_new_response: null,
    cumulative_ms: {},
    durations_ms: {},
    api_requests: apiRequests,
    start_poll_timeline: [],
    acp_event_timeline: [],
    host_session_create_timeline: null,
    host_provision_timeline: null,
    host_prompt_env_sync_timeline: null,
    guest_boot_timeline: null,
    guest_network_probe: null,
    gateway_request_timeline: [],
    gateway_attribution: null,
    sequential_breakdown: null,
    first_agent_message_text: null,
    first_agent_message_class: null,
    first_reasoning_text: null,
    first_model_text: null,
    model_response_text: '',
    error: null,
  };

  const startedAt = benchmarkStartedAt;
  const at = () => rounded(nowMs() - startedAt);
  let stream = null;
  let externalId = null;
  let telemetryCollected = false;

  const collectTelemetry = async () => {
    if (telemetryCollected || !result.session_id) return;
    telemetryCollected = true;
    const hostTimelines = await readHostTimelines(result.session_id);
    result.host_session_create_timeline =
      hostTimelines?.session_create ?? null;
    result.host_provision_timeline = hostTimelines?.provision ?? null;
    result.host_prompt_env_sync_timeline =
      hostTimelines?.prompt_env_sync ?? null;
    result.gateway_request_timeline = await readGatewayRequests(
      result.session_id,
    );
    if (externalId) {
      const health = await api(
        `/p/${externalId}/8000/kortix/health`,
        {},
        'telemetry.guest.health',
      );
      if (health.response.ok) {
        result.guest_boot_timeline = health.body?.boot_timeline ?? null;
      }
    }
  };

  try {
    const createStartedAt = nowMs();
    const created = await api(`/projects/${projectId}/sessions`, {
      method: 'POST',
      body: JSON.stringify({
        ...(provider ? { provider } : {}),
        ...(model ? { opencode_model: model } : {}),
      }),
    }, 'session.create');
    result.durations_ms.session_create_request = rounded(nowMs() - createStartedAt);
    result.cumulative_ms.session_created = at();
    if (created.response.status !== 201) {
      throw new Error(`session create returned ${created.response.status}: ${JSON.stringify(created.body)}`);
    }

    const sessionId =
      created.body?.session_id || created.body?.sessionId || created.body?.id;
    if (!sessionId) throw new Error('session create returned no session id');
    result.session_id = sessionId;

    const readyDeadline = nowMs() + timeoutMs;
    let ready = null;
    while (nowMs() < readyDeadline) {
      const next = await api(
        `/projects/${projectId}/sessions/${sessionId}/start?wait_ms=0`,
        { method: 'POST', body: '{}' },
        'session.start.poll',
      );
      result.start_poll_timeline.push({
        at_ms: at(),
        status: next.response.status,
        stage: next.body?.stage ?? null,
        provisioning_stage: next.body?.provisioning_stage ?? null,
        runtime_ready: next.body?.runtime_ready ?? null,
      });
      if (!next.response.ok) {
        throw new Error(`session start returned ${next.response.status}: ${JSON.stringify(next.body)}`);
      }
      if (next.body?.stage === 'failed') {
        throw new Error(`session start failed: ${next.body?.error || 'unknown error'}`);
      }
      if (next.body?.stage === 'ready') {
        ready = next.body;
        break;
      }
      await Bun.sleep(100);
    }
    if (!ready) throw new Error('session did not reach runtime ready before timeout');

    result.cumulative_ms.runtime_ready = at();
    result.runtime_harness = ready.runtime_harness ?? null;
    result.runtime_transport = ready.runtime_transport ?? null;
    externalId = ready.sandbox?.external_id ?? null;

    if (ready.runtime_transport !== 'acp') {
      throw new Error(`expected ACP runtime, received ${ready.runtime_transport ?? 'unknown'}`);
    }
    if (guestNetworkProbe && externalId) {
      result.guest_network_probe = await runGuestNetworkProbe(externalId);
      result.cumulative_ms.guest_network_probe_complete = at();
    }

    const client = createAcpClient({
      endpoint: buildProjectAcpEndpoint(apiBase, projectId, sessionId),
      fetch: authorizedFetch,
      requestTimeoutMs: timeoutMs,
    });

    let firstReasoningResolve;
    let firstModelResolve;
    let firstModelReject;
    const firstReasoning = new Promise((resolve) => {
      firstReasoningResolve = resolve;
    });
    const firstModel = new Promise((resolve, reject) => {
      firstModelResolve = resolve;
      firstModelReject = reject;
    });

    stream = client.connect({
      reconnect: false,
      onEvent(event) {
        const envelope = event.envelope;
        const update = envelope?.params?.update;
        const eventText =
          update?.content?.type === 'text' &&
          typeof update.content.text === 'string'
            ? update.content.text
            : '';
        const messageClass =
          update?.sessionUpdate === 'agent_message_chunk'
            ? classifyAgentMessage(eventText)
            : null;
        result.acp_event_timeline.push({
          at_ms: at(),
          method: envelope?.method ?? null,
          id: envelope?.id ?? null,
          update: update?.sessionUpdate ?? null,
          content_type: update?.content?.type ?? null,
          message_class: messageClass,
          text: textPreview(eventText),
          update_details: updateDetails(update),
        });
        const reasoning = textChunk(event.envelope, 'agent_thought_chunk');
        if (reasoning && result.cumulative_ms.first_reasoning_token === undefined) {
          result.cumulative_ms.first_reasoning_token = at();
          result.first_reasoning_text = reasoning;
          firstReasoningResolve();
        }
        const visible = textChunk(event.envelope, 'agent_message_chunk');
        if (
          visible &&
          result.cumulative_ms.first_agent_message === undefined
        ) {
          result.cumulative_ms.first_agent_message = at();
          result.first_agent_message_text = visible;
          result.first_agent_message_class = classifyAgentMessage(visible);
        }
        if (
          visible &&
          classifyAgentMessage(visible) === 'model_text'
        ) {
          result.model_response_text += visible;
          if (result.cumulative_ms.first_model_token === undefined) {
            result.cumulative_ms.first_model_token = at();
            result.first_model_text = visible;
            firstModelResolve();
          }
        }
      },
      onError(error) {
        if (!result.error) result.error = String(error);
        firstModelReject(error);
      },
    });

    // The bridge emits no synthetic event when the SSE response opens.
    // `initialize` produces the first response event. Start both operations
    // together so waiting for stream.ready cannot deadlock before initialize.
    const streamStartedAt = nowMs();
    const initializeStartedAt = nowMs();
    const streamReady = stream.ready.then(() => {
      result.durations_ms.acp_stream_open = rounded(nowMs() - streamStartedAt);
      result.cumulative_ms.acp_stream_open = at();
    });
    const initialized = client.initialize();
    await Promise.all([streamReady, initialized]);
    result.durations_ms.acp_initialize = rounded(nowMs() - initializeStartedAt);
    result.cumulative_ms.acp_initialized = at();

    const sessionNewStartedAt = nowMs();
    const nativeSession = await client.newSession({ cwd: '/workspace', mcpServers: [] });
    result.durations_ms.acp_session_new = rounded(nowMs() - sessionNewStartedAt);
    result.cumulative_ms.acp_session_created = at();
    result.acp_session_id = nativeSession.sessionId;
    result.acp_session_new_response = nativeSession;

    if (!skipModelSelect) {
      const modelSelectStartedAt = nowMs();
      await client.setSessionConfigOption(
        nativeSession.sessionId,
        'model',
        modelConfigValue,
      );
      result.durations_ms.acp_model_select = rounded(
        nowMs() - modelSelectStartedAt,
      );
    } else {
      result.durations_ms.acp_model_select = 0;
    }
    result.cumulative_ms.acp_model_selected = at();
    result.durations_ms.create_to_runtime_ready =
      result.cumulative_ms.runtime_ready;
    result.durations_ms.create_to_session_ready =
      result.cumulative_ms.acp_model_selected;

    if (!startupOnly) {
      const promptStartedAt = nowMs();
      result.cumulative_ms.prompt_dispatched = at();
      const promptComplete = client
        .prompt(nativeSession.sessionId, [
          { type: 'text', text: promptText },
        ])
        .then((promptResult) => {
          result.cumulative_ms.prompt_complete = at();
          result.durations_ms.prompt_total = rounded(nowMs() - promptStartedAt);
          result.stop_reason = promptResult.stopReason ?? null;
          result.prompt_result = promptResult;
          return promptResult;
        });

      await Promise.race([
        firstModel,
        promptComplete.then(() => {
          if (result.cumulative_ms.first_model_token === undefined) {
            throw new Error('prompt completed without a model text token');
          }
        }),
        Bun.sleep(timeoutMs).then(() => {
          throw new Error('first model token timed out');
        }),
      ]);
      result.durations_ms.prompt_to_first_model_token = rounded(
        nowMs() - promptStartedAt,
      );
      if (result.cumulative_ms.first_reasoning_token !== undefined) {
        result.durations_ms.prompt_to_first_reasoning_token = rounded(
          result.cumulative_ms.first_reasoning_token - result.cumulative_ms.prompt_dispatched,
        );
      } else {
        void firstReasoning;
      }

      await promptComplete;
      result.durations_ms.create_to_first_model_token =
        result.cumulative_ms.first_model_token;
    }
    await collectTelemetry();
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    stream?.close();
    await collectTelemetry().catch((error) => {
      result.telemetry_error =
        error instanceof Error ? error.message : String(error);
    });
    if (result.session_id && !keep) {
      await api(`/projects/${projectId}/sessions/${result.session_id}`, {
        method: 'DELETE',
      }).catch(() => {});
    }
    if (provisionedProject && !keepProject) {
      const response = await fetch(
        `${provisionApiBase}/projects/${projectId}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(60_000),
        },
      ).catch(() => null);
      result.project_cleanup_status = response?.status ?? null;
    }
    if (sql) await sql.close();
    result.sequential_breakdown = buildSequentialBreakdown(result);
    result.gateway_attribution = buildGatewayAttribution(result);
    if (outputPath) {
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
    }
    console.log(JSON.stringify(result, null, 2));
  }
}

if (!token) token = await resolveLocalToken();
await prepareProject();
await prepareProjectRuntime();
benchmarkStartedAt = nowMs();
benchmarkStartedEpochMs = Date.now();
await main();
process.exit(0);
