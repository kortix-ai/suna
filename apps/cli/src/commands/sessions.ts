import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  emitJson,
  locateSessionAnywhere,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { runSessionsAnswer, runSessionsApprove, runSessionsPending } from './sessions-approvals.ts';
import { runSessionsChat, runSessionsLog, runSessionsStatus } from './sessions-chat.ts';
import { runSessionsConnect } from './sessions-connect.ts';
import { runSessionsDigest } from './sessions-digest.ts';
import { C, help, pad, status } from '../style.ts';
import { sessionWebUrl } from '../web-url.ts';
import type { ProjectSession, ProjectSummary } from '../api/types.ts';

const HELP = help`Usage: kortix sessions <subcommand> [options]

Manage Kortix project sessions — each session is an isolated sandbox VM
on its own ephemeral branch.

Subcommands:
  ls                                List sessions on the project. --json.
  status                            Mission control: every session + what
                                    each agent is doing right now (live).
                                    --all, --json. Aliases: overview, ps.
  new [--prompt "<text>"]           Start a new session, optionally with an
                                    initial prompt. --wait blocks until it's
                                    running; --json prints the session object
                                    (capture session_id to orchestrate).
  chat [<session-id>]               Talk to a session's agent (REPL, or
                                    one-shot with --prompt). --new starts one.
  connect [<session-id>]            Attach local OpenCode to the running
                                    session sandbox. Pass args after --.
  log [<session-id>]                Print a session's recent messages
                                    (read-only) — peek at what an agent is
                                    doing without sending it anything.
                                    --limit <N>, --json. Aliases: messages.
  pending <session-id>              List open interactive prompts the agent
                                    is blocked on: tool-permission asks +
                                    questions. --json. Aliases: prompts.
  approve <session-id> [<req-id>]   Answer a pending tool-permission ask.
                                    --always, --reject, --message "<why>".
  answer <session-id> [<req-id>]    Answer a pending question.
                                    --option <value> (repeatable),
                                    --text "<answer>", --reject.
  digest                            Compact review of recent sessions for
                                    reflection: metadata + compressed
                                    transcript snippets with tool outputs
                                    stripped. --since <7d>, --json.
                                    Aliases: review, summary.
  info <session-id>                 Show one session. --json.
  preview <session-id> [port]       Print a clickable preview URL for a port
                                    in the session's sandbox (default 3000).
                                    Root-served (assets work). --port, --json.
  restart <session-id>              Restart (re-provision) a session.
  rename <session-id> <name>        Set a session's name. Pass "" to clear it
                                    and revert to the automatic title.
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
  // `chat` owns its own flag parsing (incl. --prompt + a positional session
  // id), so route it before we consume flags below.
  if (sub === 'chat' || sub === 'talk') {
    return runSessionsChat(argv.slice(1));
  }
  // `connect` owns its own flag parsing and forwards remaining args to
  // `opencode attach`, so route it before we consume flags below.
  if (sub === 'connect' || sub === 'attach') {
    return runSessionsConnect(argv.slice(1));
  }
  // `log` owns its own flag parsing (incl. --limit + a positional session id),
  // so route it before we consume flags below.
  if (sub === 'log' || sub === 'messages' || sub === 'history') {
    return runSessionsLog(argv.slice(1));
  }
  // `status` fans out live per-session reads; owns its own flag parsing.
  if (sub === 'status' || sub === 'overview' || sub === 'ps') {
    return runSessionsStatus(argv.slice(1));
  }
  // `digest` owns its own time-window + compaction flags.
  if (sub === 'digest' || sub === 'review' || sub === 'summary') {
    return runSessionsDigest(argv.slice(1));
  }
  // Interactive-prompt commands own their own flag parsing (repeatable
  // --option, --message, positional request ids).
  if (sub === 'pending' || sub === 'prompts') {
    return runSessionsPending(argv.slice(1));
  }
  if (sub === 'approve') {
    return runSessionsApprove(argv.slice(1));
  }
  if (sub === 'answer') {
    return runSessionsAnswer(argv.slice(1));
  }
  const rest = argv.slice(1);
  const json = takeFlagBool(rest, ['--json']);
  const wait = takeFlagBool(rest, ['--wait']);
  let projectFlag: string | undefined;
  let promptFlag: string | undefined;
  let hostFlag: string | undefined;
  let portFlag: string | undefined;
  try {
    projectFlag = takeFlagValue(rest, ['--project']);
    hostFlag = takeFlagValue(rest, ['--host']);
    promptFlag = takeFlagValue(rest, ['--prompt', '-p']);
    portFlag = takeFlagValue(rest, ['--port']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const ctxOpts = { projectArg: projectFlag, hostArg: hostFlag };

  switch (sub) {
    case 'ls':
    case 'list':
      return sessionsLs(ctxOpts, json);
    case 'new':
    case 'create':
      return sessionsNew(promptFlag, ctxOpts, json, wait);
    case 'info':
    case 'show':
      return sessionsInfo(rest[0], ctxOpts, json);
    case 'preview':
    case 'url':
      return sessionsPreview(rest[0], portFlag ?? rest[1], ctxOpts, json);
    case 'restart':
      return sessionsRestart(rest[0], ctxOpts);
    case 'rename':
      return sessionsRename(rest[0], rest[1], ctxOpts);
    case 'rm':
    case 'delete':
      return sessionsRm(rest[0], ctxOpts);
    case 'open':
      return sessionsOpen(rest[0], ctxOpts);
    default:
      process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
      return 2;
  }
}

type CtxOpts = { projectArg?: string; hostArg?: string };

async function sessionsLs(opts: CtxOpts, json = false): Promise<number> {
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

  if (json) {
    emitJson(sessions);
    return 0;
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

async function sessionsNew(
  prompt: string | undefined,
  opts: CtxOpts,
  json = false,
  wait = false,
): Promise<number> {
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;

  const body: Record<string, unknown> = {};
  if (prompt) body.initial_prompt = prompt;

  const prepared = await prepareClientCreatedBranch(ctx, body);
  if (prepared === 'error') return 1;

  let created: ProjectSession;
  try {
    created = await ctx.client.post<ProjectSession>(
      `/projects/${ctx.projectId}/sessions`,
      body,
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  // --wait: drive the same canonical /start lifecycle endpoint the dashboard
  // polls. Row status alone can say "running" before OpenCode is actually ready.
  if (wait) {
    if (!json) {
      process.stderr.write(`${C.dim}  waiting for the sandbox to come up…${C.reset}\n`);
    }
    for (let i = 0; i < 75; i += 1) {
      if (i > 0) await new Promise((r) => setTimeout(r, 4000));
      try {
        const start = await ctx.client.post<{
          stage: 'provisioning' | 'starting' | 'ready' | 'stopped' | 'failed';
          reason?: string;
        }>(
          `/projects/${ctx.projectId}/sessions/${created.session_id}/start`,
          {},
        );
        created = await ctx.client.get<ProjectSession>(
          `/projects/${ctx.projectId}/sessions/${created.session_id}`,
        );
        if (start.stage === 'ready') break;
        if (start.stage === 'failed' || start.stage === 'stopped') {
          if (json) {
            emitJson(created);
          } else {
            const detail = start.reason ? `: ${start.reason}` : created.error ? `: ${created.error}` : '';
            process.stderr.write(`${status.err(`Session ${start.stage}${detail}.`)}\n`);
          }
          return 1;
        }
      } catch (err) {
        if (json) {
          emitJson(created);
        } else {
          process.stderr.write(
            `${status.err((err as Error).message || 'Failed while waiting for session readiness')}\n`,
          );
        }
        return 1;
      }
    }
  }

  if (json) {
    emitJson(created);
    return 0;
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

async function prepareClientCreatedBranch(
  ctx: { client: { get<T>(path: string): Promise<T> }; projectId: string },
  body: Record<string, unknown>,
): Promise<'ok' | 'error'> {
  let project: ProjectSummary;
  try {
    project = await ctx.client.get<ProjectSummary>(`/projects/${ctx.projectId}`);
  } catch {
    // Let the create call surface the real API error.
    return 'ok';
  }

  if (serverCanCreateBranch(project)) return 'ok';
  if (!isInsideGitWorkTree()) return 'ok';

  const origin = gitStdout(['remote', 'get-url', 'origin']);
  if (!origin || normalizeGitUrl(origin) !== normalizeGitUrl(project.repo_url)) return 'ok';

  const baseRef = currentGitBranch();
  if (!baseRef) {
    process.stderr.write(`${status.err('Not on a git branch; cannot create the session branch locally.')}\n`);
    return 'error';
  }

  const sessionId = randomUUID();
  const push = runGit([
    'push',
    'origin',
    `refs/heads/${baseRef}:refs/heads/${sessionId}`,
  ]);
  if (!push.ok) {
    const detail = (push.stderr || push.stdout).trim();
    process.stderr.write(
      `${status.err('Could not create the remote session branch with local git credentials.')}\n`,
    );
    if (detail) process.stderr.write(`  ${C.dim}${detail.split('\n').join('\n  ')}${C.reset}\n`);
    process.stderr.write(`  ${C.dim}Run ${C.reset}${C.cyan}kortix ship${C.reset}${C.dim} first, then retry.${C.reset}\n`);
    return 'error';
  }

  body.session_id = sessionId;
  body.branch_already_created = true;
  body.base_ref = baseRef;
  return 'ok';
}

async function sessionsInfo(
  sessionId: string | undefined,
  opts: CtxOpts,
  json = false,
): Promise<number> {
  if (!sessionId) {
    process.stderr.write(`${status.err('Pass a session id.')}\n`);
    return 2;
  }
  const located = await locateSessionAnywhere(
    sessionId,
    opts,
    (host) => `kortix sessions info ${sessionId} --host ${host}`,
  );
  if (!located) return 1;
  const s = located.located.session;

  if (json) {
    emitJson(s);
    return 0;
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

async function sessionsPreview(
  sessionId: string | undefined,
  portArg: string | undefined,
  opts: CtxOpts,
  json = false,
): Promise<number> {
  if (!sessionId) {
    process.stderr.write(`${status.err('Pass a session id.')}\n`);
    return 2;
  }
  const port = Number(portArg ?? '3000');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    process.stderr.write(`${status.err(`Invalid port "${portArg}".`)}\n`);
    return 2;
  }
  const located = await locateSessionAnywhere(
    sessionId,
    opts,
    (host) => `kortix sessions preview ${sessionId} --port ${port} --host ${host}`,
  );
  if (!located) return 1;
  const { session: s, auth } = located.located;

  if (!s.sandbox_url) {
    process.stderr.write(
      `${status.err(`Session has no sandbox yet (status: ${s.status}). Try again once it's active.`)}\n`,
    );
    return 1;
  }
  // The sandbox's external id is the segment after /v1/p/ in the daemon URL.
  const m = s.sandbox_url.match(/\/v1\/p\/([^/]+)\//);
  if (!m) {
    process.stderr.write(`${status.err(`Could not parse sandbox id from ${s.sandbox_url}`)}\n`);
    return 1;
  }
  const ext = m[1];
  const base = new URL(auth.api_base);
  // Kortix subdomain preview: served at root (so SPA/Next assets resolve), the
  // `?token` authorizes the subdomain (in-memory TTL) and sets a cookie for
  // subsequent asset requests. `*.localhost` resolves to 127.0.0.1 in browsers.
  const scheme = base.protocol.replace(':', '');
  const url = `${scheme}://p${port}-${ext}.${base.host}/?token=${encodeURIComponent(auth.token)}`;

  if (json) {
    emitJson({ session_id: s.session_id, port, sandbox: ext, url });
    return 0;
  }

  process.stdout.write(`\n  ${C.dim}port    ${C.reset}${port}\n`);
  process.stdout.write(`  ${C.dim}sandbox ${C.reset}${ext}\n`);
  process.stdout.write(`  ${C.dim}preview ${C.reset}${C.cyan}${url}${C.reset}\n\n`);
  return 0;
}

