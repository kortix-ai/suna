/**
 * Session lifecycle verbs the dashboard has and the CLI did not: pause a
 * session, wake one back up, change its model mid-flight,
 * compact its conversation, restore a deleted one, and continue a lost one.
 *
 * `restart` (re-provision) already lives in sessions.ts and is a different
 * thing: `stop`/`start` are the same pause/resume pair the session header's
 * Stop button and the session page's open call drive, disk kept.
 */

import { sessionModelTarget } from './session-model-input';
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
import {
  type SessionStartPayload,
  describeStartProgress,
  startPollIntervalMs,
  startProgressTracker,
} from '../session-boot.ts';
import { readRuntimeCapabilities } from '../session-runtime.ts';
import { C, help, status } from '../style.ts';
import { loadSessionForChat } from './sessions-chat.ts';
import { sessionPromptDefaults } from './sessions-files.ts';

type CtxOpts = { projectArg?: string; hostArg?: string };

/** The `/start` readiness payload. Poll until `stage` is `ready`. */
type StartResult = SessionStartPayload;

const STOP_HELP = help`Usage: kortix sessions stop <session-id> [options]

Pause a session: the sandbox stops in place and the disk is kept, exactly as
an idle auto-stop leaves it. Resume with \`kortix sessions start\`. Use
\`sessions restart\` to re-provision instead, and \`sessions rm\` to delete.

Options:
  --workspace <id>  Operate on this workspace id (default: linked).
  --host <name>     Operate against a non-default Kortix host.
  --json            Machine-readable output.
  -h, --help        Show this help.

Needs project.session.stop, and the session owner or an account owner/admin.
`;

const RESTORE_HELP = help`Usage: kortix sessions restore <session-id> [options]

Restore a deleted session. A deleted session stays restorable for 30 days:
its messages, stored files and branch come back, and its next start boots a
fresh sandbox from the branch. After 30 days its messages, files and branch
are deleted. Public links stay revoked.

Pass the full session id: a deleted session is not in \`sessions ls\`, so a
short id cannot be expanded, and no other workspace is searched for it.
\`sessions ls --deleted\` lists the ones you can restore with their full id;
\`sessions rm\` prints the exact command, with --workspace (and --host).

Options:
  --workspace <id>  Operate on this workspace id (default: linked).
  --host <name>     Operate against a non-default Kortix host.
  --json            Machine-readable output.
  -h, --help        Show this help.

Needs project.session.stop, and the session owner or a workspace manager.
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
  --workspace <id>  Operate on this workspace id (default: linked).
  --host <name>     Operate against a non-default Kortix host.
  --json            Machine-readable output.
  -h, --help        Show this help.

Needs project.session.start, and the session owner or a workspace manager.
`;

const START_HELP = help`Usage: kortix sessions start <session-id> [options]

Wake a session: provisions a missing sandbox, resumes a stopped one, and
resolves its session runtime. Idempotent — calling it on a running session
just reports \`ready\`. Without --wait it reports the stage it reached in one
call and exits 0.

Options:
  --wait            Block until the runtime is ready (up to ~5 min). Exit 1 if
                    the session ends up failed or stopped. Each step prints
                    one stderr line, e.g. \`provisioning · building the first
                    image for this workspace (0:42)\`. --json prints the last
                    /start payload, its boot.image step included.
  --workspace <id>  Operate on this workspace id (default: linked).
  --host <name>     Operate against a non-default Kortix host.
  --json            Machine-readable output.
  -h, --help        Show this help.

Needs project.session.start.
`;

const MODEL_HELP = help`Usage: kortix sessions model <session-id> <model-id> [options]

Change the model a session runs, mid-session. A live sandbox is re-pointed and
pi reconfigures without restarting. The running turn finishes on its model;
the next turn uses the saved model. The reply says which happened:

  applied_live true    the running box answers from the new model now
  applied_live false   stored; it takes effect at the next start
  push_failed  true    stored, but the live push FAILED — the running harness
                       still answers from the OLD model

New verbs: get [session-id], set [session-id] <model>, switch [session-id] <model>.
The new verbs default to KORTIX_SESSION_ID.

Options:
  --prompt <text>   Queue a continuation after the running turn.
  --idempotency-key <key>  Required with --prompt; reuse for retries.
  --workspace <id>  Operate on this workspace id (default: linked).
  --host <name>     Operate against a non-default Kortix host.
  --json            Machine-readable output.
  -h, --help        Show this help.

Needs the session owner or a workspace manager, and the model must be servable
for the account. Run \`kortix gateway models\` to see what is.
`;

