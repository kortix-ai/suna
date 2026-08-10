import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  emitJson,
  locateSessionAnywhere,
  resolveWorkspaceContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
  takeFlagValues,
} from '../command-helpers.ts';
import { runSessionsAnswer, runSessionsApprove, runSessionsPending } from './sessions-approvals.ts';
import { runSessionsChat, runSessionsLog, runSessionsStatus } from './sessions-chat.ts';
import { runSessionsConnect } from './sessions-connect.ts';
import type { Auth } from '../api/auth.ts';
import { confirm } from '../prompts.ts';
import { hasEnvTokenHost } from '../api/config.ts';
import { kortixFromAuth } from '../api/sdk.ts';
import type { WorkspaceSession, WorkspaceSummary } from '../api/types.ts';
import { C, help, pad, status } from '../style.ts';
import { sessionWebUrl } from '../web-url.ts';
import { runSessionsDigest } from './sessions-digest.ts';
import {
  buildPromptWithFiles,
  buildSpawnPrompt,
  runSessionsCp,
  sessionPromptDefaults,
  uploadTargetsFor,
  validateUploadSources,
  writeSessionFile,
} from './sessions-files.ts';
import { runSessionsScope } from './sessions-scope.ts';
import { runSessionsShell } from './sessions-shell.ts';
import { runSessionsWaitFor } from './sessions-wait.ts';

