import {
  classifySessionLogMessage,
  sessionLogCallStatus,
  sessionLogOfV1Rows,
  type SessionLogMessage,
} from '@kortix/sdk';
import { formatRelative } from '@kortix/shared';

import type { Auth } from '../api/auth.ts';
import type { ApiClient } from '../api/client.ts';
import { kortixFromAuth, withKortixScope } from '../api/sdk.ts';
import type { ProjectSession } from '../api/types.ts';
import {
  emitJson,
  resolveProjectContext,
  shortId,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
  fail,
} from '../command-helpers.ts';
import { resolveSessionRuntime } from '../session-runtime.ts';
import { C, help, pad } from '../style.ts';
import { withLiveTurn } from './sessions-chat.ts';

type CtxOpts = { projectArg?: string; hostArg?: string };

const DIGEST_HELP = help`Usage: kortix sessions digest [options]

Compact review of recent sessions for reflection / handoff. It lists sessions
in a time window and reads each one's stored session log, plus a running
session's open turn live from its sandbox. Tool calls are compressed to
name/status only; tool inputs and outputs are intentionally stripped so the
digest stays readable.

  --since <when>       Window start (default 7d). Examples: 24h, 7d,
                       2026-06-20, 2026-06-20T03:00:00Z.
  --messages, -n <N>   Recent messages per session (default 40).
  --chars <N>          Max text chars per message after whitespace compaction
                       (default 700).
  --all                Ignore --since and include every listable session.
  --json               Emit structured JSON for scripting.
  --project <id>       Operate on this project id (default: linked).
  --host <name>        Operate against a non-default Kortix host.
  -h, --help           Show this help.

Aliases: review, summary.

Notes:
- The transcript is the stored session log (source "log"), written at every
  turn end, plus a running session's open turn read live from its sandbox.
- A session with no stored log yet reports its transcript as unavailable, with
  the reason.
- No v1 transcript (GET …/transcript) is read.
`;

interface CompactToolCall {
  tool: string;
  status: string | null;
}

interface CompactMessage {
  role: string;
  created: string | null;
  completed: string | null;
  text: string;
  tools: CompactToolCall[];
  files: Array<{ filename: string | null; mime: string | null }>;
  reasoning_omitted: boolean;
  error: { name?: string; message?: string } | null;
}

interface SessionDigest {
  session: {
    session_id: string;
    name: string | null;
    agent: string;
    status: string;
    branch: string;
    base_ref: string;
    provider: string;
    sandbox_url: string | null;
    created_at: string;
    updated_at: string;
    error: string | null;
    /** The session's root conversation in its runtime (OpenCode or pi). */
    runtime_session_id: string | null;
    /** Titles of the runtime's conversations. */
    runtime_titles: string[];
    /** @deprecated The pre-W4 name of `runtime_session_id`. Same value. */
    opencode_session_id: string | null;
    /** @deprecated The pre-W4 name of `runtime_titles`. Same value. */
    opencode_titles: string[];
  };
  transcript: {
    available: boolean;
    reason: string | null;
    /** Where the messages came from: the stored session log, or nowhere. `live` and `mirror`
     *  are the pre-P8.3 values; this CLI no longer answers them. */
    source: 'live' | 'mirror' | 'log' | 'none';
    /** The mirror proved it holds the session's first message AND returned
     *  every row it holds. Never a guess — see `mirrorIsComplete`. */
    complete: boolean;
    runtime_session_id: string | null;
    /** @deprecated The pre-W4 name of `runtime_session_id`. Same value. */
    opencode_session_id: string | null;
    message_count: number;
    messages: CompactMessage[];
  };
}

