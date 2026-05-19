import { spawnSync } from 'node:child_process';
import { loadAuth } from '../api/auth.ts';
import {
  resolveProjectContext,
  surfaceApiError,
  takeFlagValue,
} from '../command-helpers.ts';
import { C, pad, status } from '../style.ts';
import type { ProjectSession } from '../api/types.ts';

const HELP = `Usage: kortix sessions <subcommand> [options]

Manage Kortix project sessions — each session is an isolated sandbox VM
on its own ephemeral branch.

Subcommands:
  ls                                List sessions on the project.
  new [--prompt "<text>"]           Start a new session, optionally with
                                    an initial prompt. Prints the new
                                    session id + status.
  info <session-id>                 Show one session.
  restart <session-id>              Restart (re-provision) a session.
  rm <session-id>                   Stop + delete a session.
  open <session-id>                 Open the dashboard URL for a session.

Global options:
  --project <id>     Operate on this project id (default: linked).
  -h, --help         Show this help.
`;

export async function runSessions(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }

  const sub = argv[0];
  const rest = argv.slice(1);
  let projectFlag: string | undefined;
  let promptFlag: string | undefined;
  try {
    projectFlag = takeFlagValue(rest, ['--project']);
    promptFlag = takeFlagValue(rest, ['--prompt', '-p']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }

  switch (sub) {
    case 'ls':
      return sessionsLs(projectFlag);
    case 'new':
    case 'create':
      return sessionsNew(promptFlag, projectFlag);
    case 'info':
    case 'show':
      return sessionsInfo(rest[0], projectFlag);
    case 'restart':
      return sessionsRestart(rest[0], projectFlag);
    case 'rm':
    case 'delete':
      return sessionsRm(rest[0], projectFlag);
    case 'open':
      return sessionsOpen(rest[0], projectFlag);
    default:
      process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
      return 2;
  }
}