const HELP = help`Usage: kortix sessions <subcommand> [options]

Manage Kortix workspace sessions — each session is an isolated sandbox VM
on its own ephemeral branch.

Subcommands:
  ls                                List sessions on the workspace. --json.
  status                            Mission control: every session + what
                                    each agent is doing right now (live).
                                    --all, --json. Aliases: overview, ps.
  new [--prompt "<text>"]           Start a new session, optionally with an
                                    initial prompt. --agent <name> pins the
                                    session to that agent (default: the
                                    workspace's declared default agent).
                                    --model <id> overrides the model.
                                    --wait blocks until it's running; --json
                                    prints the session object (capture
                                    session_id to orchestrate).
                                    --with-file <local path> (repeatable)
                                    uploads the file to
                                    /workspace/incoming/<name> before the
                                    prompt is delivered (implies --wait; the
                                    prompt gets a manifest of the paths).
                                    Session access at creation:
                                    --secret <id>           narrow injected
                                      secrets to these identifiers (repeatable;
                                      backend token required).
                                    --no-secrets            inject zero workspace
                                      secrets into the session (backend token
                                      required).
                                    --connector <alias>=<connection-id>
                                      bind a connection
                                      (repeatable).
                                    --no-connectors          use no connections.
                                    --require-connector <alias>
                                      require a connection before
                                      provisioning (repeatable).
                                    --context <key>=<value>  runtime context
                                      (repeatable).
  chat [<session-id>]               Talk to a session's agent (REPL, or
                                    one-shot with --prompt). --new starts one.
  connect [<session-id>]            Attach local OpenCode to the running
                                    session sandbox. Pass args after --.
  shell [<session-id>]              Open a raw interactive terminal (PTY) in
                                    the sandbox — no agent, just a shell.
                                    Reattaches to the existing one; --new
                                    starts fresh.
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
  wait-for <session-id>             Block until the session's agent finishes
                                    its current work, or is blocked on an
                                    ask, or --timeout <seconds> (default
                                    300) elapses. Exit 0 done / 3 blocked /
                                    124 timeout. Alias: wait.
  cp <src> <dst>                    Copy files between your machine and a
                                    session's sandbox, or directly between
                                    two sandboxes. Sandbox refs are
                                    <session-id>:<path>; -r for directories.
                                    Overwrites the exact destination path.
  info <session-id>                 Show one session. --json.
  scope <session-id>                Read or replace the session's secret and
                                    connector access. Changes apply to the next
                                    prompt. --secret, --no-secrets,
                                    --inherit-secrets, --connector,
                                    --no-connectors, --require-connector,
                                    --no-required-connectors, --json.
                                    Alias: access.
  preview <session-id> [port]       Print a clickable preview URL for a port
                                    in the session's sandbox (default 3000).
                                    Root-served (assets work). --port, --json.
  reload <session-id>               Pull the repo and recompile the session's
                                    agent config from git, into the RUNNING
                                    sandbox — the way to pick up a merged
                                    agent change without starting over.
                                    Restarts the agent runtime, so it refuses
                                    mid-turn unless you pass --force — which
                                    asks first, because it ends the running
                                    turn. -y/--yes skips the prompt.
                                    --no-repo skips the git pull.
                                    --status only reports whether the session
                                    is behind, changing nothing. --json.
  restart <session-id>              Restart (re-provision) a session.
  rename <session-id> <name>        Set a session's name. Pass "" to clear it
                                    and revert to the automatic title.
  rm <session-id>                   Stop + delete a session.
  open <session-id>                 Open the dashboard URL for a session.

Global options:
  --workspace <id>     Operate on this workspace id (default: linked).
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
  // `shell` owns its own flag parsing (incl. --new + a positional session id).
  if (sub === 'shell' || sub === 'terminal' || sub === 'ssh') {
    return runSessionsShell(argv.slice(1));
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
  // `cp` owns its own flag parsing (scp-style refs + -r/--json).
  if (sub === 'cp' || sub === 'copy') {
    return runSessionsCp(argv.slice(1));
  }
  // `wait-for` owns its own flag parsing (--timeout + a positional session id).
  if (sub === 'wait-for' || sub === 'wait') {
    return runSessionsWaitFor(argv.slice(1));
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
  if (sub === 'scope' || sub === 'access') {
    return runSessionsScope(argv.slice(1));
  }
  const rest = argv.slice(1);
  // None of the subcommands below (ls/new/info/preview/restart/rename/rm/
  // open) own dedicated help text or parse -h/--help themselves, so without
  // this a bare `--help` falls through as an ordinary positional arg — e.g.
  // `sessions info --help` would try to look up a session literally named
  // "--help" instead of showing usage.
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(HELP);
    return 0;
  }
  const json = takeFlagBool(rest, ['--json']);
  const wait = takeFlagBool(rest, ['--wait']);
  let workspaceFlag: string | undefined;
  let promptFlag: string | undefined;
  let hostFlag: string | undefined;
  let portFlag: string | undefined;
  let agentFlag: string | undefined;
  let withFiles: string[] = [];
  let overrides: SessionOverrides = {};
  try {
    workspaceFlag = takeFlagValue(rest, ['--workspace', '--project']);
    hostFlag = takeFlagValue(rest, ['--host']);
    promptFlag = takeFlagValue(rest, ['--prompt', '-p']);
    portFlag = takeFlagValue(rest, ['--port']);
    agentFlag = takeFlagValue(rest, ['--agent']);
    withFiles = takeFlagValues(rest, ['--with-file']);
    // Backend/override flags for `sessions new`. Other subcommands keep their
    // positional arguments in `rest`.
    overrides = parseSessionOverrides(rest);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  if ((sub === 'new' || sub === 'create') && rest.length > 0) {
    process.stderr.write(`${status.err(`unknown option "${rest[0]}"`)}\n`);
    return 2;
  }
  const ctxOpts = { workspaceArg: workspaceFlag, hostArg: hostFlag };

  switch (sub) {
    case 'ls':
    case 'list':
      return sessionsLs(ctxOpts, json);
    case 'new':
    case 'create':
      return sessionsNew(promptFlag, ctxOpts, json, wait, agentFlag, overrides, withFiles);
    case 'info':
    case 'show':
      return sessionsInfo(rest[0], ctxOpts, json);
    case 'preview':
    case 'url':
      return sessionsPreview(rest[0], portFlag ?? rest[1], ctxOpts, json);
    case 'restart':
      return sessionsRestart(rest[0], ctxOpts);
    case 'reload':
      return sessionsReload(rest[0], rest.slice(1), ctxOpts);
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

type CtxOpts = { workspaceArg?: string; hostArg?: string };

/** Start-time override flags for `sessions new`. Model applies to any caller.
 * Secrets require a backend-origin token (a PAT or service-account bearer). */
export type SessionOverrides = {
  model?: string;
  secrets?: string[];
  connectors?: Record<string, { connection_id: string }>;
  requiredConnectors?: string[];
  runtimeContext?: Record<string, string>;
};

/** Parse (and consume) the `sessions new` override flags from argv. Repeatable
 *  flags take `key=value` pairs: --connector gmail=<connection-id>, --context k=v. */
export function parseSessionOverrides(argv: string[]): SessionOverrides {
  const out: SessionOverrides = {};
  const model = takeFlagValue(argv, ['--model']);
  if (model) out.model = model;
  const secrets = takeFlagValues(argv, ['--secret']);
  const noSecrets = takeFlagBool(argv, ['--no-secrets']);
  if (secrets.length && noSecrets) {
    throw new Error('pass either --secret <id> or --no-secrets, not both');
  }
  // `secrets: []` (inject zero workspace secrets) is a distinct, documented state
  // from omitting the field (agent's normal set); --no-secrets expresses it.
  if (secrets.length) out.secrets = secrets;
  else if (noSecrets) out.secrets = [];
  const connectorPairs = takeFlagValues(argv, ['--connector']);
  const noConnectors = takeFlagBool(argv, ['--no-connectors']);
  if (connectorPairs.length && noConnectors) {
    throw new Error('pass either --connector <alias>=<connection-id> or --no-connectors, not both');
  }
  for (const pair of connectorPairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0 || eq === pair.length - 1) {
      throw new Error(`--connector expects alias=connection_id, got "${pair}"`);
    }
    (out.connectors ??= {})[pair.slice(0, eq)] = {
      connection_id: pair.slice(eq + 1),
    };
  }
  if (noConnectors) out.connectors = {};
  const requiredConnectors = takeFlagValues(argv, ['--require-connector']);
  if (requiredConnectors.length) out.requiredConnectors = [...new Set(requiredConnectors)];
  for (const pair of takeFlagValues(argv, ['--context'])) {
    const eq = pair.indexOf('=');
    if (eq <= 0 || eq === pair.length - 1) {
      throw new Error(`--context expects key=value, got "${pair}"`);
    }
    (out.runtimeContext ??= {})[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

async function sessionsLs(opts: CtxOpts, json = false): Promise<number> {
  const ctx = await resolveWorkspaceContext(opts);
  if (!ctx) return 1;

  let sessions: WorkspaceSession[];
  try {
    sessions = await ctx.client.get<WorkspaceSession[]>(`/workspaces/${ctx.workspaceId}/sessions`);
  } catch (err) {
    return surfaceApiError(err);
  }

  if (json) {
    emitJson(sessions);
    return 0;
  }

  if (sessions.length === 0) {
    process.stdout.write(
      `  ${C.dim}No sessions yet — start one with \`kortix sessions new\`.${C.reset}\n`,
    );
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
  process.stdout.write(
    `\n  ${C.dim}${sessions.length} session${sessions.length === 1 ? '' : 's'}${C.reset}\n\n`,
  );
  return 0;
}