export async function runSessionsDigest(argv: string[]): Promise<number> {
  const rest = [...argv];
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(`${DIGEST_HELP}\n`);
    return 0;
  }

  let projectArg: string | undefined;
  let hostArg: string | undefined;
  let sinceRaw: string | undefined;
  let messageLimitRaw: string | undefined;
  let charsRaw: string | undefined;
  let json = false;
  let all = false;
  try {
    projectArg = takeFlagValue(rest, ['--project']);
    hostArg = takeFlagValue(rest, ['--host']);
    sinceRaw = takeFlagValue(rest, ['--since']);
    messageLimitRaw = takeFlagValue(rest, ['--messages', '--limit', '-n']);
    charsRaw = takeFlagValue(rest, ['--chars']);
    json = takeFlagBool(rest, ['--json']);
    all = takeFlagBool(rest, ['--all']);
  } catch (err) {
    return fail((err as Error).message);
  }
  const positional = rest.filter((a) => !a.startsWith('-'));
  if (positional.length > 0) return fail('sessions digest does not take positional arguments.');

  const messageLimit = messageLimitRaw === undefined ? 40 : Number(messageLimitRaw);
  if (!Number.isInteger(messageLimit) || messageLimit <= 0 || messageLimit > 500) {
    return fail(`Invalid --messages "${messageLimitRaw}" (use 1-500).`);
  }
  const maxChars = charsRaw === undefined ? 700 : Number(charsRaw);
  if (!Number.isInteger(maxChars) || maxChars < 80 || maxChars > 5000) {
    return fail(`Invalid --chars "${charsRaw}" (use 80-5000).`);
  }
  const since = all ? null : parseSince(sinceRaw ?? '7d');
  if (!all && !since) return fail(`Could not parse --since "${sinceRaw}".`);

  const opts: CtxOpts = { projectArg, hostArg };
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;

  let sessions: ProjectSession[];
  try {
    sessions = await ctx.client.get<ProjectSession[]>(
      `/projects/${ctx.projectId}/sessions`,
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  const filtered = sessions
    .filter((s) => all || isInWindow(s, since!))
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));

  const digests = new Map<string, SessionDigest>();
  await mapLimit(filtered, 6, async (s) => {
    digests.set(s.session_id, await buildLogDigest(s, ctx.auth, ctx.client, ctx.projectId, messageLimit, maxChars));
  });
  const out = filtered.map((s) => digests.get(s.session_id)!).filter(Boolean);

  if (json) {
    emitJson({
      since: since ? since.toISOString() : null,
      all,
      messages_per_session: messageLimit,
      chars_per_message: maxChars,
      sessions: out,
    });
    return 0;
  }

  printHumanDigest(out, {
    since,
    all,
    messageLimit,
    maxChars,
  });
  return 0;
}

/**
 * The root thread's newest `limit` messages from the stored session log (`GET …/log`), and a
 * running session's open turn from its sandbox (as `sessions log`). No v1 transcript route is
 * read (P8.3).
 */
async function buildLogDigest(
  s: ProjectSession,
  auth: Auth,
  client: ApiClient,
  projectId: string,
  limit: number,
  maxChars: number,
): Promise<SessionDigest> {
  const base = baseDigest(s);
  try {
    const page = await withKortixScope(auth, () => kortixFromAuth(auth).session(projectId, s.session_id).log({ limit }));
    const head = page?.threads.find((thread) => thread.thread_id === page.thread_id);
    let threads = page && head ? [{ ...head, messages: page.messages, has_more: page.has_more }] : [];
    if (s.status === 'running') {
      try {
        const runtime = await resolveSessionRuntime({ auth, client, projectId, session: s });
        const live = await withKortixScope(auth, () => runtime.handle.messages({ conversationId: runtime.runtimeSessionId, limit }));
        const liveThread = sessionLogOfV1Rows(s.session_id, runtime.runtimeSessionId, live.messages).threads[0];
        if (liveThread) threads = withLiveTurn(threads, liveThread, limit);
      } catch {
        // A box that does not answer: the stored log is the conversation up to its last turn.
      }
    }
    const root = threads.find((thread) => thread.parent_thread_id === null) ?? threads[0];
    if (!root) {
      base.transcript.reason = 'no stored session log yet';
      return base;
    }
    base.transcript = {
      ...base.transcript,
      available: true,
      source: 'log',
      complete: !root.has_more,
      message_count: root.messages.length,
      messages: root.messages.map((message) => compactLogMessage(message, maxChars)),
    };
  } catch (err) {
    base.transcript.reason = `could not read the session log: ${(err as Error).message}`;
  }
  return base;
}

