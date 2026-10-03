import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { createKortixPty } from '@kortix/sdk';

import { hasEnvTokenHost } from '../api/config.ts';
import { kortixFromAuth, withKortixScope } from '../api/sdk.ts';
import type { ProjectSession, ProjectSummary } from '../api/types.ts';
import { fail, resolveProjectContext, surfaceApiError } from '../command-helpers.ts';
import { loadLink } from '../project-link.ts';
import { resolveProjectGitTarget } from '../project-git.ts';
import { attachPty } from '../pty-attach.ts';
import { C, help, status } from '../style.ts';
import { authHeaderArgs } from './ship.ts';

const RUN_HELP = help`Usage: kortix run [options] [--] <command> [args...]
       kortix claude [args...]
       kortix codex [args...]
       kortix opencode [args...]

Run a command in a cloud sandbox booted from this directory, attached to your
terminal like ssh. The sandbox gets your working tree exactly as it is now —
uncommitted and untracked files included (.gitignore applies) — on a fresh
Kortix session. When the command exits, whatever it changed in the sandbox is
applied back to this folder as uncommitted changes, as if it had run here.

\`kortix claude\`, \`kortix codex\`, and \`kortix opencode\` pass every argument
through to the agent unchanged, so your local habits carry over:

  kortix claude --dangerously-skip-permissions
  kortix codex --dangerously-bypass-approvals-and-sandbox
  kortix opencode

Your local agent login comes along: Claude Code reads CLAUDE_CODE_OAUTH_TOKEN
or ANTHROPIC_API_KEY from your environment, else your local Claude login;
Codex reads ~/.codex/auth.json. Only the short-lived access token is sent —
never a refresh token — and it is deleted from the sandbox when the command
exits. For runs longer than the Claude login lasts, export a long-lived token
from \`claude setup-token\` as CLAUDE_CODE_OAUTH_TOKEN.

The sandbox is a normal Kortix session: the project's kortix.yaml sandbox
template, secrets, and connectors apply, and it shows in the dashboard. The
project keeps one sandbox booted for you (warm sessions), so a run takes it
and boots the next one in the background. With
no TTY, output streams plainly and the exit code is the remote command's, so
scripts and other agents can call it.

Options (before the command):
  --session <id>   Run in an existing session instead of booting a new one.
  --project <id>   Pin the project (default: this folder's .kortix/link.json).
  --host <name>    Pin the Kortix host.
  -h, --help       Show this help.

Examples:
  kortix run -- pnpm test
  kortix run --session <session-id> -- bash
  kortix run                      # a login shell`;

/** npm packages for agent CLIs a project image may not carry yet. */
const AGENT_PACKAGES: Record<string, string> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  opencode: 'opencode-ai',
};

const PTY_ENV = { TERM: 'xterm-256color', COLORTERM: 'truecolor' } as const;

interface RunFlags {
  sessionArg?: string;
  projectArg?: string;
  hostArg?: string;
  command: string[];
}

/** Kortix flags are only read BEFORE the command, so nothing after it — the
 *  agent's own `--help`, `--project` — is ever swallowed. */
export function parseRunArgv(argv: string[]): RunFlags | 'help' | string {
  const flags: RunFlags = { command: [] };
  let i = 0;
  for (; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--') {
      i += 1;
      break;
    }
    if (a === '-h' || a === '--help') return 'help';
    const key = a.split('=')[0]!;
    if (key === '--session' || key === '--project' || key === '--host') {
      const value = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i];
      if (!value) return `${key} needs a value.`;
      if (key === '--session') flags.sessionArg = value;
      else if (key === '--project') flags.projectArg = value;
      else flags.hostArg = value;
      continue;
    }
    if (a.startsWith('-')) return `Unknown option ${a}. Put the command after \`--\`.`;
    break;
  }
  flags.command = argv.slice(i);
  return flags;
}

/** Entry for `kortix run …`. */
export function runRun(argv: string[]): Promise<number> {
  const parsed = parseRunArgv(argv);
  if (parsed === 'help') {
    process.stdout.write(`${RUN_HELP}\n`);
    return Promise.resolve(0);
  }
  if (typeof parsed === 'string') return Promise.resolve(fail(parsed));
  return runInCloud(parsed);
}

