/**
 * The HTTP boundary between this worker and the Kortix API.
 *
 * This process is no longer inside apps/api, so it cannot call
 * `continueSession()` in-process the way the old bridge.ts/runtime.ts did.
 * Everything here goes over the network instead, against the voice MCP
 * apps/api exposes for exactly this purpose — JSON-RPC 2.0 over streamable
 * HTTP, one `tools/call` per hand-off — see apps/api/src/channels/voice/mcp.ts
 * (the tool definitions) and routes.ts (the route + auth). Three tools:
 * `ask_kortix`, `run_command`, `post_turn` — the mirror of the old
 * `ask_kortix` → `continueSession()`, sandbox exec, and `appendTurn()` paths.
 *
 * Every function here is defensive on purpose: a tool's `execute` must always
 * resolve to something speakable, never throw and never hang past its
 * timeout. A voice call has no error boundary except "the agent goes quiet",
 * which is worse than it saying "I couldn't reach Kortix."
 */
import type { CallContext } from './call-context';

const PROMPT_TIMEOUT_MS = 6_000;
const RUN_COMMAND_TIMEOUT_MS = 12_000;
const TURN_TIMEOUT_MS = 6_000;

/**
 * WHY the failure carries a `kind`. A tool that came back `isError: true` was
 * REACHED and said no — apps/api refuses a hand-off when one is already
 * outstanding, or when the call is repeating itself, and the text it returns is
 * guidance written for the voice model to relay. A transport failure is the
 * opposite: nothing was told anything. Collapsing both into one string made the
 * call announce "I could not reach Kortix" when Kortix had in fact answered
 * "you already asked me that, wait" — which reads as a fault and invites the
 * immediate retry the refusal exists to prevent.
 */
export type PostFailureKind = 'unreachable' | 'refused';

type PostResult =
  | { ok: true; data: unknown }
  | { ok: false; kind: PostFailureKind; error: string };

interface McpToolContent {
  type: string;
  text?: string;
}

interface McpToolCallResult {
  isError?: boolean;
  content?: McpToolContent[];
  structuredContent?: unknown;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: unknown;
  result?: McpToolCallResult;
  error?: { code?: number; message?: string };
}

function mcpEndpoint(ctx: CallContext): string {
  const base = ctx.kortixApiUrl.replace(/\/+$/, '');
  return `${base}/v1/projects/${encodeURIComponent(ctx.workspaceId)}/sessions/${encodeURIComponent(ctx.sessionId)}/mcp/voice`;
}

let nextRpcId = 1;

/**
 * Calls one voice-MCP tool and unwraps its JSON-RPC + MCP tool-result
 * envelopes into a plain `PostResult`. A tool error (`isError: true`, e.g.
 * "request is required", or a refused hand-off) becomes `kind: 'refused'`;
 * every transport-layer failure (fetch failure, non-2xx, malformed JSON-RPC)
 * becomes `kind: 'unreachable'`. See `PostFailureKind` for why that distinction
 * has to survive this far.
 */
async function callVoiceMcpTool(
  ctx: CallContext,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<PostResult> {
  const url = mcpEndpoint(ctx);
  const body = {
    jsonrpc: '2.0',
    id: nextRpcId++,
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  };

  let res: Response;
  console.log('[voice-agent] mcp tools/call ->', url, { tool: toolName, args });
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ctx.kortixApiToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    console.log('[voice-agent] mcp tools/call <-', url, res.status);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, kind: 'unreachable', error: `voice mcp ${toolName} unreachable: ${message}` };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return {
      ok: false,
      kind: 'unreachable',
      error: `voice mcp ${toolName} responded ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`,
    };
  }

  const rpc = (await res.json().catch(() => ({}))) as JsonRpcResponse;

  if (rpc.error) {
    return { ok: false, kind: 'unreachable', error: `voice mcp ${toolName}: ${rpc.error.message ?? 'protocol error'}` };
  }

  const toolResult = rpc.result;
  if (!toolResult) {
    return { ok: false, kind: 'unreachable', error: `voice mcp ${toolName}: empty response` };
  }
  if (toolResult.isError) {
    const text = (toolResult.content ?? [])
      .map((c) => c.text)
      .filter((t): t is string => Boolean(t))
      .join(' ');
    return { ok: false, kind: 'refused', error: text || `voice mcp ${toolName} failed` };
  }

  return { ok: true, data: toolResult.structuredContent ?? {} };
}

/**
 * Fire-and-forget hand-off to the Kortix agent session — the mirror of the
 * old `ask_kortix` → `continueSession()` call. Resolves the moment the
 * request is queued, never when Kortix finishes thinking: that answer, if
 * any, arrives later out-of-band (see inbound-replies.ts) and gets spoken
 * then, not returned from here.
 */
export async function sendPromptToKortix(
  ctx: CallContext,
  text: string,
): Promise<{ ok: true } | { ok: false; kind: PostFailureKind; error: string }> {
  const result = await callVoiceMcpTool(ctx, 'ask_kortix', { request: text }, PROMPT_TIMEOUT_MS);
  return result.ok ? { ok: true } : { ok: false, kind: result.kind, error: result.error };
}

export interface RunCommandResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  error?: string;
}

/**
 * Runs a short-lived command in the session's sandbox and waits for its
 * result — unlike `sendPromptToKortix`, this DOES wait, because the whole
 * point of `run_command` is "quick check, answer directly." The client-side
 * timeout is a backstop: even if apps/api's own server-side cap misbehaves,
 * this call always resolves within `RUN_COMMAND_TIMEOUT_MS` so a single slow
 * command can never wedge the call indefinitely.
 */
export async function runCommandInSandbox(
  ctx: CallContext,
  command: string,
  cwd?: string,
): Promise<RunCommandResult> {
  const result = await callVoiceMcpTool(
    ctx,
    'run_command',
    { command, ...(cwd ? { cwd } : {}) },
    RUN_COMMAND_TIMEOUT_MS,
  );
  if (!result.ok) return { ok: false, error: result.error };

  const data = result.data as Record<string, unknown>;
  return {
    ok: true,
    stdout: typeof data.stdout === 'string' ? data.stdout : '',
    stderr: typeof data.stderr === 'string' ? data.stderr : '',
    exitCode: typeof data.exit_code === 'number' ? data.exit_code : null,
    timedOut: data.timed_out === true,
  };
}

/**
 * Persists one transcript line to `voice_call_turns` — the mirror of the old
 * in-process `appendTurn()`. Fire-and-forget on purpose: a slow or failed
 * transcript write must never delay or interrupt the live conversation,
 * which is why callers do not `await` this (see transcripts.ts).
 */
export async function postTranscriptTurn(
  ctx: CallContext,
  role: 'user' | 'agent',
  text: string,
  speaker?: string | null,
): Promise<void> {
  const clean = text.trim();
  if (!clean) return;
  const result = await callVoiceMcpTool(
    ctx,
    'post_turn',
    { role, text: clean, speaker: speaker ?? null },
    TURN_TIMEOUT_MS,
  );
  if (!result.ok) {
    console.error('[voice-agent] transcript write failed', {
      callId: ctx.callId,
      role,
      error: result.error,
    });
  }
}
