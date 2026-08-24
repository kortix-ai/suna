/**
 * `kortix sessions queue` — the session's SERVER-SIDE prompt inbox.
 *
 * `sessions chat --prompt` hands a message straight to the runtime, so it is
 * lost if the sandbox is mid-turn, asleep, or unreachable. The inbox
 * (`/sessions/:id/prompts`) is durable Postgres: the control plane delivers the
 * prompt when the session can take it, and the row survives a closed terminal.
 * `chat --prompt --queue` posts there instead; these subcommands manage what is
 * waiting.
 */

import {
  emitJson,
  locateSessionAnywhere,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import type { ApiClient } from '../api/client.ts';
import type { ProjectSession } from '../api/types.ts';
import { C, help, pad, status } from '../style.ts';
import { sessionPromptDefaults } from './sessions-files.ts';

type CtxOpts = { projectArg?: string; hostArg?: string };

/** One row of the session's inbox. Delivered prompts are omitted — they are in
 *  the transcript. */
export interface SessionPrompt {
  prompt_id: string;
  client_message_id: string;
  message_id: string;
  state: 'queued' | 'delivering' | 'waiting' | 'failed';
  reason: string | null;
  text: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  available_at: string;
}

export interface CreateSessionPromptResult {
  prompt_id: string;
  state: SessionPrompt['state'];
  message_id: string;
  deduped: boolean;
}

const QUEUE_HELP = help`Usage: kortix sessions queue <session-id> [<subcommand>] [options]

The session's durable prompt inbox — messages the server still owes the agent.
A queued prompt survives a closed terminal and is delivered when the session
can take it. Put one there with \`kortix sessions chat <id> -p "…" --queue\`.

Subcommands:
  ls                   List everything still waiting (default). --json.
  rm <prompt-id>       Drop one prompt. Refused (409) once a model step has
                       started answering it.
  now <prompt-id>      Run this one next: re-queues it ahead of the ordering
                       rule and releases the session's hold.
  hold                 Hold every queued prompt (what the Stop button writes).
  release              Release the hold.

Options:
  --project <id>       Operate on this project id (default: linked).
  --host <name>        Operate against a non-default Kortix host.
  --json               Machine-readable output.
  -h, --help           Show this help.

Needs project.session.start — the same permission as sending a message.
`;

/**
 * Mint an OpenCode wire message id.
 *
 * The API refuses anything that is not `msg_` + 12 hex + 14 base62
 * (PROMPT_WIRE_MESSAGE_ID in apps/api/src/projects/routes/r8.ts): OpenCode
 * decides "has this prompt already been answered?" by id ORDER, so the id has
 * to sort above everything already on the transcript. Same construction as the
 * SDK's `ascendingId`, which is not on the public `@kortix/sdk` surface.
 */
export function wireMessageId(now = Date.now(), counter = 1): string {
  const encoded = BigInt(now) * BigInt(0x1000) + BigInt(counter);
  const hex = encoded.toString(16).padStart(12, '0').slice(0, 12);
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let random = '';
  for (let i = 0; i < 14; i += 1) random += chars[Math.floor(Math.random() * 62)];
  return `msg_${hex}${random}`;
}

/**
 * Put ONE prompt in a session's inbox. Resolving means the prompt is DURABLE,
 * not that the agent has seen it. The overrides carry the session's persisted
 * agent + model exactly as the dashboard captures them at submit time — a
 * prompt delivered without them lets OpenCode fall back to a model Kortix
 * sandboxes do not provision.
 */
export async function queueSessionPrompt(
  client: ApiClient,
  projectId: string,
  session: ProjectSession,
  text: string,
): Promise<CreateSessionPromptResult> {
  const defaults = sessionPromptDefaults(session);
  const body: Record<string, unknown> = {
    client_message_id: crypto.randomUUID(),
    message_id: wireMessageId(),
    parts: [{ type: 'text', text }],
    client_sent_at_ms: Date.now(),
  };
  if (defaults.agent || defaults.model) {
    body.overrides = {
      ...(defaults.agent ? { agent: defaults.agent } : {}),
      ...(defaults.model ? { model: defaults.model } : {}),
    };
  }
  return client.post<CreateSessionPromptResult>(
    `/projects/${projectId}/sessions/${session.session_id}/prompts`,
    body,
  );
}

export async function runSessionsQueue(argv: string[]): Promise<number> {
  const rest = [...argv];
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(QUEUE_HELP);
    return 0;
  }

  let projectArg: string | undefined;
  let hostArg: string | undefined;
  let json = false;
  try {
    projectArg = takeFlagValue(rest, ['--project']);
    hostArg = takeFlagValue(rest, ['--host']);
    json = takeFlagBool(rest, ['--json']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }

  const positional = rest.filter((a) => !a.startsWith('-'));
  const sessionId = positional[0];
  const sub = positional[1] ?? 'ls';
  if (!sessionId) {
    process.stderr.write(`${status.err('Pass a session id.')}\n\n${QUEUE_HELP}`);
    return 2;
  }
  if (!['ls', 'list', 'rm', 'now', 'hold', 'release'].includes(sub)) {
    process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${QUEUE_HELP}`);
    return 2;
  }
  if ((sub === 'rm' || sub === 'now') && !positional[2]) {
    process.stderr.write(
      `${status.err(`\`queue ${sub}\` needs a prompt id (see \`sessions queue ${sessionId} ls\`).`)}\n`,
    );
    return 2;
  }

  const opts: CtxOpts = { projectArg, hostArg };
  const located = await locateSessionAnywhere(
    sessionId,
    opts,
    (host) => `kortix sessions queue ${sessionId} ${sub} --host ${host}`,
  );
  if (!located) return 1;
  const { client, projectId, session } = located.located;
  const base = `/projects/${projectId}/sessions/${session.session_id}/prompts`;

  try {
    switch (sub) {
      case 'ls':
      case 'list': {
        const { prompts } = await client.get<{ prompts: SessionPrompt[] }>(base);
        return printQueue(prompts ?? [], json);
      }
      case 'rm': {
        const { removed } = await client.delete<{ removed: { prompt_id: string } }>(
          `${base}/${positional[2]}`,
        );
        if (json) {
          emitJson(removed);
          return 0;
        }
        process.stdout.write(
          `${status.ok(`Dropped prompt ${C.bold}${removed.prompt_id}${C.reset}`)}\n`,
        );
        return 0;
      }
      case 'now': {
        const prompt = await client.post<SessionPrompt>(`${base}/${positional[2]}/retry`, {});
        if (json) {
          emitJson(prompt);
          return 0;
        }
        process.stdout.write(
          `${status.ok(`Queued next ${C.bold}${prompt.prompt_id}${C.reset} ${C.dim}(${prompt.state})${C.reset}`)}\n`,
        );
        return 0;
      }
      case 'hold':
      case 'release': {
        const held = sub === 'hold';
        const { prompts } = await client.post<{ prompts: SessionPrompt[] }>(`${base}/hold`, {
          held,
        });
        if (json) {
          emitJson({ held, prompts: prompts ?? [] });
          return 0;
        }
        const count = (prompts ?? []).length;
        process.stdout.write(
          `${status.ok(
            held
              ? `Queue held — ${count} prompt${count === 1 ? '' : 's'} waiting. Release it, send a message, or \`queue now\` a row.`
              : `Queue released — ${count} prompt${count === 1 ? '' : 's'} waiting.`,
          )}\n`,
        );
        return 0;
      }
    }
  } catch (err) {
    return surfaceApiError(err);
  }
  return 0;
}

function printQueue(prompts: SessionPrompt[], json: boolean): number {
  if (json) {
    emitJson(prompts);
    return 0;
  }
  if (prompts.length === 0) {
    process.stdout.write(`  ${C.dim}Queue is empty — nothing waiting for this agent.${C.reset}\n`);
    return 0;
  }
  const idW = Math.max(...prompts.map((p) => p.prompt_id.length), 8);
  process.stdout.write('\n');
  process.stdout.write(
    `  ${C.dim}${pad('PROMPT', idW)}   STATE        REASON               TEXT${C.reset}\n`,
  );
  for (const p of prompts) {
    process.stdout.write(
      `  ${pad(p.prompt_id, idW)}   ${stateColor(p.state)}${pad(p.state, 11)}${C.reset}  ${pad(p.reason ?? '-', 19)}  ${oneLine(p.text)}\n`,
    );
    if (p.last_error) {
      process.stdout.write(`  ${C.faded}${pad('', idW)}   ${p.last_error}${C.reset}\n`);
    }
  }
  process.stdout.write(
    `\n  ${C.dim}${prompts.length} prompt${prompts.length === 1 ? '' : 's'} waiting${C.reset}\n\n`,
  );
  return 0;
}

function stateColor(state: SessionPrompt['state']): string {
  if (state === 'failed') return C.red;
  if (state === 'delivering') return C.green;
  return C.yellow;
}

function oneLine(text: string, max = 48): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