/** Entry for `kortix claude|codex|opencode …`: every argument is the agent's. */
export function runAgentInCloud(agent: string, argv: string[]): Promise<number> {
  return runInCloud({ command: [agent, ...argv] });
}

/** Async git, for the push that overlaps the sandbox boot. */
function gitAsync(args: string[]): Promise<{ ok: boolean; err: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('close', (code) => resolve({ ok: code === 0, err: err.trim() }));
    child.on('error', (e) => resolve({ ok: false, err: e.message }));
  });
}

function git(args: string[], env?: NodeJS.ProcessEnv) {
  const r = spawnSync('git', args, { encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

/**
 * Commit the working tree as it is — tracked edits, untracked files, staged or
 * not — WITHOUT touching the user's index, branch, or stash: a throwaway index
 * file gets `add -A`, and `commit-tree` makes a commit no ref points at.
 * Returns HEAD itself when the tree is clean.
 */
export function snapshotWorkingTree(): { sha: string; dirty: boolean } | { error: string } {
  if (!git(['rev-parse', '--is-inside-work-tree']).ok) return { error: 'Not inside a git repository.' };
  const dir = mkdtempSync(join(tmpdir(), 'kortix-run-'));
  try {
    const index = join(dir, 'index');
    const realIndex = git(['rev-parse', '--path-format=absolute', '--git-path', 'index']).out;
    // Seed from the real index so `add -A` only re-hashes changed files.
    if (realIndex && existsSync(realIndex)) copyFileSync(realIndex, index);
    const env = { GIT_INDEX_FILE: index };
    const top = git(['rev-parse', '--show-toplevel']).out;
    const add = git(['-C', top, 'add', '-A'], env);
    if (!add.ok) return { error: `git add failed: ${add.err}` };
    const tree = git(['write-tree'], env);
    if (!tree.ok) return { error: `git write-tree failed: ${tree.err}` };
    const head = git(['rev-parse', '--verify', '-q', 'HEAD']).out;
    if (head && git(['rev-parse', 'HEAD^{tree}']).out === tree.out) return { sha: head, dirty: false };
    // A snapshot needs an identity even where the user never configured one.
    const identity = git(['config', 'user.email']).ok
      ? {}
      : { GIT_AUTHOR_NAME: 'Kortix', GIT_AUTHOR_EMAIL: 'cli@kortix.com', GIT_COMMITTER_NAME: 'Kortix', GIT_COMMITTER_EMAIL: 'cli@kortix.com' };
    const commit = git(
      ['commit-tree', tree.out, ...(head ? ['-p', head] : []), '-m', 'kortix run: working tree snapshot'],
      identity,
    );
    if (!commit.ok) return { error: `git commit-tree failed: ${commit.err}` };
    return { sha: commit.out, dirty: true };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface SandboxFile {
  path: string;
  content: string;
  /** Secret files are deleted when the command exits. */
  secret: boolean;
  /** Keep an existing file (onboarding state the agent itself maintains). */
  keepExisting?: boolean;
}

interface AgentAuth {
  files: SandboxFile[];
  env: Record<string, string>;
  notes: string[];
}

function readClaudeLocalCredentials(): string | null {
  const file = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), '.credentials.json');
  if (existsSync(file)) return readFileSync(file, 'utf8');
  if (process.platform !== 'darwin') return null;
  const r = spawnSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
    encoding: 'utf8',
  });
  return r.status === 0 ? r.stdout.trim() : null;
}

function minutesLeft(epochMs: number): number {
  return Math.floor((epochMs - Date.now()) / 60_000);
}

/**
 * The agent's local login, reduced to what a sandbox needs. Refresh tokens
 * never leave this machine: both providers rotate them on use, so a sandbox
 * refreshing a copy would sign the user out locally.
 */
export function agentAuthFor(agent: string): AgentAuth {
  const auth: AgentAuth = { files: [], env: {}, notes: [] };
  if (agent === 'claude') {
    // Skip first-run onboarding, the folder-trust prompt, and the
    // bypass-permissions confirmation: the user asked for this exact command.
    auth.files.push({
      path: '$HOME/.claude.json',
      content: JSON.stringify({
        hasCompletedOnboarding: true,
        bypassPermissionsModeAccepted: true,
        projects: { '/workspace': { hasTrustDialogAccepted: true } },
      }),
      secret: false,
      keepExisting: true,
    });
    for (const name of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'] as const) {
      const value = process.env[name];
      if (value) {
        auth.env[name] = value;
        return auth;
      }
    }
    const raw = readClaudeLocalCredentials();
    const oauth = raw ? (JSON.parse(raw) as { claudeAiOauth?: Record<string, unknown> }).claudeAiOauth : undefined;
    if (!oauth?.accessToken) {
      auth.notes.push('No local Claude login found — run `claude` here once, or export CLAUDE_CODE_OAUTH_TOKEN.');
      return auth;
    }
    const left = minutesLeft(Number(oauth.expiresAt ?? 0));
    if (left < 1) {
      auth.notes.push('Your local Claude login has expired — run `claude` here once to refresh it.');
      return auth;
    }
    if (left < 60) {
      auth.notes.push(
        `Your Claude login expires in ${left} min. For longer runs: \`claude setup-token\`, then export CLAUDE_CODE_OAUTH_TOKEN.`,
      );
    }
    const { refreshToken: _drop, ...access } = oauth;
    auth.files.push({
      path: '$HOME/.claude/.credentials.json',
      content: JSON.stringify({ claudeAiOauth: access }),
      secret: true,
    });
    return auth;
  }
  if (agent === 'codex') {
    auth.files.push({
      path: '$HOME/.codex/config.toml',
      content: '[projects."/workspace"]\ntrust_level = "trusted"\n',
      secret: false,
      keepExisting: true,
    });
    const file = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
    if (!existsSync(file)) {
      auth.notes.push('No local Codex login found — run `codex login` here once.');
      return auth;
    }
    const data = JSON.parse(readFileSync(file, 'utf8')) as {
      tokens?: Record<string, unknown> | null;
      last_refresh?: string;
    };
    if (data.tokens) {
      // last_refresh=now keeps Codex from refreshing a token it cannot refresh.
      data.tokens = { ...data.tokens, refresh_token: '' };
      data.last_refresh = new Date().toISOString();
    }
    auth.files.push({ path: '$HOME/.codex/auth.json', content: JSON.stringify(data), secret: true });
  }
  return auth;
}

/**
 * The script the PTY runs: move the checkout onto the snapshot, write the
 * agent's files, install the agent if the image lacks it, run the command,
 * delete the secrets, and exit with the command's code. File contents travel
 * as env values, never in the script or argv.
 */
export function buildBootstrap(input: { ref?: string; base?: string; files: SandboxFile[]; agent?: string }): {
  script: string;
  env: Record<string, string>;
} {
  const env: Record<string, string> = {};
  // No echo until the client's go byte arrives (see the read below).
  const lines = ['set -e', 'stty -echo 2>/dev/null || true'];
  const pkg = input.agent ? AGENT_PACKAGES[input.agent] : undefined;
  if (pkg) {
    lines.push(
      // In the background, alongside the checkout sync. ~/.local/bin is on the
      // sandbox PATH; npm's own global prefix is not. npm 12 blocks install
      // scripts unless allowed, and the agent CLIs ship their binary through one.
      `command -v ${input.agent} >/dev/null 2>&1 || { echo "Installing ${input.agent}…" >&2; npm install -g --prefix "$HOME/.local" --silent --no-fund --no-audit --allow-scripts=${pkg} ${pkg} >/dev/null 2>&1 & install_pid=$!; }`,
    );
  }
  if (input.ref) {
    env.KORTIX_RUN_REF = input.ref;
    lines.push(
      'shallow=; [ -f "$(git rev-parse --git-dir)/shallow" ] && shallow=--depth=1',
      // Quiet unless it fails: the remote prints progress even with -q.
      'out=$(git fetch -q $shallow origin "+refs/heads/$KORTIX_RUN_REF:refs/remotes/origin/$KORTIX_RUN_REF" 2>&1) || { printf "%s\\n" "$out" >&2; exit 1; }',
      // A partial clone fetches blobs during the reset: same treatment.
      'out=$(git reset -q --hard "refs/remotes/origin/$KORTIX_RUN_REF" 2>&1) || { printf "%s\\n" "$out" >&2; exit 1; }',
    );
  }
  const secrets: string[] = [];
  input.files.forEach((f, n) => {
    const name = `KORTIX_RUN_FILE_${n}`;
    env[name] = Buffer.from(f.content).toString('base64');
    const write = `mkdir -p "$(dirname "${f.path}")" && printf %s "$${name}" | base64 -d > "${f.path}" && chmod 600 "${f.path}"`;
    lines.push(f.keepExisting ? `[ -f "${f.path}" ] || { ${write}; }` : write);
    if (f.secret) secrets.push(`"${f.path}"`);
  });
  if (input.files.length) lines.push(`unset ${input.files.map((_, n) => `KORTIX_RUN_FILE_${n}`).join(' ')}`);
  if (pkg) lines.push('[ -z "${install_pid:-}" ] || wait "$install_pid" || echo "Installing the agent failed." >&2');
  if (input.agent === 'opencode') {
    // The session's own OpenCode config: the project's agents and Kortix models.
    lines.push(
      '[ ! -f "$HOME/.config/kortix-opencode.json" ] || export OPENCODE_CONFIG="$HOME/.config/kortix-opencode.json" OPENCODE_CONFIG_DIR=/opt/kortix/config/boot',
    );
  }
  // Wait for the attach: the daemon closes an exited PTY without replaying its
  // output, so a command that finished before the client connected would
  // print nothing. The client sends one byte the moment its socket opens.
  lines.push('IFS= read -r -s -n 1 _ || true', 'stty echo 2>/dev/null || true', 'set +e');
  if (!input.ref && !secrets.length) {
    lines.push('exec "$@"');
    return { script: lines.join('\n'), env };
  }
  lines.push('"$@"; code=$?');
  if (secrets.length) lines.push(`rm -f ${secrets.join(' ')}`);
  if (input.ref && input.base) {
    // Hand the work back: commit whatever the command changed and push it to
    // the session branch, where the CLI picks it up.
    env.KORTIX_RUN_BASE = input.base;
    lines.push(
      'git add -A >/dev/null 2>&1 && { git diff --cached --quiet || git commit -q --no-verify -m "kortix run: $1" >/dev/null 2>&1; }',
      'if [ "$(git rev-parse HEAD 2>/dev/null)" != "$KORTIX_RUN_BASE" ]; then',
      '  git push -q origin "HEAD:refs/heads/$KORTIX_RUN_REF" >/dev/null 2>&1 || echo "Could not push the changes to the session branch." >&2',
      'fi',
    );
  }
  lines.push('exit $code');
  return { script: lines.join('\n'), env };
}

/**
 * Apply what the command changed in the sandbox to this working tree: the diff
 * from the snapshot to the session branch tip. The local tree still equals the
 * snapshot unless the user edited it meanwhile; then the patch may not apply,
 * and the changes stay on the session branch.
 */
export function pullSessionChanges(repo: { url: string; auth: string[] }, branch: string, snapSha: string): void {
  const fetched = git([...repo.auth, 'fetch', '-q', '--no-tags', repo.url, `refs/heads/${branch}`]);
  const tip = fetched.ok ? git(['rev-parse', 'FETCH_HEAD']).out : '';
  if (!tip || tip === snapSha) return;
  const top = git(['rev-parse', '--show-toplevel']).out;
  const files = git(['diff', '--name-only', snapSha, tip]).out.split('\n').filter(Boolean);
  const patch = spawnSync('git', ['diff', '--binary', snapSha, tip], { encoding: 'buffer', maxBuffer: 1 << 30 });
  const apply = spawnSync('git', ['-C', top, 'apply', '--whitespace=nowarn', '-'], { input: patch.stdout, encoding: 'utf8' });
  if (apply.status === 0) {
    process.stderr.write(`\n${status.ok(`Applied ${files.length} changed file${files.length === 1 ? '' : 's'} from the sandbox`)}\n`);
    for (const f of files.slice(0, 20)) process.stderr.write(`  ${C.dim}${f}${C.reset}\n`);
    if (files.length > 20) process.stderr.write(`  ${C.dim}… ${files.length - 20} more${C.reset}\n`);
    return;
  }
  process.stderr.write(
    `\n${status.warn(`The sandbox changed ${files.length} file(s), but they do not apply cleanly here.`)}\n` +
      `  ${C.dim}They are on the session branch:${C.reset} ${C.cyan}git fetch ${repo.url} ${branch} && git diff ${snapSha.slice(0, 8)} FETCH_HEAD${C.reset}\n`,
  );
}

async function reportPush(pushed: Promise<{ ok: boolean; err: string }>): Promise<boolean> {
  const push = await pushed;
  if (push.ok) return true;
  process.stderr.write(`${status.err('Could not push the working tree to the project repo.')}\n`);
  if (push.err) process.stderr.write(`  ${C.dim}${push.err.split('\n').join('\n  ')}${C.reset}\n`);
  return false;
}

/**
 * The project's warm session: a sandbox the platform keeps booted per user per
 * project (the `warm_sessions` flag, on by default). POST /sessions/warm
 * returns the live one or starts booting one. Null when the project has none —
 * the caller creates a session the ordinary way.
 */
async function takeWarmSession(
  ctx: { client: { post<T>(path: string, body?: unknown): Promise<T> }; projectId: string },
  excludeSessionId?: string,
): Promise<ProjectSession | null> {
  try {
    const res = await ctx.client.post<{ session: ProjectSession }>(
      `/projects/${ctx.projectId}/sessions/warm`,
      excludeSessionId ? { exclude_session_id: excludeSessionId } : {},
    );
    return res.session ?? null;
  } catch {
    return null;
  }
}

async function runInCloud(flags: RunFlags): Promise<number> {
  const started = Date.now();
  const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
  // A bound folder is the only safe default: the snapshot is pushed to the
  // project's repo, so it must be THIS folder's project, never a default one.
  // Inside a sandbox the env token binds /workspace to its own project.
  if (!flags.sessionArg && !flags.projectArg && !loadLink() && !hasEnvTokenHost()) {
    process.stderr.write(
      `${status.err('This folder is not bound to a Kortix project.')}\n` +
        `  ${C.dim}Run${C.reset} ${C.cyan}kortix ship${C.reset} ${C.dim}to create one from it, or${C.reset} ${C.cyan}kortix projects link <id>${C.reset}${C.dim}.${C.reset}\n`,
    );
    return 1;
  }
  const ctx = await resolveProjectContext({ projectArg: flags.projectArg, hostArg: flags.hostArg });
  if (!ctx) return 1;

  const agent = flags.command[0] ? basename(flags.command[0]) : undefined;
  const command = flags.command.length ? flags.command : ['bash', '-l'];
  const agentAuth = agent ? agentAuthFor(agent) : { files: [], env: {}, notes: [] };
  for (const note of agentAuth.notes) process.stderr.write(`${status.warn(note)}\n`);

  let sessionId = flags.sessionArg;
  let ref: string | undefined;
  let snapSha: string | undefined;
  let repo: { url: string; auth: string[] } | undefined;
  let warm = false;
  let pushed: Promise<{ ok: boolean; err: string }> = Promise.resolve({ ok: true, err: '' });
  if (!sessionId) {
    const snap = snapshotWorkingTree();
    if ('error' in snap) return fail(snap.error);

    let project: ProjectSummary;
    let warmSession: ProjectSession | null;
    try {
      [project, warmSession] = await Promise.all([
        ctx.client.get<ProjectSummary>(`/projects/${ctx.projectId}`),
        takeWarmSession(ctx),
      ]);
    } catch (err) {
      return surfaceApiError(err);
    }
    // The snapshot goes to the session's own branch, so the session never
    // touches the user's branches and the work stays fetchable afterwards.
    sessionId = warmSession?.session_id ?? randomUUID();
    warm = warmSession !== null;
    const target = resolveProjectGitTarget(project);
    let token: string | null = null;
    let username = 'x-access-token';
    if (target.credentialMode === 'kortix-token') token = ctx.auth.token;
    else if (target.credentialMode === 'managed-git-token') {
      try {
        const minted = await ctx.client.post<{ push_token: string; git_username?: string | null }>(
          `/projects/${ctx.projectId}/git-token`,
        );
        token = minted.push_token;
        username = minted.git_username ?? username;
      } catch (err) {
        return surfaceApiError(err);
      }
    }
    // `+`: a warm session's branch already exists at the project's base. The
    // push runs while the sandbox boots; only the in-box fetch waits for it.
    const snapLabel = `${snap.dirty ? 'working tree' : 'HEAD'} ${snap.sha.slice(0, 8)}`;
    snapSha = snap.sha;
    repo = { url: target.repoUrl, auth: token ? authHeaderArgs(target.repoUrl, token, username) : [] };
    pushed = gitAsync([...repo.auth, 'push', '-q', repo.url, `+${snap.sha}:refs/heads/${sessionId}`]).then((push) => {
      if (push.ok) process.stderr.write(`${C.dim}  synced ${snapLabel} · ${elapsed()}${C.reset}\n`);
      return push;
    });
    ref = sessionId;

    const name = `${command.join(' ').slice(0, 60)} · ${basename(process.cwd())}`;
    try {
      if (warm) {
        // Cosmetic: never wait on it.
        void ctx.client.patch(`/projects/${ctx.projectId}/sessions/${sessionId}`, { name }).catch(() => {});
      } else {
        // The create boots from the branch, so it must exist first.
        if (!(await reportPush(pushed))) return 1;
        await ctx.client.post<ProjectSession>(`/projects/${ctx.projectId}/sessions`, {
          session_id: sessionId,
          branch_already_created: true,
          name,
        });
      }
    } catch (err) {
      return surfaceApiError(err);
    }
  }

  let runtimeUrl: string;
  let ptyId: string;
  try {
    runtimeUrl = await withKortixScope(ctx.auth, async () =>
      (await kortixFromAuth(ctx.auth).session(ctx.projectId, sessionId).ensureReady()).runtimeUrl,
    );
    process.stderr.write(`${C.dim}  sandbox ready${warm ? ' (warm)' : ''} · ${elapsed()}${C.reset}\n`);
    if (!(await reportPush(pushed))) return 1;
    const boot = buildBootstrap({ ref, base: snapSha, files: agentAuth.files, agent });
    const pty = await withKortixScope(ctx.auth, async () =>
      createKortixPty(runtimeUrl, {
        command: 'bash',
        // bash -l loads the session's env file (project secrets, KORTIX_TOKEN).
        args: ['-lc', boot.script, 'kortix-run', ...command],
        title: command.join(' ').slice(0, 80),
        env: {
          ...PTY_ENV,
          // A pipe on this end cannot page: never block on a remote pager.
          ...(process.stdout.isTTY ? {} : { PAGER: 'cat', GIT_PAGER: 'cat' }),
          ...boot.env,
          ...agentAuth.env,
        },
      }),
    );
    ptyId = pty.id;
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    process.stderr.write(`  ${C.dim}session ${sessionId}${C.reset}\n`);
    return 1;
  }

  // Boot the NEXT run's sandbox now, so it is warm when the user comes back.
  // `/start` (inside ensureReady) already took this one out of the warm pool.
  if (!flags.sessionArg) void takeWarmSession(ctx, sessionId);
  const { exitCode } = await attachPty(ctx.auth, runtimeUrl, ptyId, { goByte: true });
  if (exitCode !== null && ref && snapSha && repo) pullSessionChanges(repo, ref, snapSha);
  process.stderr.write(
    `\n${C.dim}  session ${sessionId}${exitCode !== null && exitCode !== 0 ? ` · exit ${exitCode}` : ''}${C.reset}\n` +
      `${C.dim}  again:  ${C.reset}${C.cyan}kortix run --session ${sessionId} -- ${command[0]}${C.reset}\n` +
      `${C.dim}  shell:  ${C.reset}${C.cyan}kortix sessions shell ${sessionId}${C.reset}\n`,
  );
  return exitCode ?? 1;
}
