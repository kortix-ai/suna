import type { WorkspaceSession } from '../api/types.ts';
import { resolveWorkspaceContext, surfaceApiError } from '../command-helpers.ts';
import { confirm } from '../prompts.ts';
import { C, status } from '../style.ts';
import { type SelectItem, selectFromList } from '../tui-select.ts';
import { prepareClientCreatedBranch } from './sessions.ts';

type Ctx = NonNullable<Awaited<ReturnType<typeof resolveWorkspaceContext>>>;

type CtxOpts = { workspaceArg?: string; hostArg?: string };

/** Session states a picked row has to traverse before `connect` can attach. */
const DORMANT: ReadonlySet<WorkspaceSession['status']> = new Set([
  'stopped',
  'completed',
  'failed',
]);

export type ConnectPickerChoice = WorkspaceSession | 'new';

/**
 * Picker rows for `kortix connect` with no session id: running sessions first
 * (most recent first), then still-booting ones, then a bounded tail of dormant
 * ones (connect restarts those), and always a "start fresh" row.
 */
export function buildConnectPickerItems(
  sessions: WorkspaceSession[],
): SelectItem<ConnectPickerChoice>[] {
  const byRecency = (a: WorkspaceSession, b: WorkspaceSession) =>
    Date.parse(b.updated_at) - Date.parse(a.updated_at);
  const running = sessions.filter((s) => s.status === 'running').sort(byRecency);
  const booting = sessions
    .filter((s) => !DORMANT.has(s.status) && s.status !== 'running')
    .sort(byRecency);
  const dormant = sessions
    .filter((s) => DORMANT.has(s.status))
    .sort(byRecency)
    .slice(0, 15);

  const row = (s: WorkspaceSession, hint: string): SelectItem<ConnectPickerChoice> => ({
    value: s,
    label: s.name ?? s.session_id.split('-')[0] ?? s.session_id,
    sublabel: `${s.status} · ${s.session_id.split('-')[0]} · ${s.branch_name}${hint}`,
  });

  return [
    ...running.map((s) => row(s, '')),
    ...booting.map((s) => row(s, ' · waits for boot')),
    ...dormant.map((s) => row(s, ' · starts it first')),
    { value: 'new', label: '+ New session', sublabel: 'fresh sandbox on this workspace' },
  ];
}

/**
 * Interactive session selection for `kortix connect` when no id was given:
 * pick a session in the bound workspace — dormant ones are restarted and
 * awaited, `+ New session` provisions a fresh sandbox — and return the id the
 * caller should attach to. Returns null after printing its own message when
 * the user cancels or a boot fails.
 */
export async function pickConnectSessionId(opts: CtxOpts): Promise<string | null> {
  const ctx = await resolveWorkspaceContext(opts);
  if (!ctx) return null;

  let sessions: WorkspaceSession[];
  try {
    sessions = await ctx.client.get<WorkspaceSession[]>(
      `/workspaces/${ctx.workspaceId}/sessions`,
    );
  } catch (err) {
    surfaceApiError(err);
    return null;
  }

  const chosen = await pickSession(sessions);
  if (chosen === null) {
    process.stderr.write(`${C.dim}Nothing selected.${C.reset}\n`);
    return null;
  }

  if (chosen === 'new') {
    const created = await createSession(ctx);
    if (!created) return null;
    if (!(await waitUntilReady(ctx, created))) return null;
    return created;
  }

  if (chosen.status !== 'running') {
    if (DORMANT.has(chosen.status)) {
      try {
        await ctx.client.post(
          `/workspaces/${ctx.workspaceId}/sessions/${chosen.session_id}/restart`,
          {},
        );
      } catch (err) {
        surfaceApiError(err);
        return null;
      }
    }
    if (!(await waitUntilReady(ctx, chosen.session_id))) return null;
  }
  return chosen.session_id;
}

async function pickSession(sessions: WorkspaceSession[]): Promise<ConnectPickerChoice | null> {
  if (sessions.length === 0) {
    const start = await confirm('No sessions in this workspace yet — start one now?', true, {
      onEndOfInput: false,
    });
    return start ? 'new' : null;
  }
  return selectFromList<ConnectPickerChoice>({
    title: 'Pick a session to connect to',
    items: buildConnectPickerItems(sessions),
  });
}

async function createSession(ctx: Ctx): Promise<string | null> {
  const body: Record<string, unknown> = {};
  if ((await prepareClientCreatedBranch(ctx, body)) === 'error') return null;
  try {
    const created = await ctx.client.post<WorkspaceSession>(
      `/workspaces/${ctx.workspaceId}/sessions`,
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
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, 4000));
    let stage: string;
    let reason: string | undefined;
    try {
      const start = await ctx.client.post<{
        stage: 'provisioning' | 'starting' | 'ready' | 'stopped' | 'failed';
        reason?: string;
      }>(`/workspaces/${ctx.workspaceId}/sessions/${sessionId}/start`, {});
      stage = start.stage;
      reason = start.reason;
    } catch (err) {
      return surfaceApiError(err) === 0;
    }
    if (stage === 'ready') return true;
    // A just-restarted session can report `stopped` for a few polls before the
    // provisioner picks it up. Treat it as terminal only after that grace.
    if (stage === 'stopped' && i < 5) continue;
    if (stage === 'failed' || stage === 'stopped') {
      process.stderr.write(
        `${status.err(`Session did not start (${stage}${reason ? `: ${reason}` : ''}).`)}\n` +
          `  ${C.dim}Try ${C.reset}${C.cyan}kortix sessions restart ${sessionId}${C.reset}${C.dim}, then ${C.reset}${C.cyan}kortix connect${C.reset}${C.dim} again.${C.reset}\n`,
      );
      return false;
    }
  }
  process.stderr.write(`${status.err('Timed out waiting for the sandbox to start.')}\n`);
  return false;
}
