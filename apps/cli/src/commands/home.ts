import { loadAuth } from '../api/auth.ts';
import type { ProjectSession } from '../api/types.ts';
import { resolveProjectContext, surfaceApiError } from '../command-helpers.ts';
import { confirm } from '../prompts.ts';
import { C, status } from '../style.ts';
import { selectFromList } from '../tui-select.ts';
import { runSessionsConnect } from './sessions-connect.ts';
import { prepareClientCreatedBranch } from './sessions.ts';

type Ctx = NonNullable<Awaited<ReturnType<typeof resolveProjectContext>>>;

/** Session states a picked row has to traverse before `connect` can attach. */
const DORMANT: ReadonlySet<ProjectSession['status']> = new Set(['stopped', 'completed', 'failed']);

/**
 * Bare `kortix` on an interactive terminal: pick a session in the bound
 * project — running ones attach immediately, dormant ones are booted first,
 * or start a fresh one — then hand the terminal to the full OpenCode TUI via
 * `sessions connect`.
 *
 * Returns the sentinel `'landing'` when this flow does not apply (non-TTY, or
 * not logged in) so `main` can fall back to the classic landing screen —
 * scripts that run bare `kortix` for the command list keep working, and a
 * logged-out human still gets the "run `kortix login`" landing instead of an
 * error.
 */
export async function runHome(): Promise<number | 'landing'> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return 'landing';
  if (!loadAuth()?.token) return 'landing';

  // From here on this IS the connect command: resolveProjectContext prints its
  // own guidance (and interactively binds a default project when none is
  // linked), so a failure is a real error, not a landing fallback.
  const ctx = await resolveProjectContext({});
  if (!ctx) return 1;

  let sessions: ProjectSession[];
  try {
    sessions = await ctx.client.get<ProjectSession[]>(`/projects/${ctx.projectId}/sessions`);
  } catch (err) {
    return surfaceApiError(err);
  }

  const chosen = await pickSession(sessions);
  if (chosen === null) {
    process.stderr.write(
      `${C.dim}Nothing selected. Run ${C.reset}${C.cyan}kortix help${C.reset}${C.dim} for all commands.${C.reset}\n`,
    );
    return 0;
  }

  let sessionId: string;
  if (chosen === 'new') {
    const created = await createSession(ctx);
    if (!created) return 1;
    sessionId = created;
    if (!(await waitUntilReady(ctx, sessionId))) return 1;
  } else {
    sessionId = chosen.session_id;
    if (chosen.status !== 'running') {
      if (DORMANT.has(chosen.status)) {
        try {
          await ctx.client.post(`/projects/${ctx.projectId}/sessions/${sessionId}/restart`, {});
        } catch (err) {
          return surfaceApiError(err);
        }
      }
      if (!(await waitUntilReady(ctx, sessionId))) return 1;
    }
  }

  return runSessionsConnect([sessionId, '--project', ctx.projectId]);
}

async function pickSession(sessions: ProjectSession[]): Promise<ProjectSession | 'new' | null> {
  if (sessions.length === 0) {
    const start = await confirm('No sessions in this project yet — start one now?', true, {
      onEndOfInput: false,
    });
    return start ? 'new' : null;
  }

  const byRecency = (a: ProjectSession, b: ProjectSession) =>
    Date.parse(b.updated_at) - Date.parse(a.updated_at);
  const running = sessions.filter((s) => s.status === 'running').sort(byRecency);
  const booting = sessions
    .filter((s) => !DORMANT.has(s.status) && s.status !== 'running')
    .sort(byRecency);
  const dormant = sessions
    .filter((s) => DORMANT.has(s.status))
    .sort(byRecency)
    .slice(0, 15);

  const row = (s: ProjectSession, hint: string) => ({
    value: s as ProjectSession | 'new',
    label: s.name ?? s.session_id.split('-')[0] ?? s.session_id,
    sublabel: `${s.status} · ${s.session_id.split('-')[0]} · ${s.branch_name}${hint}`,
  });

  return selectFromList<ProjectSession | 'new'>({
    title: 'Connect to a session',
    items: [
      ...running.map((s) => row(s, '')),
      ...booting.map((s) => row(s, ' · waits for boot')),
      ...dormant.map((s) => row(s, ' · starts it first')),
      { value: 'new', label: '+ New session', sublabel: 'fresh sandbox on this project' },
    ],
  });
}

async function createSession(ctx: Ctx): Promise<string | null> {
  const body: Record<string, unknown> = {};
  if ((await prepareClientCreatedBranch(ctx, body)) === 'error') return null;
  try {
    const created = await ctx.client.post<ProjectSession>(
      `/projects/${ctx.projectId}/sessions`,
      body,
    );
    return created.session_id;
  } catch (err) {
    surfaceApiError(err);
    return null;
  }
}

/**
 * Drive the canonical `/start` lifecycle endpoint until the runtime is ready —
 * the same loop `sessions new --wait` runs (row status alone can say "running"
 * before OpenCode actually answers). Sandbox boots take minutes, not seconds:
 * up to 75 × 4s ≈ 5 min, matching the API's own provisioning ceiling.
 */
async function waitUntilReady(ctx: Ctx, sessionId: string): Promise<boolean> {
  process.stderr.write(`${C.dim}  waiting for the sandbox to come up…${C.reset}\n`);
  for (let i = 0; i < 75; i += 1) {
    if (i > 0) await new Promise((r) => setTimeout(r, 4000));
    let stage: string;
    let reason: string | undefined;
    try {
      const start = await ctx.client.post<{
        stage: 'provisioning' | 'starting' | 'ready' | 'stopped' | 'failed';
        reason?: string;
      }>(`/projects/${ctx.projectId}/sessions/${sessionId}/start`, {});
      stage = start.stage;
      reason = start.reason;
    } catch (err) {
      return surfaceApiError(err) === 0;
    }
    if (stage === 'ready') return true;
    // A just-restarted session can report `stopped` for a few polls before the
    // provisioner picks it up — only treat it as terminal once that grace is
    // clearly over.
    if (stage === 'stopped' && i < 5) continue;
    if (stage === 'failed' || stage === 'stopped') {
      process.stderr.write(
        `${status.err(`Session did not start (${stage}${reason ? `: ${reason}` : ''}).`)}\n` +
          `  ${C.dim}Try ${C.reset}${C.cyan}kortix sessions restart ${sessionId}${C.reset}${C.dim}, then ${C.reset}${C.cyan}kortix${C.reset}${C.dim} again.${C.reset}\n`,
      );
      return false;
    }
  }
  process.stderr.write(`${status.err('Timed out waiting for the sandbox to start.')}\n`);
  return false;
}