const COMPACT_HELP = help`Usage: kortix sessions compact <session-id> [options]

Start a fresh context now — what the dashboard's "Start a fresh context" does.
The agent continues with an empty context and searches the session's full
record when it needs a detail; nothing is summarized. An agent whose kortix.yaml
sets \`context: summary\` instead summarizes the conversation and continues from
the summary, with the session's own model (the runtime's default as fallback).
A full context does the same by itself. A session whose runtime cannot do this
on demand exits 1 and nothing changes. A stopped session is started first.

Options:
  --workspace <id>  Operate on this workspace id (default: linked).
  --host <name>     Operate against a non-default Kortix host.
  --json            Machine-readable output.
  -h, --help        Show this help.
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
    const projectArg = takeFlagValue(rest, ['--project', '--workspace']);
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
    result = await client.post(`/workspaces/${projectId}/sessions/${session.session_id}/stop`, {});
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
    await ctx.client.post(`/workspaces/${ctx.projectId}/sessions/${sessionId}/restore`, {});
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
    await client.post(`/workspaces/${projectId}/sessions/${session.session_id}/recover`, {});
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
    opts = { projectArg: takeFlagValue(rest, ['--project', '--workspace']), hostArg: takeFlagValue(rest, ['--host']) };
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
  const path = `/workspaces/${projectId}/sessions/${session.session_id}/start`;

  // Same idempotent readiness call the dashboard polls, and the same budget
  // `sessions new --wait` uses: 75 attempts, 4s apart (~5 min). One stderr
  // line per change of stage or image step; --json prints only the payload.
  const progress = startProgressTracker();
  const intervalMs = startPollIntervalMs();
  let result: StartResult;
  try {
    result = await client.post<StartResult>(path, {});
    if (wait) {
      for (let i = 1; i < 75 && result.stage !== 'ready'; i += 1) {
        if (result.stage === 'failed' || result.stage === 'stopped') break;
        const line = json ? null : progress(result);
        if (line) process.stderr.write(`Session ${short(session.session_id)}: ${line}\n`);
        await new Promise((r) => setTimeout(r, intervalMs));
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
      `${status.err(`Timed out waiting for readiness after ~5 min (stage: ${describeStartProgress(result)}).`)}\n`,
    );
    return 1;
  }
  process.stdout.write(
    `${status.info(`${short(session.session_id)} is ${describeStartProgress(result)} — re-run with --wait to block until it is ready.`)}\n`,
  );
  return 0;
}

export async function runSessionsModel(argv: string[]): Promise<number> {
  const parsed = parseCommon(argv, MODEL_HELP);
  if (typeof parsed === 'number') return parsed;
  const { rest, opts, json } = parsed;

  const explicitSession = takeFlagValue(rest, ['--session']);
  const prompt = takeFlagValue(rest, ['--prompt']);
  const retryKey = takeFlagValue(rest, ['--idempotency-key']);
  const positional = rest.filter((a) => !a.startsWith('-'));
  const { action, sessionId, model } = sessionModelTarget(positional, explicitSession ?? process.env.KORTIX_SESSION_ID);
  if (!sessionId || (action !== 'get' && !model)) {
    process.stderr.write(`${status.err('Pass a model id and session id, or use get/set/switch inside a session.')}\n`);
    return 2;
  }
  if ((action === 'switch' || prompt !== undefined || retryKey !== undefined) && (!prompt || !retryKey)) {
    process.stderr.write(`${status.err('A switch requires --prompt and --idempotency-key.')}\n`);
    return 2;
  }

  const located = await locateSessionAnywhere(
    sessionId,
    opts,
    (host) => `kortix sessions model ${sessionId} ${model} --host ${host}`,
  );
  if (!located) return 1;
  const { client, projectId, session } = located.located;

  if (action === 'get') {
    const metadata = session.metadata ?? {};
    const model = typeof metadata.model === 'string' ? metadata.model : null;
    if (json) emitJson({ model });
    else process.stdout.write(`${model ?? 'default'}\n`);
    return 0;
  }

  let result: {
    model?: string;
    applied_live: boolean;
    push_failed?: true;
    detail?: string;
  };
  try {
    result = await client.put(`/workspaces/${projectId}/sessions/${session.session_id}/model`, {
      model,
      ...(prompt && retryKey ? { prompt, idempotency_key: retryKey } : {}),
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
      `${status.err(`Stored ${result.model}, but the live push FAILED — the running agent still answers from the old model${result.detail ? `: ${result.detail}` : ''}.`)}\n`,
    );
    return 1;
  }
  process.stdout.write(
    `${status.ok(
      result.applied_live
        ? `Now running ${C.bold}${result.model}${C.reset}${C.dim} — applies to the next turn without restarting${C.reset}`
        : `Stored ${C.bold}${result.model}${C.reset}${C.dim} — it applies when this session next starts${C.reset}`,
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
  const capabilities = await readRuntimeCapabilities(resolved);
  // A runtime with the context record resets onto it: no summary is written.
  const record = (capabilities ?? []).includes('session.context_record');
  if (!runtimeSupports(capabilities, 'session.compact')) {
    process.stderr.write(
      `${status.err("This session's runtime does not support compacting the conversation.")}\n`,
    );
    return 1;
  }

  // The session's OWN persisted model is the right one to summarize with —
  // same split the prompt path uses. Without one, the runtime's configured
  // default applies; with neither, `compact` refuses instead of guessing.
  let model: { providerID: string; modelID: string };
  process.stderr.write(record ? 'Checking session and starting a fresh context…\n' : 'Checking session and compacting conversation…\n');
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
      model: `${model.providerID}/${model.modelID}`,
      compacted: true,
      mode: record ? 'record' : 'summary',
    });
    return 0;
  }
  if (record) {
    process.stdout.write(
      `${status.ok(`Started a fresh context for ${C.bold}${short(resolved.session.session_id)}${C.reset}${C.dim} — nothing was summarized; the agent searches the full record when it needs a detail${C.reset}`)}\n`,
    );
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