async function sessionsRestart(sessionId: string | undefined, opts: CtxOpts): Promise<number> {
  if (!sessionId) {
    process.stderr.write(`${status.err('Pass a session id.')}\n`);
    return 2;
  }
  const located = await locateSessionAnywhere(
    sessionId,
    opts,
    (host) => `kortix sessions restart ${sessionId} --host ${host}`,
  );
  if (!located) return 1;

  try {
    await located.located.client.post<{ ok: true; status: string }>(
      `/projects/${located.located.projectId}/sessions/${sessionId}/restart`,
    );
  } catch (err) {
    return surfaceApiError(err);
  }
  process.stdout.write(`${status.ok(`Restarting ${C.bold}${shortId(sessionId)}${C.reset}${C.dim} — refresh \`sessions info\` to track status${C.reset}`)}\n`);
  return 0;
}

async function sessionsRename(
  sessionId: string | undefined,
  name: string | undefined,
  opts: CtxOpts,
): Promise<number> {
  if (!sessionId) {
    process.stderr.write(`${status.err('Pass a session id.')}\n`);
    return 2;
  }
  if (name === undefined) {
    process.stderr.write(`${status.err('Pass a name (use "" to clear it).')}\n`);
    return 2;
  }
  const located = await locateSessionAnywhere(
    sessionId,
    opts,
    (host) => `kortix sessions rename ${sessionId} "${name}" --host ${host}`,
  );
  if (!located) return 1;

  let updated: ProjectSession;
  try {
    updated = await located.located.client.patch<ProjectSession>(
      `/projects/${located.located.projectId}/sessions/${sessionId}`,
      { name },
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  if (updated.custom_name) {
    process.stdout.write(`${status.ok(`Renamed to ${C.bold}${updated.custom_name}${C.reset}`)}\n`);
  } else {
    process.stdout.write(`${status.ok(`Name cleared — using automatic title${updated.name ? ` ${C.dim}(${updated.name})${C.reset}` : ''}`)}\n`);
  }
  return 0;
}

async function sessionsRm(sessionId: string | undefined, opts: CtxOpts): Promise<number> {
  if (!sessionId) {
    process.stderr.write(`${status.err('Pass a session id.')}\n`);
    return 2;
  }
  const located = await locateSessionAnywhere(
    sessionId,
    opts,
    (host) => `kortix sessions rm ${sessionId} --host ${host}`,
  );
  if (!located) return 1;

  try {
    await located.located.client.delete(`/projects/${located.located.projectId}/sessions/${sessionId}`);
  } catch (err) {
    return surfaceApiError(err);
  }
  process.stdout.write(`${status.ok(`Deleted ${C.bold}${shortId(sessionId)}${C.reset}`)}\n`);
  return 0;
}

async function sessionsOpen(sessionId: string | undefined, opts: CtxOpts): Promise<number> {
  if (!sessionId) {
    process.stderr.write(`${status.err('Pass a session id.')}\n`);
    return 2;
  }
  const located = await locateSessionAnywhere(
    sessionId,
    opts,
    (host) => `kortix sessions open ${sessionId} --host ${host}`,
  );
  if (!located) return 1;
  const url = sessionWebUrl(located.located.auth.api_base, located.located.projectId, sessionId);
  process.stdout.write(`${C.dim}Opening ${url}${C.reset}\n`);
  openInBrowser(url);
  return 0;
}

// ── helpers ────────────────────────────────────────────────────────────────

function shortId(id: string): string {
  return id.split('-')[0] ?? id;
}

function serverCanCreateBranch(project: ProjectSummary): boolean {
  const meta = (project.metadata ?? {}) as Record<string, any>;
  const git = meta.git as { provider?: string; managed?: boolean; auth?: { method?: string } } | undefined;
  // Managed repos: the server holds the credential and can create the branch.
  if (git?.managed === true) return true;
  const github = meta.github as { auth_source?: string } | undefined;
  return github?.auth_source === 'app_installation' || github?.auth_source === 'pat';
}

function normalizeGitUrl(url: string): string {
  const trimmed = url.trim();
  const ssh = trimmed.match(/^git@([^:]+):(.+)$/);
  if (ssh) return `${ssh[1]}/${ssh[2]}`.replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'ssh:') {
      return `${parsed.hostname}${parsed.pathname}`.replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
    }
  } catch {
    // Local paths are valid git remotes too; compare them as normalized strings.
  }
  return trimmed.replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
}

function runGit(args: string[]): { ok: boolean; stdout: string; stderr: string; code: number | null } {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  return {
    ok: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    code: result.status,
  };
}

function gitStdout(args: string[]): string | null {
  const result = runGit(args);
  return result.ok ? result.stdout.trim() : null;
}

function isInsideGitWorkTree(): boolean {
  return gitStdout(['rev-parse', '--is-inside-work-tree']) === 'true';
}

function currentGitBranch(): string | null {
  const branch = gitStdout(['rev-parse', '--abbrev-ref', 'HEAD']);
  return branch && branch !== 'HEAD' ? branch : null;
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

function openInBrowser(url: string): void {
  // Only hand a real web URL to the OS opener — a value starting with '-' would
  // be read as a flag by open/xdg-open, and Windows `start` parses its argument,
  // so an unvalidated URL is a command-injection vector.
  if (!/^https?:\/\//i.test(url)) return;
  const cmd =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'cmd'
        : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawnSync(cmd, args, { stdio: 'ignore' });
}
