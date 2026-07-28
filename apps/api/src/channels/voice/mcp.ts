/**
 * The voice MCP — how apps/voice-agent (the LiveKit worker, a SEPARATE
 * process — see runtime.ts's file header) calls back INTO Kortix.
 *
 * JSON-RPC 2.0 over streamable HTTP, mounted at
 * /v1/projects/:projectId/sessions/:sessionId/mcp/voice (routes.ts). The
 * caller is not a Kortix agent — it is a third-party-hosted worker process
 * holding the per-call `kortix_api_token` HMAC minted in `startCall`
 * (worker-token.ts) and handed to it via private LiveKit dispatch metadata. That token
 * authorizes exactly one call; nothing here accepts session/PAT auth.
 *
 * This used to be the OTHER direction: the Kortix agent's own tool surface
 * for driving a call (voice_spawn/voice_read/send_prompt/run_command/
 * voice_end). That surface has moved to the `kortix_voice` channel connector
 * (executor/channels.ts's VOICE_ACTIONS, executed by executeVoiceCall in
 * executor/db-deps.ts) so it goes through the executor gateway like every
 * other connector call — policies, approvals, audit trail included, which a
 * direct MCP route never had. This file is now free to be what the worker
 * actually needs.
 *
 * THE INVARIANT: every tool returns quickly. `ask_kortix` in particular MUST
 * stay non-blocking — it hands the request to `askKortix` (runtime.ts) and
 * returns the instant that's queued, never waiting for the Kortix turn (which
 * runs 30s-10min). A voice call has no error boundary except "the agent goes
 * quiet", which blocking here would trigger immediately. `run_command` is the
 * one deliberate, SHORT-bounded exception — it waits, but only up to a hard
 * cap well under the worker's own client-side timeout (see run-command.ts).
 *
 * Naming note: the OLD Kortix-facing MCP had a `send_prompt` meaning "make
 * the voice agent speak into the call." The worker's OWN `send_prompt` tool
 * (apps/voice-agent/src/tools.ts) means the opposite — "ask Kortix to work."
 * That collision is why this file's hand-off tool is `ask_kortix`, not
 * `send_prompt`: same direction as the worker's tool, and unambiguous now
 * that the speak-into-the-call meaning lives only in the connector.
 */
type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

export interface RunCommandToolResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface VoiceMcpContext {
  projectId: string;
  sessionId: string;
  callId: string;
  /** Fire-and-forget hand-off to the Kortix session. Never awaits the turn. */
  askKortix(request: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Waits (short, bounded) for a shell command's result in the call's sandbox. */
  runCommand(command: string, cwd?: string): Promise<RunCommandToolResult>;
  /**
   * Persists one transcript line. 'user'/'agent' are either side of the spoken
   * conversation (the worker's own `post_turn` tool, below). 'tool' is written
   * for the worker, never by it — see `callTool`'s `run_command` case here, and
   * `askKortix`/`settleAsk` in runtime.ts for the hand-off pair, which moved out
   * of this file because those rows double as the in-flight flag.
   */
  postTurn(role: 'user' | 'agent' | 'tool', text: string, speaker?: string | null): Promise<void>;
}

/** Keeps a transcript line bounded — this is a permanent DB row, not a live
 *  render, and `command`/`request` are free text the model (or a human in the
 *  call) wrote. */
function truncateForTranscript(text: string, max: number): string {
  const clean = text.trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** One line summarizing a `run_command` result for the transcript — never the
 *  full stdout/stderr (that already went back to the model in the tool result
 *  above; the transcript just needs to say what ran and how it ended). */
function summarizeRunCommandOutcome(result: RunCommandToolResult): string {
  if (result.timedOut) return 'timed out';
  if (result.exitCode !== null && result.exitCode !== 0) return `exit ${result.exitCode}`;
  return 'ok';
}

const PROTOCOL_VERSION = '2025-06-18';

function toolDefinitions() {
  return [
    {
      name: 'ask_kortix',
      description:
        'Hand a request to the Kortix agent for this call. Use for anything needing real project ' +
        'knowledge, files, connectors, memory, or actions. Returns the instant the request is ' +
        'queued — NEVER waits for Kortix to finish thinking, which can take minutes. The answer, ' +
        'if any, arrives later as a separate message to speak into the call. ONE request at a ' +
        'time: while an earlier one is still unanswered this is refused, with an explanation to ' +
        'relay. Do not re-send a request to chase or double-check an answer you already got.',
      inputSchema: {
        type: 'object',
        properties: {
          request: {
            type: 'string',
            description: "What was asked, in the speaker's own words, plus who asked it.",
          },
        },
        required: ['request'],
        additionalProperties: false,
      },
    },
    {
      name: 'run_command',
      description:
        "Run a shell command in this call's sandbox and get its output back directly — for quick " +
        'checks only (reading a short file, listing a directory, checking something exists). Waits ' +
        'a few seconds and returns the result. Bounded by a short server-side timeout, so a ' +
        'long-running command reports timed_out with whatever output arrived before the cutoff. Not ' +
        'a hand-off — use ask_kortix for anything that changes state or needs judgement.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command, run via `bash -lc`.' },
          cwd: {
            type: 'string',
            description: 'Working directory, relative to the project root. Defaults to the project root.',
          },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
    {
      name: 'post_turn',
      description:
        'Persist one line of the live transcript — either side of the conversation. Returns immediately.',
      inputSchema: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: ['user', 'agent'] },
          text: { type: 'string' },
          speaker: { type: 'string', description: 'Optional display name for a user-role turn.' },
        },
        required: ['role', 'text'],
        additionalProperties: false,
      },
    },
  ];
}

