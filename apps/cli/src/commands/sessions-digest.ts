import type { ApiClient } from '../api/client.ts';
import type { ProjectSession } from '../api/types.ts';
import {
  emitJson,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { C, pad, status } from '../style.ts';

type CtxOpts = { projectArg?: string; hostArg?: string };

const DIGEST_HELP = `Usage: kortix sessions digest [options]

Compact review of recent sessions for reflection / handoff. It lists sessions
in a time window and, for running sessions, reads the live OpenCode transcript
through the project sessions API. Tool calls are compressed to name/status only;
tool inputs and outputs are intentionally stripped so the digest stays readable.

  --since <when>       Window start (default 7d). Examples: 24h, 7d,
                       2026-06-20, 2026-06-20T03:00:00Z.
  --messages, -n <N>   Recent OpenCode messages per running session (default 40).
  --chars <N>          Max text chars per message after whitespace compaction
                       (default 700).
  --all                Ignore --since and include every listable session.
  --json               Emit structured JSON for scripting.
  --project <id>       Operate on this project id (default: linked).
  --host <name>        Operate against a non-default Kortix host.
  -h, --help           Show this help.

Aliases: review, summary.

Notes:
- Running sessions include a compact transcript when the sandbox is reachable.
- Stopped/failed sessions include metadata and any mirrored OpenCode titles, but
  their transcript is unavailable unless the sandbox is running/resumed.
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
    opencode_session_id: string | null;
    opencode_titles: string[];
  };
  transcript: {
    available: boolean;
    reason: string | null;
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
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const positional = rest.filter((a) => !a.startsWith('-'));
  if (positional.length > 0) {
    process.stderr.write(`${status.err('sessions digest does not take positional arguments.')}\n`);
    return 2;
  }

  const messageLimit = messageLimitRaw === undefined ? 40 : Number(messageLimitRaw);
  if (!Number.isInteger(messageLimit) || messageLimit <= 0 || messageLimit > 500) {
    process.stderr.write(`${status.err(`Invalid --messages "${messageLimitRaw}" (use 1-500).`)}\n`);
    return 2;
  }
  const maxChars = charsRaw === undefined ? 700 : Number(charsRaw);
  if (!Number.isInteger(maxChars) || maxChars < 80 || maxChars > 5000) {
    process.stderr.write(`${status.err(`Invalid --chars "${charsRaw}" (use 80-5000).`)}\n`);
    return 2;
  }
  const since = all ? null : parseSince(sinceRaw ?? '7d');
  if (!all && !since) {
    process.stderr.write(`${status.err(`Could not parse --since "${sinceRaw}".`)}\n`);
    return 2;
  }

  const opts: CtxOpts = { projectArg, hostArg };
  const ctx = resolveProjectContext(opts);
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
    digests.set(
      s.session_id,
      await buildDigest(s, ctx.client, ctx.projectId, messageLimit, maxChars),
    );
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

async function buildDigest(
  s: ProjectSession,
  client: ApiClient,
  projectId: string,
  messageLimit: number,
  maxChars: number,
): Promise<SessionDigest> {
  const base = baseDigest(s);
  if (s.status !== 'running') {
    base.transcript.reason = `session is ${s.status}; live transcript requires a running sandbox`;
    return base;
  }
  try {
    const transcript = await client.get<unknown>(
      `/projects/${projectId}/sessions/${s.session_id}/transcript?limit=${messageLimit}&chars=${maxChars}`,
    );
    base.transcript = sanitizeTranscript(transcript, s.opencode_session_id);
    return base;
  } catch (err) {
    base.transcript.reason = `could not read session transcript: ${(err as Error).message}`;
    return base;
  }
}

function sanitizeTranscript(raw: unknown, fallbackOpencodeSessionId: string | null): SessionDigest['transcript'] {
  const obj = typeof raw === 'object' && raw ? raw as Record<string, unknown> : {};
  const messages = Array.isArray(obj.messages)
    ? obj.messages.map(sanitizeCompactMessage)
    : [];
  const count = typeof obj.message_count === 'number' && Number.isFinite(obj.message_count)
    ? obj.message_count
    : messages.length;
  return {
    available: obj.available === true,
    reason: typeof obj.reason === 'string' ? obj.reason : null,
    opencode_session_id: typeof obj.opencode_session_id === 'string'
      ? obj.opencode_session_id
      : fallbackOpencodeSessionId,
    message_count: count,
    messages,
  };
}

function sanitizeCompactMessage(raw: unknown): CompactMessage {
  const obj = typeof raw === 'object' && raw ? raw as Record<string, unknown> : {};
  const tools = Array.isArray(obj.tools)
    ? obj.tools.map((tool) => {
        const t = typeof tool === 'object' && tool ? tool as Record<string, unknown> : {};
        return {
          tool: typeof t.tool === 'string' ? t.tool : 'tool',
          status: typeof t.status === 'string' ? t.status : null,
        };
      })
    : [];
  const files = Array.isArray(obj.files)
    ? obj.files.map((file) => {
        const f = typeof file === 'object' && file ? file as Record<string, unknown> : {};
        return {
          filename: typeof f.filename === 'string' ? f.filename : null,
          mime: typeof f.mime === 'string' ? f.mime : null,
        };
      })
    : [];
  const error = typeof obj.error === 'object' && obj.error
    ? obj.error as { name?: string; message?: string }
    : null;
  return {
    role: typeof obj.role === 'string' ? obj.role : 'unknown',
    created: typeof obj.created === 'string' ? obj.created : null,
    completed: typeof obj.completed === 'string' ? obj.completed : null,
    text: typeof obj.text === 'string' ? obj.text : '',
    tools,
    files,
    reasoning_omitted: obj.reasoning_omitted === true,
    error,
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
      opencode_session_id: s.opencode_session_id,
      opencode_titles: opencodeTitles(s),
    },
    transcript: {
      available: false,
      reason: null,
      opencode_session_id: s.opencode_session_id,
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
    process.stdout.write(`\n${C.bold}${pad(label, labelW)}${C.reset} ${statusLabel(s.status)} ${C.faded}${shortId(s.session_id)} · agent ${s.agent} · updated ${relAge(s.updated_at)}${C.reset}\n`);
    process.stdout.write(`  ${C.dim}branch${C.reset} ${s.branch}  ${C.dim}base${C.reset} ${s.base_ref}  ${C.dim}provider${C.reset} ${s.provider}\n`);
    process.stdout.write(`  ${C.dim}created${C.reset} ${s.created_at}  ${C.dim}updated${C.reset} ${s.updated_at}\n`);
    if (s.error) process.stdout.write(`  ${C.red}error${C.reset} ${s.error}\n`);
    if (s.opencode_titles.length > 0) {
      process.stdout.write(`  ${C.dim}opencode titles${C.reset} ${s.opencode_titles.map((t) => truncate(t, 80)).join(' | ')}\n`);
    }

    if (!d.transcript.available) {
      process.stdout.write(`  ${C.dim}transcript${C.reset} unavailable — ${d.transcript.reason ?? 'unknown'}\n`);
      continue;
    }
    if (d.transcript.messages.length === 0) {
      process.stdout.write(`  ${C.dim}transcript${C.reset} no messages\n`);
      continue;
    }
    process.stdout.write(`  ${C.dim}transcript${C.reset} ${d.transcript.message_count} compact message${d.transcript.message_count === 1 ? '' : 's'}\n`);
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

function opencodeTitles(s: ProjectSession): string[] {
  const raw = s.metadata?.opencode_sessions;
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

function shortId(id: string): string {
  return id.split('-')[0] ?? id;
}

function relAge(iso: string): string {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
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