async function sessionsNew(
  prompt: string | undefined,
  opts: CtxOpts,
  json = false,
  wait = false,
  agent?: string,
  overrides: SessionOverrides = {},
  withFiles: string[] = [],
): Promise<number> {
  const ctx = await resolveWorkspaceContext(opts);
  if (!ctx) return 1;

  // --with-file: uploads need a live sandbox, and the prompt must go out AFTER
  // the files land (an initial_prompt would race the uploads). So validate the
  // local files up front, force the readiness wait, and defer the prompt.
  let uploads: Array<{ local: string; target: string }> = [];
  if (withFiles.length > 0) {
    try {
      uploads = uploadTargetsFor(withFiles);
      await validateUploadSources(uploads);
    } catch (err) {
      process.stderr.write(`${status.err((err as Error).message)}\n`);
      return 2;
    }
    wait = true;
  }

  // Spawns from inside a sandbox (a coordinator session) carry a session
  // contract so the worker does the task itself instead of re-delegating.
  const fromSandbox = hasEnvTokenHost();

  const body: Record<string, unknown> = {};
  if (prompt && uploads.length === 0) {
    body.initial_prompt = buildSpawnPrompt(prompt, { fromSandbox });
  }
  // Titles derive from the user's words, not from the session-contract or the
  // --with-file manifest the CLI appends around them.
  if (prompt) body.title_source = prompt;
  // Explicit caller override — the server otherwise falls back to the
  // workspace's declared default agent (kortix.yaml's `default_agent`), or the
  // non-binding 'default' sentinel when none is configured. See
  // apps/api/src/workspaces/lib/sessions.ts createProjectSession.
  if (agent) body.agent_name = agent;
  if (overrides.model) body.opencode_model = overrides.model;
  if (overrides.secrets !== undefined) body.secrets = overrides.secrets;
  if (overrides.connectors !== undefined) body.connector_bindings = overrides.connectors;
  if (overrides.requiredConnectors !== undefined) {
    body.require_connectors = overrides.requiredConnectors;
  }
  if (overrides.runtimeContext) body.runtime_context = overrides.runtimeContext;

  const prepared = await prepareClientCreatedBranch(ctx, body);
  if (prepared === 'error') return 1;

  let created: WorkspaceSession;
  try {
    created = await ctx.client.post<WorkspaceSession>(`/workspaces/${ctx.workspaceId}/sessions`, body);
  } catch (err) {
    return surfaceApiError(err);
  }

  // --wait: drive the same canonical /start lifecycle endpoint the dashboard
  // polls. Row status alone can say "running" before OpenCode is actually ready.
  if (wait) {
    if (!json) {
      process.stderr.write(`${C.dim}  waiting for the sandbox to come up…${C.reset}\n`);
    }
    let ready = false;
    for (let i = 0; i < 75; i += 1) {
      if (i > 0) await new Promise((r) => setTimeout(r, 4000));
      try {
        const start = await ctx.client.post<{
          stage: 'provisioning' | 'starting' | 'ready' | 'stopped' | 'failed';
          reason?: string;
        }>(`/workspaces/${ctx.workspaceId}/sessions/${created.session_id}/start`, {});
        created = await ctx.client.get<WorkspaceSession>(
          `/workspaces/${ctx.workspaceId}/sessions/${created.session_id}`,
        );
        if (start.stage === 'ready') {
          ready = true;
          break;
        }
        if (start.stage === 'failed' || start.stage === 'stopped') {
          if (json) {
            emitJson(created);
          } else {
            const detail = start.reason
              ? `: ${start.reason}`
              : created.error
                ? `: ${created.error}`
                : '';
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
    // Loop exhausted without reaching 'ready' — --wait is a hard readiness
    // gate, so a timeout is a failure (exit 1), not a silent success.
    if (!ready) {
      if (json) {
        emitJson(created);
      } else {
        process.stderr.write(
          `${status.err(`Timed out waiting for session readiness after ~5 min (status: ${created.status}).`)}\n`,
        );
      }
      return 1;
    }
  }

  // Deliver --with-file uploads, then the deferred prompt.
  if (uploads.length > 0) {
    const files = kortixFromAuth(ctx.auth).session(ctx.workspaceId, created.session_id).files;
    try {
      for (const u of uploads) {
        const bytes = await readFile(u.local);
        await writeSessionFile(files, u.target, new Blob([new Uint8Array(bytes)]));
        if (!json) process.stdout.write(`  ${C.dim}uploaded ${u.target}${C.reset}\n`);
      }
      if (prompt) {
        await sendPromptToSession(
          ctx,
          created,
          buildSpawnPrompt(
            buildPromptWithFiles(
              prompt,
              uploads.map((u) => u.target),
            ),
            { fromSandbox },
          ),
        );
      }
    } catch (err) {
      return surfaceApiError(err);
    }
  }

  if (json) {
    emitJson(
      uploads.length > 0 ? { ...created, uploaded_files: uploads.map((u) => u.target) } : created,
    );
    return 0;
  }

  process.stdout.write(
    `\n${status.ok(`Session started ${C.bold}${shortId(created.session_id)}${C.reset}`)}\n`,
  );
  process.stdout.write(`  ${C.dim}session_id ${C.reset}${created.session_id}\n`);
  process.stdout.write(`  ${C.dim}status     ${C.reset}${created.status}\n`);
  process.stdout.write(`  ${C.dim}branch     ${C.reset}${created.branch_name}\n`);
  if (created.sandbox_url) {
    process.stdout.write(`  ${C.dim}sandbox    ${C.reset}${created.sandbox_url}\n`);
  }
  process.stdout.write('\n');
  return 0;
}

/** Deliver a prompt through the shipped OpenCode REST runtime. */
async function sendPromptToSession(
  ctx: { auth: Auth; workspaceId: string },
  session: WorkspaceSession,
  text: string,
): Promise<void> {
  const handle = kortixFromAuth(ctx.auth).session(ctx.workspaceId, session.session_id);
  const ready = await handle.ensureReady();
  // Carry the session's persisted model + agent: an async prompt without them
  // is stored but never processed (OpenCode falls back to its own default
  // model, which Kortix sandboxes don't provision).
  const defaults = sessionPromptDefaults(session);
  const result = await handle.runtime.session.promptAsync({
    sessionID: ready.opencodeSessionId,
    parts: [{ type: 'text', text }],
    ...defaults,
  });
  if (result?.error) {
    const detail = (result.error as { data?: { message?: string } })?.data?.message;
    throw new Error(`prompt delivery failed${detail ? `: ${detail}` : ''}`);
  }
}

export async function prepareClientCreatedBranch(
  ctx: { client: { get<T>(path: string): Promise<T> }; workspaceId: string },
  body: Record<string, unknown>,
): Promise<'ok' | 'error'> {
  let workspace: WorkspaceSummary;
  try {
    workspace = await ctx.client.get<WorkspaceSummary>(`/workspaces/${ctx.workspaceId}`);
  } catch {
    // Let the create call surface the real API error.
    return 'ok';
  }

  if (serverCanCreateBranch(workspace)) return 'ok';
  if (!isInsideGitWorkTree()) return 'ok';

  const origin = gitStdout(['remote', 'get-url', 'origin']);
  if (!origin || normalizeGitUrl(origin) !== normalizeGitUrl(workspace.repo_url)) return 'ok';

  const baseRef = currentGitBranch();
  if (!baseRef) {
    process.stderr.write(
      `${status.err('Not on a git branch; cannot create the session branch locally.')}\n`,
    );
    return 'error';
  }

  const sessionId = randomUUID();
  const push = runGit(['push', 'origin', `refs/heads/${baseRef}:refs/heads/${sessionId}`]);
  if (!push.ok) {
    const detail = (push.stderr || push.stdout).trim();
    process.stderr.write(
      `${status.err('Could not create the remote session branch with local git credentials.')}\n`,
    );
    if (detail) process.stderr.write(`  ${C.dim}${detail.split('\n').join('\n  ')}${C.reset}\n`);
    process.stderr.write(
      `  ${C.dim}Run ${C.reset}${C.cyan}kortix ship${C.reset}${C.dim} first, then retry.${C.reset}\n`,
    );
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
  process.stdout.write(
    `  ${C.dim}status     ${C.reset}${statusColor(s.status)}${s.status}${C.reset}\n`,
  );
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
  const canonicalSessionId = located.located.session.session_id;

  try {
    await located.located.client.post<{ ok: true; status: string }>(
      `/workspaces/${located.located.workspaceId}/sessions/${canonicalSessionId}/restart`,
    );
  } catch (err) {
    return surfaceApiError(err);
  }
  process.stdout.write(
    `${status.ok(`Restarting ${C.bold}${shortId(canonicalSessionId)}${C.reset}${C.dim} — refresh \`sessions info\` to track status${C.reset}`)}\n`,
  );
  return 0;
}

/**
 * Reload a running session's config.
 *
 * The gap this closes: merging an agent change left every open session running
 * the config it booted with, and nothing short of a new session picked it up —
 * `git pull` updates the working tree but the compiled agent config never came
 * from there, and restarting re-read the same env.
 */
async function sessionsReload(
  sessionId: string | undefined,
  args: string[],
  opts: CtxOpts,
): Promise<number> {
  if (!sessionId) {
    process.stderr.write(`${status.err('Pass a session id.')}\n`);
    return 2;
  }
  const json = args.includes('--json');
  const statusOnly = args.includes('--status');
  const force = args.includes('--force');
  const assumeYes = args.includes('--yes') || args.includes('-y');
  // `--force` exists to reload DURING a turn, so it ends work the user is
  // waiting on. The web asks before doing that; the CLI did not, and the only
  // warning lived in `--help` — read once, months before the command that
  // actually kills the turn. Same wording as the web confirm on purpose.
  //
  // Skipped for --json and --yes: both mean "no human here". A prompt in a
  // script hangs forever instead of failing, which is worse than not asking.
  if (force && !assumeYes && !json) {
    process.stdout.write(
      `${status.warn("Reloading restarts the runtime, which ends the turn that's running right now.")}\n` +
        `  Whatever the agent is part-way through will be lost, and you will have to send a message to continue.\n`,
    );
    if (!(await confirm('Reload anyway?', false))) {
      process.stdout.write(`${status.info('Left the session alone.')}\n`);
      return 0;
    }
  }
  const located = await locateSessionAnywhere(
    sessionId,
    opts,
    (host) => `kortix sessions reload ${sessionId} --host ${host}`,
  );
  if (!located) return 1;
  const { client, workspaceId, session } = located.located;
  const canonicalSessionId = session.session_id;

  if (statusOnly) {
    try {
      const state = await client.get<{
        running_etag: string | null;
        latest_etag: string | null;
        stale: boolean | null;
        sandbox_reachable: boolean;
      }>(`/workspaces/${workspaceId}/sessions/${canonicalSessionId}/config`);
      if (json) {
        process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
        return 0;
      }
      if (state.stale === null) {
        // Never claim "up to date" when the answer is "could not ask".
        process.stdout.write(
          `${status.warn(
            state.sandbox_reachable
              ? 'This workspace has no compiled agent config to compare.'
              : 'Sandbox unreachable — cannot tell whether this session is current.',
          )}\n`,
        );
        return 0;
      }
      process.stdout.write(
        state.stale
          ? `${status.warn(`Behind — running ${C.bold}${state.running_etag}${C.reset}, latest is ${C.bold}${state.latest_etag}${C.reset}. Run \`kortix sessions reload ${shortId(sessionId)}\`.`)}\n`
          : `${status.ok(`Up to date (${state.running_etag}).`)}\n`,
      );
      return 0;
    } catch (err) {
      return surfaceApiError(err);
    }
  }

  try {
    const result = await client.post<{
      applied: boolean;
      previous_etag: string | null;
      etag: string | null;
      repo_refreshed: boolean;
      agent_files?: string;
      detail: string;
    }>(`/workspaces/${workspaceId}/sessions/${canonicalSessionId}/reload`, {
      refresh_repo: !args.includes('--no-repo'),
      force,
    });
    if (json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    if (!result.applied) {
      process.stdout.write(`${status.warn(result.detail)}\n`);
      return 0;
    }
    // `detail` is the server's sentence and it is the only thing entitled to say
    // whether the AGENT changed. This line used to hardcode "The next prompt
    // runs the new config" for every applied reload, which was false whenever
    // the session's agent files were left alone — the etag moved and the agent
    // did not. The etag transition is still worth printing; the claim is not
    // ours to make.
    //
    // Only two outcomes deserve a warning. An earlier version keyed off a
    // boolean and warned on `already-current` and `not-applicable`, which are
    // plain successes.
    const needsAttention = result.agent_files === 'kept-yours' || result.agent_files === 'unknown';
    const etags = `${C.dim} — ${result.previous_etag ?? 'unknown'} → ${result.etag}${C.reset}`;
    const line = `Reloaded ${C.bold}${shortId(canonicalSessionId)}${C.reset}${etags}\n  ${result.detail}`;
    process.stdout.write(`${needsAttention ? status.warn(line) : status.ok(line)}\n`);
    return 0;
  } catch (err) {
    return surfaceApiError(err);
  }
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
  const canonicalSessionId = located.located.session.session_id;

  let updated: WorkspaceSession;
  try {
    updated = await located.located.client.patch<WorkspaceSession>(
      `/workspaces/${located.located.workspaceId}/sessions/${canonicalSessionId}`,
      { name },
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  if (updated.custom_name) {
    process.stdout.write(`${status.ok(`Renamed to ${C.bold}${updated.custom_name}${C.reset}`)}\n`);
  } else {
    process.stdout.write(
      `${status.ok(`Name cleared — using automatic title${updated.name ? ` ${C.dim}(${updated.name})${C.reset}` : ''}`)}\n`,
    );
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
  const canonicalSessionId = located.located.session.session_id;

  try {
    await located.located.client.delete(
      `/workspaces/${located.located.workspaceId}/sessions/${canonicalSessionId}`,
    );
  } catch (err) {
    return surfaceApiError(err);
  }
  process.stdout.write(`${status.ok(`Deleted ${C.bold}${shortId(canonicalSessionId)}${C.reset}`)}\n`);
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
  const url = sessionWebUrl(
    located.located.auth.api_base,
    located.located.workspaceId,
    located.located.session.session_id,
  );
  process.stdout.write(`${C.dim}Opening ${url}${C.reset}\n`);
  openInBrowser(url);
  return 0;
}

// ── helpers ────────────────────────────────────────────────────────────────

function shortId(id: string): string {
  return id.split('-')[0] ?? id;
}

function serverCanCreateBranch(workspace: WorkspaceSummary): boolean {
  const meta = (workspace.metadata ?? {}) as Record<string, any>;
  const git = meta.git as
    | { provider?: string; managed?: boolean; auth?: { method?: string } }
    | undefined;
  // Managed repos: the server holds the credential and can create the branch.
  if (git?.managed === true) return true;
  const github = meta.github as { auth_source?: string } | undefined;
  return github?.auth_source === 'app_installation' || github?.auth_source === 'pat';
}

function normalizeGitUrl(url: string): string {
  const trimmed = url.trim();
  const ssh = trimmed.match(/^git@([^:]+):(.+)$/);
  if (ssh)
    return `${ssh[1]}/${ssh[2]}`
      .replace(/\/+$/, '')
      .replace(/\.git$/i, '')
      .toLowerCase();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'ssh:') {
      return `${parsed.hostname}${parsed.pathname}`
        .replace(/\/+$/, '')
        .replace(/\.git$/i, '')
        .toLowerCase();
    }
  } catch {
    // Local paths are valid git remotes too; compare them as normalized strings.
  }
  return trimmed
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
}

function runGit(args: string[]): {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
} {
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
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawnSync(cmd, args, { stdio: 'ignore' });
}