async function sessionsLs(projectArg?: string): Promise<number> {
  const ctx = resolveProjectContext(projectArg);
  if (!ctx) return 1;

  let sessions: ProjectSession[];
  try {
    sessions = await ctx.client.get<ProjectSession[]>(
      `/projects/${ctx.projectId}/sessions`,
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  if (sessions.length === 0) {
    process.stdout.write(`  ${C.dim}No sessions yet — start one with \`kortix sessions new\`.${C.reset}\n`);
    return 0;
  }

  const labels = sessions.map((s) => s.name ?? shortId(s.session_id));
  const labelW = Math.max(...labels.map((l) => l.length), 6);
  process.stdout.write('\n');
  process.stdout.write(
    `  ${C.dim}${pad('NAME', labelW)}   STATUS         BRANCH                                    UPDATED${C.reset}\n`,
  );
  for (const s of sessions) {
    const label = s.name ?? shortId(s.session_id);
    const branch = trimMid(s.branch_name, 40);
    process.stdout.write(
      `  ${pad(label, labelW)}   ${statusColor(s.status)}${pad(s.status, 13)}${C.reset}  ${pad(branch, 40)}  ${C.faded}${formatRelative(s.updated_at)}${C.reset}\n`,
    );
  }
  process.stdout.write(`\n  ${C.dim}${sessions.length} session${sessions.length === 1 ? '' : 's'}${C.reset}\n\n`);
  return 0;
}

async function sessionsNew(prompt: string | undefined, projectArg?: string): Promise<number> {
  const ctx = resolveProjectContext(projectArg);
  if (!ctx) return 1;

  const body: Record<string, unknown> = {};
  if (prompt) body.initial_prompt = prompt;

  let created: ProjectSession;
  try {
    created = await ctx.client.post<ProjectSession>(
      `/projects/${ctx.projectId}/sessions`,
      body,
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  process.stdout.write(`\n${status.ok(`Session started ${C.bold}${shortId(created.session_id)}${C.reset}`)}\n`);
  process.stdout.write(`  ${C.dim}session_id ${C.reset}${created.session_id}\n`);
  process.stdout.write(`  ${C.dim}status     ${C.reset}${created.status}\n`);
  process.stdout.write(`  ${C.dim}branch     ${C.reset}${created.branch_name}\n`);
  if (created.sandbox_url) {
    process.stdout.write(`  ${C.dim}sandbox    ${C.reset}${created.sandbox_url}\n`);
  }
  process.stdout.write('\n');
  return 0;
}

async function sessionsInfo(sessionId: string | undefined, projectArg?: string): Promise<number> {
  if (!sessionId) {
    process.stderr.write(`${status.err('Pass a session id.')}\n`);
    return 2;
  }
  const ctx = resolveProjectContext(projectArg);
  if (!ctx) return 1;

  let s: ProjectSession;
  try {
    s = await ctx.client.get<ProjectSession>(
      `/projects/${ctx.projectId}/sessions/${sessionId}`,
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  process.stdout.write('\n');
  process.stdout.write(`  ${C.bold}${s.name ?? shortId(s.session_id)}${C.reset}\n`);
  process.stdout.write(`  ${C.dim}session_id ${C.reset}${s.session_id}\n`);
  process.stdout.write(`  ${C.dim}status     ${C.reset}${statusColor(s.status)}${s.status}${C.reset}\n`);
  process.stdout.write(`  ${C.dim}branch     ${C.reset}${s.branch_name}\n`);
  process.stdout.write(`  ${C.dim}base_ref   ${C.reset}${s.base_ref}\n`);
  process.stdout.write(`  ${C.dim}agent      ${C.reset}${s.agent_name}\n`);
  process.stdout.write(`  ${C.dim}provider   ${C.reset}${s.sandbox_provider}\n`);
  if (s.sandbox_url) {
    process.stdout.write(`  ${C.dim}sandbox    ${C.reset}${s.sandbox_url}\n`);
  }
  if (s.error) {
    process.stdout.write(`  ${C.dim}error      ${C.reset}${C.red}${s.error}${C.reset}\n`);
  }
  process.stdout.write(`  ${C.dim}created    ${C.reset}${formatRelative(s.created_at)}\n`);
  process.stdout.write(`  ${C.dim}updated    ${C.reset}${formatRelative(s.updated_at)}\n\n`);
  return 0;
}

async function sessionsRestart(sessionId: string | undefined, projectArg?: string): Promise<number> {
  if (!sessionId) {
    process.stderr.write(`${status.err('Pass a session id.')}\n`);
    return 2;
  }
  const ctx = resolveProjectContext(projectArg);
  if (!ctx) return 1;

  try {
    await ctx.client.post<{ ok: true; status: string }>(
      `/projects/${ctx.projectId}/sessions/${sessionId}/restart`,
    );
  } catch (err) {
    return surfaceApiError(err);
  }
  process.stdout.write(`${status.ok(`Restarting ${C.bold}${shortId(sessionId)}${C.reset}${C.dim} — refresh \`sessions info\` to track status${C.reset}`)}\n`);
  return 0;
}

async function sessionsRm(sessionId: string | undefined, projectArg?: string): Promise<number> {
  if (!sessionId) {
    process.stderr.write(`${status.err('Pass a session id.')}\n`);
    return 2;
  }
  const ctx = resolveProjectContext(projectArg);
  if (!ctx) return 1;

  try {
    await ctx.client.delete(`/projects/${ctx.projectId}/sessions/${sessionId}`);
  } catch (err) {
    return surfaceApiError(err);
  }
  process.stdout.write(`${status.ok(`Deleted ${C.bold}${shortId(sessionId)}${C.reset}`)}\n`);
  return 0;
}

async function sessionsOpen(sessionId: string | undefined, projectArg?: string): Promise<number> {
  if (!sessionId) {
    process.stderr.write(`${status.err('Pass a session id.')}\n`);
    return 2;
  }
  const ctx = resolveProjectContext(projectArg);
  if (!ctx) return 1;
  const auth = loadAuth();
  if (!auth) return 1;
  const url = `${webDashboardUrl(auth.api_base)}/projects/${ctx.projectId}/sessions/${sessionId}`;
  process.stdout.write(`${C.dim}Opening ${url}${C.reset}\n`);
  openInBrowser(url);
  return 0;
}

// ── helpers ────────────────────────────────────────────────────────────────

function shortId(id: string): string {
  return id.split('-')[0] ?? id;
}

function statusColor(s: string): string {
  switch (s) {
    case 'running':
      return C.green;
    case 'failed':
      return C.red;
    case 'stopped':
    case 'completed':
      return C.faded;
    default:
      return C.yellow;
  }
}

function trimMid(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - 1) / 2);
  return `${s.slice(0, half)}…${s.slice(-half)}`;
}

function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diffMs / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function webDashboardUrl(apiBase: string): string {
  try {
    const url = new URL(apiBase);
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      return `${url.protocol}//${url.hostname}:3000`;
    }
    if (url.hostname.startsWith('api.')) {
      url.hostname = url.hostname.slice(4);
      return url.origin;
    }
    return url.origin;
  } catch {
    return 'https://kortix.com';
  }
}

function openInBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'cmd'
        : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawnSync(cmd, args, { stdio: 'ignore' });
}
