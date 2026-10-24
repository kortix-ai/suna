/**
 * Session lifecycle verbs the dashboard has and the CLI did not: pause a
 * session, wake one back up, pre-warm one, change its model mid-flight,
 * compact its conversation, restore a deleted one, and continue a lost one.
 *
 * `restart` (re-provision) already lives in sessions.ts and is a different
 * thing: `stop`/`start` are the same pause/resume pair the session header's
 * Stop button and the session page's open call drive, disk kept.
 */

import { ApiError, runtimeSupports } from '@kortix/sdk';

import {
  SESSION_UUID_RE,
  emitJson,
  locateSessionAnywhere,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { withKortixScope } from '../api/sdk.ts';
import type { ProjectSession } from '../api/types.ts';
import { readRuntimeCapabilities } from '../session-runtime.ts';
import { C, help, status } from '../style.ts';
import { loadSessionForChat } from './sessions-chat.ts';
import { sessionPromptDefaults } from './sessions-files.ts';

type CtxOpts = { projectArg?: string; hostArg?: string };

/** Readiness stages `/start` reports. Poll until `ready`. */
type StartStage = 'provisioning' | 'starting' | 'ready' | 'stopped' | 'failed';

interface StartResult {
  stage: StartStage;
  agent_name?: string;
  retriable?: boolean;
  opencode_session_id?: string | null;
  reason?: string;
}

const STOP_HELP = help`Usage: kortix sessions stop <session-id> [options]

Pause a session: the sandbox stops in place and the disk is kept, exactly as
an idle auto-stop leaves it. Resume with \`kortix sessions start\`. Use
\`sessions restart\` to re-provision instead, and \`sessions rm\` to delete.

Options:
  --project <id>   Operate on this project id (default: linked).
  --host <name>    Operate against a non-default Kortix host.
  --json           Machine-readable output.
  -h, --help       Show this help.

Needs project.session.stop, and the session owner or an account owner/admin.
`;

const RESTORE_HELP = help`Usage: kortix sessions restore <session-id> [options]

Restore a deleted session. A deleted session stays restorable for 30 days:
its messages, stored files and branch come back, and its next start boots a
fresh sandbox from the branch. After 30 days its messages, files and branch
are deleted. Public links stay revoked.

Pass the full session id: a deleted session is not in \`sessions ls\`, so a
short id cannot be expanded, and no other project is searched for it.
\`sessions ls --deleted\` lists the ones you can restore with their full id;
\`sessions rm\` prints the exact command, with --project (and --host).

Options:
  --project <id>   Operate on this project id (default: linked).
  --host <name>    Operate against a non-default Kortix host.
  --json           Machine-readable output.
  -h, --help       Show this help.

Needs project.session.stop, and the session owner or a project manager.
`;

const RECOVER_HELP = help`Usage: kortix sessions recover <session-id> [options]

Continue a lost session on a new computer. A session is lost when the provider
removed its sandbox: \`sessions start\` then fails with
runtime_identity_unavailable. Recover keeps the session and its
saved conversation. Its next start boots a new sandbox from the session branch
and restores the conversation, so the agent keeps the context.
Work that was not committed and pushed stays lost.

A session with no saved conversation cannot continue: recover refuses it and
changes nothing. Delete it with \`sessions rm\` instead.

Options:
  --project <id>   Operate on this project id (default: linked).
  --host <name>    Operate against a non-default Kortix host.
  --json           Machine-readable output.
  -h, --help       Show this help.

Needs project.session.start, and the session owner or a project manager.
`;

const START_HELP = help`Usage: kortix sessions start <session-id> [options]

Wake a session: provisions a missing sandbox, resumes a stopped one, and
resolves its session runtime. Idempotent — calling it on a running session
just reports \`ready\`. Without --wait it reports the stage it reached in one
call and exits 0.

Options:
  --wait           Block until the runtime is ready (up to ~5 min). Exit 1 if
                   the session ends up failed or stopped.
  --project <id>   Operate on this project id (default: linked).
  --host <name>    Operate against a non-default Kortix host.
  --json           Machine-readable output.
  -h, --help       Show this help.

Needs project.session.start.
`;

const WARM_HELP = help`Usage: kortix sessions warm [options]

Pre-create the session you are about to use, so the sandbox is already up when
the first prompt lands. Speculative by contract: it reuses an existing unused
warm session when there is one, and every failure is recoverable — fall back to
\`kortix sessions new\`. A warm session stays hidden from \`sessions ls\` until
its first prompt.

Options:
  --exclude <session-id>   Never hand back this session — pass the warm one you
                           just took, so a replenish creates a fresh box.
  --project <id>           Operate on this project id (default: linked).
  --host <name>            Operate against a non-default Kortix host.
  --json                   Machine-readable output.
  -h, --help               Show this help.

Needs project.session.start.
`;

const MODEL_HELP = help`Usage: kortix sessions model <session-id> <model-id> [options]

Change the model a session runs, mid-session. A live sandbox is re-pointed and
its runtime restarts, which ENDS the turn running right now; a stopped session
stores the value for its next start. The reply says which happened:

  applied_live true    the running box answers from the new model now
  applied_live false   stored; it takes effect at the next start
  push_failed  true    stored, but the live push FAILED — the running harness
                       still answers from the OLD model

Options:
  --project <id>   Operate on this project id (default: linked).
  --host <name>    Operate against a non-default Kortix host.
  --json           Machine-readable output.
  -h, --help       Show this help.

Needs the session owner or a project manager, and the model must be servable
for the account. Run \`kortix gateway models\` to see what is.
`;

const COMPACT_HELP = help`Usage: kortix sessions compact <session-id> [options]

Summarize the conversation so far and continue from the summary — what the
dashboard's "Compact" does. Use it when a long session starts losing the
thread or hits its context ceiling. The model is the session's own; the
runtime's configured default is the fallback. A session whose runtime cannot
compact on demand exits 1 and nothing changes. A stopped session is started first.

Options:
  --project <id>   Operate on this project id (default: linked).
  --host <name>    Operate against a non-default Kortix host.
  --json           Machine-readable output.
  -h, --help       Show this help.
`;

function parseCommon(argv: string[], helpText: string): {
  rest: string[];
  opts: CtxOpts;
  json: boolean;
} | number {
  const rest = [...argv];
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(helpText);
    return 0;
  }
  try {
    const projectArg = takeFlagValue(rest, ['--project']);
    const hostArg = takeFlagValue(rest, ['--host']);
    const json = takeFlagBool(rest, ['--json']);
    return { rest, opts: { projectArg, hostArg }, json };
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
}

export async function runSessionsStop(argv: string[]): Promise<number> {
  const parsed = parseCommon(argv, STOP_HELP);
  if (typeof parsed === 'number') return parsed;
  const { rest, opts, json } = parsed;

  const sessionId = rest.filter((a) => !a.startsWith('-'))[0];
  if (!sessionId) {
    process.stderr.write(`${status.err('Pass a session id.')}\n\n${STOP_HELP}`);
    return 2;
  }
  const located = await locateSessionAnywhere(
    sessionId,
    opts,
    (host) => `kortix sessions stop ${sessionId} --host ${host}`,
  );
  if (!located) return 1;
  const { client, projectId, session } = located.located;

  let result: { ok: boolean; session_id: string; status: string };
  try {
    result = await client.post(`/projects/${projectId}/sessions/${session.session_id}/stop`, {});
  } catch (err) {
    return surfaceApiError(err);
  }
  if (json) {
    emitJson(result);
    return 0;
  }
  process.stdout.write(
    `${status.ok(`Stopped ${C.bold}${short(session.session_id)}${C.reset}${C.dim} (${result.status}) — disk kept; \`kortix sessions start ${short(session.session_id)}\` resumes it${C.reset}`)}\n`,
  );
  return 0;
}

export async function runSessionsRestore(argv: string[]): Promise<number> {
  const parsed = parseCommon(argv, RESTORE_HELP);
  if (typeof parsed === 'number') return parsed;
  const { rest, opts, json } = parsed;

  const sessionId = rest.filter((a) => !a.startsWith('-'))[0];
  if (!sessionId) {
    process.stderr.write(`${status.err('Pass a session id.')}\n\n${RESTORE_HELP}`);
    return 2;
  }
  if (!SESSION_UUID_RE.test(sessionId)) {
    process.stderr.write(
      `${status.err('Pass the full session id: `kortix sessions ls --deleted` lists it, and `kortix sessions rm` printed it.')}\n`,
    );
    return 2;
  }
  // Not located through the session read: that read answers 404 for a deleted session.
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;

  try {
    await ctx.client.post(`/projects/${ctx.projectId}/sessions/${sessionId}/restore`, {});
  } catch (err) {
    return surfaceApiError(err);
  }
  if (json) {
    emitJson({ ok: true, session_id: sessionId });
    return 0;
  }
  process.stdout.write(
    `${status.ok(`Restored ${C.bold}${short(sessionId)}${C.reset}${C.dim}. Its next start boots a fresh sandbox from its branch: \`kortix sessions start ${short(sessionId)}\`${C.reset}`)}\n`,
  );
  return 0;
}

export async function runSessionsRecover(argv: string[]): Promise<number> {
  const parsed = parseCommon(argv, RECOVER_HELP);
  if (typeof parsed === 'number') return parsed;
  const { rest, opts, json } = parsed;

  const sessionId = rest.filter((a) => !a.startsWith('-'))[0];
  if (!sessionId) {
    process.stderr.write(`${status.err('Pass a session id.')}\n\n${RECOVER_HELP}`);
    return 2;
  }
  const located = await locateSessionAnywhere(
    sessionId,
    opts,
    (host) => `kortix sessions recover ${sessionId} --host ${host}`,
  );
  if (!located) return 1;
  const { client, projectId, session } = located.located;

  try {
    await client.post(`/projects/${projectId}/sessions/${session.session_id}/recover`, {});
  } catch (err) {
    return surfaceApiError(err);
  }
  if (json) {
    emitJson({ ok: true, session_id: session.session_id });
    return 0;
  }
  process.stdout.write(
    `${status.ok(`${C.bold}${short(session.session_id)}${C.reset} continues on a new computer${C.dim}. Its next start restores the saved conversation: \`kortix sessions start ${short(session.session_id)} --wait\`${C.reset}`)}\n`,
  );
  return 0;
}

export async function runSessionsStart(argv: string[]): Promise<number> {
  const rest = [...argv];
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(START_HELP);
    return 0;
  }
  let opts: CtxOpts;
  let json = false;
  let wait = false;
  try {
    opts = { projectArg: takeFlagValue(rest, ['--project']), hostArg: takeFlagValue(rest, ['--host']) };
    json = takeFlagBool(rest, ['--json']);
    wait = takeFlagBool(rest, ['--wait']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }

  const sessionId = rest.filter((a) => !a.startsWith('-'))[0];
  if (!sessionId) {
    process.stderr.write(`${status.err('Pass a session id.')}\n\n${START_HELP}`);
    return 2;
  }
  const located = await locateSessionAnywhere(
    sessionId,
    opts,
    (host) => `kortix sessions start ${sessionId} --host ${host}`,
  );
  if (!located) return 1;
  const { client, projectId, session } = located.located;
  const path = `/projects/${projectId}/sessions/${session.session_id}/start`;

  // Same idempotent readiness call the dashboard polls, and the same budget
  // `sessions new --wait` uses: 75 attempts, 4s apart (~5 min).
  let result: StartResult;
  try {
    result = await client.post<StartResult>(path, {});
    if (wait) {
      for (let i = 1; i < 75 && result.stage !== 'ready'; i += 1) {
        if (result.stage === 'failed' || result.stage === 'stopped') break;
        if (!json) {
          process.stderr.write(`${C.dim}  ${result.stage}…${C.reset}\r`);
        }
        await new Promise((r) => setTimeout(r, 4000));
        result = await client.post<StartResult>(path, {});
      }
    }
  } catch (err) {
    return surfaceApiError(err);
  }

  if (json) {
    emitJson(result);
    return result.stage === 'failed' || (wait && result.stage !== 'ready') ? 1 : 0;
  }
  if (result.stage === 'ready') {
    process.stdout.write(`${status.ok(`${C.bold}${short(session.session_id)}${C.reset} is ready`)}\n`);
    return 0;
  }
  if (result.stage === 'failed' || result.stage === 'stopped') {
    process.stderr.write(
      `${status.err(`Session ${result.stage}${result.reason ? `: ${result.reason}` : ''}.`)}\n`,
    );
    // The provider removed the box. `recover` continues it on a new one.
    if (result.reason === 'runtime_identity_unavailable') {
      process.stderr.write(
        `${C.dim}  Its computer was lost. Continue it on a new computer with its saved conversation: \`kortix sessions recover ${short(session.session_id)}\`${C.reset}\n`,
      );
    }
    return 1;
  }
  if (wait) {
    process.stderr.write(
      `${status.err(`Timed out waiting for readiness after ~5 min (stage: ${result.stage}).`)}\n`,
    );
    return 1;
  }
  process.stdout.write(
    `${status.info(`${short(session.session_id)} is ${result.stage} — re-run with --wait to block until it is ready.`)}\n`,
  );
  return 0;
}