/** One session-log message as a digest row: text, tool names and statuses, files; no tool input or output. */
export function compactLogMessage(message: SessionLogMessage, maxChars: number): CompactMessage {
  const streaming = message.status === 'streaming';
  const text = message.blocks
    .flatMap((block) => (block.type === 'text' && !block.synthetic && block.text ? [block.text] : []))
    .join('\n');
  const compacted = text.replace(/\s+/g, ' ').trim();
  return {
    role: message.role,
    created: message.created_at || null,
    completed: message.completed_at,
    text: compacted.length <= maxChars ? compacted : `${compacted.slice(0, maxChars - 1)}…`,
    tools: message.blocks.flatMap((block) => (block.type === 'tool_call' ? [{ tool: block.name, status: sessionLogCallStatus(block, streaming) }] : [])),
    files: message.blocks.flatMap((block) => (block.type === 'attachment' ? [{ filename: block.name ?? null, mime: block.mime ?? null }] : [])),
    reasoning_omitted: message.blocks.some((block) => block.type === 'reasoning'),
    error: classifySessionLogMessage(message).error ?? null,
  };
}

function baseDigest(s: ProjectSession): SessionDigest {
  return {
    session: {
      session_id: s.session_id,
      name: s.name,
      agent: s.agent_name,
      status: s.status,
      branch: s.branch_name,
      base_ref: s.base_ref,
      provider: s.sandbox_provider,
      sandbox_url: s.sandbox_url,
      created_at: s.created_at,
      updated_at: s.updated_at,
      error: s.error,
      runtime_session_id: runtimeSessionIdOf(s),
      runtime_titles: runtimeTitles(s),
      opencode_session_id: runtimeSessionIdOf(s),
      opencode_titles: runtimeTitles(s),
    },
    transcript: {
      available: false,
      reason: null,
      source: 'none',
      complete: false,
      runtime_session_id: runtimeSessionIdOf(s),
      opencode_session_id: runtimeSessionIdOf(s),
      message_count: 0,
      messages: [],
    },
  };
}

function printHumanDigest(
  digests: SessionDigest[],
  opts: {
    since: Date | null;
    all: boolean;
    messageLimit: number;
    maxChars: number;
  },
): void {
  const window = opts.all ? 'all listable sessions' : `sessions since ${opts.since!.toISOString()}`;
  process.stdout.write(`\n${C.bold}Session digest${C.reset} ${C.faded}(${window}; last ${opts.messageLimit} messages/session; ${opts.maxChars} chars/message)${C.reset}\n`);
  process.stdout.write(`${C.dim}Tool inputs/outputs are stripped; only tool names/statuses are shown.${C.reset}\n`);
  if (digests.length === 0) {
    process.stdout.write(`\n  ${C.dim}No sessions matched.${C.reset}\n\n`);
    return;
  }

  const labelW = Math.max(...digests.map((d) => (d.session.name ?? shortId(d.session.session_id)).length), 4);
  for (const d of digests) {
    const s = d.session;
    const label = s.name ?? shortId(s.session_id);
    process.stdout.write(`\n${C.bold}${pad(label, labelW)}${C.reset} ${statusLabel(s.status)} ${C.faded}${shortId(s.session_id)} · agent ${s.agent} · updated ${formatRelative(s.updated_at, { maxRelativeDays: null })}${C.reset}\n`);
    process.stdout.write(`  ${C.dim}branch${C.reset} ${s.branch}  ${C.dim}base${C.reset} ${s.base_ref}  ${C.dim}provider${C.reset} ${s.provider}\n`);
    process.stdout.write(`  ${C.dim}created${C.reset} ${s.created_at}  ${C.dim}updated${C.reset} ${s.updated_at}\n`);
    if (s.error) process.stdout.write(`  ${C.red}error${C.reset} ${s.error}\n`);
    if (s.runtime_titles.length > 0) {
      process.stdout.write(`  ${C.dim}runtime titles${C.reset} ${s.runtime_titles.map((t) => truncate(t, 80)).join(' | ')}\n`);
    }

    if (!d.transcript.available) {
      process.stdout.write(`  ${C.dim}transcript${C.reset} unavailable — ${d.transcript.reason ?? 'unknown'}\n`);
      continue;
    }
    if (d.transcript.messages.length === 0) {
      process.stdout.write(`  ${C.dim}transcript${C.reset} no messages\n`);
      continue;
    }
    // Say where it came from and whether it is the whole thing. A saved
    // transcript that stops short must not read like a complete one.
    const origin = d.transcript.source === 'mirror'
      ? `${C.faded} · saved${d.transcript.complete ? '' : ', partial'}${C.reset}`
      : '';
    process.stdout.write(`  ${C.dim}transcript${C.reset} ${d.transcript.message_count} compact message${d.transcript.message_count === 1 ? '' : 's'}${origin}\n`);
    for (const m of d.transcript.messages) {
      const who = m.role === 'assistant' ? C.cyan : C.green;
      const at = m.created ? ` ${C.faded}${new Date(m.created).toISOString()}${C.reset}` : '';
      const toolText = summarizeTools(m.tools);
      const fileText = m.files.length ? ` files: ${m.files.map((f) => f.filename ?? f.mime ?? 'file').join(', ')}` : '';
      const reasoning = m.reasoning_omitted ? ' reasoning omitted;' : '';
      process.stdout.write(`    - ${who}${m.role}${C.reset}${at}: ${m.text || C.dim + '(no text)' + C.reset}\n`);
      if (toolText || fileText || reasoning || m.error) {
        const bits = [toolText ? `tools: ${toolText}` : '', fileText.trim(), reasoning.trim(), m.error ? `error: ${m.error.message ?? m.error.name ?? 'unknown'}` : '']
          .filter(Boolean)
          .join('; ');
        process.stdout.write(`      ${C.dim}${bits}${C.reset}\n`);
      }
    }
  }
  process.stdout.write('\n');
}