function ok(id: JsonRpcId, value: unknown) {
  return { jsonrpc: '2.0', id, result: value };
}

function fail(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolText(text: string, structured?: unknown) {
  return {
    content: [{ type: 'text', text }],
    ...(structured === undefined ? {} : { structuredContent: structured }),
  };
}

function toolError(message: string) {
  return { isError: true, ...toolText(message) };
}

async function callTool(
  ctx: VoiceMcpContext,
  name: unknown,
  rawArgs: unknown,
): Promise<Record<string, unknown>> {
  const args = rawArgs && typeof rawArgs === 'object' ? (rawArgs as Record<string, unknown>) : {};

  switch (name) {
    case 'ask_kortix': {
      const request = String(args.request ?? '').trim();
      if (!request) return toolError('request is required');
      const result = await ctx.askKortix(request);
      // A refusal is a tool error so the model SEES it, but the text is
      // guidance, not a fault report — runtime.ts refuses an ask that is
      // already outstanding, or a call that is repeating itself, and writes
      // the sentence it wants relayed. apps/voice-agent passes it through.
      if (!result.ok) return toolError(result.error);
      // NOTE: the `ask_kortix: …` transcript line is NOT written here any more.
      // It is the in-flight flag that stops a second overlapping hand-off
      // (ask-ledger.ts), so it has to be written and AWAITED inside askKortix,
      // before the next ask can read it — a fire-and-forget write from this
      // layer let two rapid asks both see an empty ledger, and could land
      // AFTER the settle row of a hand-off that failed instantly.
      return toolText('Queued — Kortix is working on it. The answer will arrive later as something to say.', {
        queued: true,
      });
    }

    case 'run_command': {
      const command = String(args.command ?? '').trim();
      if (!command) return toolError('command is required');
      const cwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : undefined;
      const label = truncateForTranscript(`run_command: ${command}`, 400);
      try {
        const result = await ctx.runCommand(command, cwd);
        void ctx
          .postTurn('tool', `${label} → ${summarizeRunCommandOutcome(result)}`, 'run_command')
          .catch((err) => console.error('[voice] run_command transcript log failed', err));
        return toolText(result.stdout || '(no output)', {
          stdout: result.stdout,
          stderr: result.stderr,
          exit_code: result.exitCode,
          timed_out: result.timedOut,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void ctx
          .postTurn('tool', `${label} → failed`, 'run_command')
          .catch((logErr) => console.error('[voice] run_command transcript log failed', logErr));
        return toolError(message);
      }
    }

    case 'post_turn': {
      const role = args.role === 'agent' ? 'agent' : args.role === 'user' ? 'user' : null;
      const text = String(args.text ?? '').trim();
      const speaker = typeof args.speaker === 'string' && args.speaker.trim() ? args.speaker.trim() : null;
      if (!role) return toolError('role must be "user" or "agent"');
      if (!text) return toolError('text must not be empty');
      await ctx.postTurn(role, text, speaker);
      return toolText('Recorded.', { ok: true });
    }

    default:
      return toolError(`Unknown tool: ${String(name)}`);
  }
}

export async function handleVoiceMcp(
  ctx: VoiceMcpContext,
  req: JsonRpcRequest,
): Promise<Record<string, unknown> | null> {
  const id = req.id ?? null;

  switch (req.method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'kortix-voice-worker', version: '1.0.0' },
      });

    case 'ping':
      return ok(id, {});

    case 'notifications/initialized':
      return null; // notification — no response

    case 'tools/list':
      return ok(id, { tools: toolDefinitions() });

    case 'tools/call': {
      const params = req.params ?? {};
      try {
        return ok(id, await callTool(ctx, params.name, params.arguments));
      } catch (err) {
        // Surface as a tool error, not a protocol error: the caller can read
        // and react to the former, while the latter usually just aborts.
        return ok(id, toolError(err instanceof Error ? err.message : String(err)));
      }
    }

    default:
      return fail(id, -32601, `Method not found: ${req.method ?? '(none)'}`);
  }
}