export async function runSessionsWarm(argv: string[]): Promise<number> {
  const rest = [...argv];
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(WARM_HELP);
    return 0;
  }
  let opts: CtxOpts;
  let exclude: string | undefined;
  let json = false;
  try {
    opts = { projectArg: takeFlagValue(rest, ['--project']), hostArg: takeFlagValue(rest, ['--host']) };
    exclude = takeFlagValue(rest, ['--exclude']);
    json = takeFlagBool(rest, ['--json']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }

  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;

  let result: { session: ProjectSession; reused: boolean; workspace_refresh?: { status: string } };
  try {
    result = await ctx.client.post(
      `/projects/${ctx.projectId}/sessions/warm`,
      exclude ? { exclude_session_id: exclude } : {},
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  if (json) {
    emitJson(result);
    return 0;
  }
  process.stdout.write(
    `\n${status.ok(`${result.reused ? 'Reusing' : 'Warmed'} ${C.bold}${short(result.session.session_id)}${C.reset}`)}\n`,
  );
  process.stdout.write(`  ${C.dim}session_id ${C.reset}${result.session.session_id}\n`);
  process.stdout.write(`  ${C.dim}status     ${C.reset}${result.session.status}\n`);
  if (result.workspace_refresh) {
    process.stdout.write(`  ${C.dim}workspace  ${C.reset}${result.workspace_refresh.status}\n`);
  }
  process.stdout.write('\n');
  return 0;
}

export async function runSessionsModel(argv: string[]): Promise<number> {
  const parsed = parseCommon(argv, MODEL_HELP);
  if (typeof parsed === 'number') return parsed;
  const { rest, opts, json } = parsed;

  const positional = rest.filter((a) => !a.startsWith('-'));
  const [sessionId, model] = positional;
  if (!sessionId) {
    process.stderr.write(`${status.err('Pass a session id.')}\n\n${MODEL_HELP}`);
    return 2;
  }
  if (!model) {
    process.stderr.write(`${status.err('Pass a model id (e.g. `kortix/deepseek-v4.1-flash`).')}\n`);
    return 2;
  }

  const located = await locateSessionAnywhere(
    sessionId,
    opts,
    (host) => `kortix sessions model ${sessionId} ${model} --host ${host}`,
  );
  if (!located) return 1;
  const { client, projectId, session } = located.located;

  let result: {
    /** `model` since W4; an older API answers only `opencode_model`. */
    model?: string;
    opencode_model: string;
    applied_live: boolean;
    push_failed?: true;
    detail?: string;
  };
  try {
    result = await client.put(`/projects/${projectId}/sessions/${session.session_id}/model`, {
      model,
      opencode_model: model,
    });
  } catch (err) {
    return surfaceApiError(err);
  }

  if (json) {
    emitJson(result);
    return result.push_failed ? 1 : 0;
  }
  // `push_failed`, never `!applied_live`, is the failure signal: a cold session
  // legitimately reports applied_live:false and the stored value IS the
  // mechanism there.
  if (result.push_failed) {
    process.stderr.write(
      `${status.err(`Stored ${result.model ?? result.opencode_model}, but the live push FAILED — the running agent still answers from the old model${result.detail ? `: ${result.detail}` : ''}.`)}\n`,
    );
    return 1;
  }
  process.stdout.write(
    `${status.ok(
      result.applied_live
        ? `Now running ${C.bold}${result.model ?? result.opencode_model}${C.reset}${C.dim} — the runtime restarted, so any turn in flight ended${C.reset}`
        : `Stored ${C.bold}${result.model ?? result.opencode_model}${C.reset}${C.dim} — it applies when this session next starts${C.reset}`,
    )}\n`,
  );
  return 0;
}

export async function runSessionsCompact(argv: string[]): Promise<number> {
  const parsed = parseCommon(argv, COMPACT_HELP);
  if (typeof parsed === 'number') return parsed;
  const { rest, opts, json } = parsed;

  const sessionId = rest.filter((a) => !a.startsWith('-'))[0];
  if (!sessionId) {
    process.stderr.write(`${status.err('Pass a session id.')}\n\n${COMPACT_HELP}`);
    return 2;
  }
  const resolved = await loadSessionForChat(sessionId, opts, 'sessions compact', {
    onNotRunning: 'start',
    onStarting: (session) => {
      process.stderr.write(`Waking ${session.session_id}…\n`);
    },
  });
  if (!resolved) return 1;
  if (!runtimeSupports(await readRuntimeCapabilities(resolved), 'session.compact')) {
    process.stderr.write(
      `${status.err("This session's runtime does not support compacting the conversation.")}\n`,
    );
    return 1;
  }

  // The session's OWN persisted model is the right one to summarize with —
  // same split the prompt path uses. Without one, the runtime's configured
  // default applies; with neither, `compact` refuses instead of guessing.
  let model: { providerID: string; modelID: string };
  process.stderr.write('Checking session and compacting conversation…\n');
  try {
    model = await withKortixScope(resolved.auth, () =>
      resolved.handle.compact(sessionPromptDefaults(resolved.session).model),
    );
  } catch (err) {
    if (err instanceof ApiError && err.code === 'MODEL_REQUIRED') {
      process.stderr.write(
        `${status.err('No model configured for this session — set one with `kortix sessions model <id> <model>` first.')}\n`,
      );
      return 1;
    }
    return surfaceApiError(err);
  }

  if (json) {
    emitJson({
      session_id: resolved.session.session_id,
      runtime_session_id: resolved.runtimeSessionId,
      opencode_session_id: resolved.runtimeSessionId,
      model: `${model.providerID}/${model.modelID}`,
      compacted: true,
    });
    return 0;
  }
  process.stdout.write(
    `${status.ok(`Compacting ${C.bold}${short(resolved.session.session_id)}${C.reset}${C.dim} with ${model.providerID}/${model.modelID} — the summary replaces the history for the next turn${C.reset}`)}\n`,
  );
  return 0;
}

function short(id: string): string {
  return id.split('-')[0] ?? id;
}