function summarizeTools(tools: CompactToolCall[]): string {
  if (tools.length === 0) return '';
  const counts = new Map<string, number>();
  for (const t of tools) {
    const key = `${t.tool}${t.status ? `:${t.status}` : ''}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const parts = Array.from(counts.entries()).map(([key, count]) => count > 1 ? `${key}×${count}` : key);
  return parts.length > 12 ? `${parts.slice(0, 12).join(', ')}, … +${parts.length - 12}` : parts.join(', ');
}

/** The runtime root id: a W4 API serves `runtime_session_id`, an older one `opencode_session_id`. */
function runtimeSessionIdOf(s: ProjectSession): string | null {
  return s.runtime_session_id ?? s.opencode_session_id ?? null;
}

function runtimeTitles(s: ProjectSession): string[] {
  const raw = s.runtime_sessions ?? s.metadata?.opencode_sessions;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const title = (entry as { title?: unknown }).title;
      return typeof title === 'string' && title.trim() ? title.trim() : null;
    })
    .filter((t): t is string => Boolean(t));
}

function isInWindow(s: ProjectSession, since: Date): boolean {
  return Date.parse(s.updated_at) >= since.getTime() || Date.parse(s.created_at) >= since.getTime();
}

export function parseSince(raw: string): Date | null {
  const trimmed = raw.trim();
  const rel = trimmed.match(/^(\d+(?:\.\d+)?)(m|h|d|w)$/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    const minutes = unit === 'm' ? n : unit === 'h' ? n * 60 : unit === 'd' ? n * 60 * 24 : n * 60 * 24 * 7;
    return new Date(Date.now() - minutes * 60_000);
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async (): Promise<void> => {
    while (i < items.length) {
      const idx = i;
      i += 1;
      await fn(items[idx]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

function statusLabel(s: string): string {
  switch (s) {
    case 'running':
      return `${C.green}${s}${C.reset}`;
    case 'failed':
      return `${C.red}${s}${C.reset}`;
    case 'stopped':
    case 'completed':
      return `${C.faded}${s}${C.reset}`;
    default:
      return `${C.yellow}${s}${C.reset}`;
  }
}
