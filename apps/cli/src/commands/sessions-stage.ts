import {
  SESSION_STAGES,
  type SessionStage,
  type SessionStageState,
  setProjectSessionStage,
} from '@kortix/sdk';
import { withKortixScope } from '../api/sdk.ts';
import {
  emitJson,
  locateSessionAnywhere,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { C, help, status } from '../style.ts';

const HELP = help`Usage: kortix sessions stage [<session-id>] [<stage>] [options]

Move a session's card on the Monitoring board, or print where it is.
Inside a sandbox <session-id> defaults to $KORTIX_SESSION_ID (your own
session). Without <stage> the current stage is printed.

Stages, in board order:
  backlog  planning  ready  in_progress  review  done
  (aliases: todo, plan, in-progress/inprogress/progress)

Options:
  --needs-approval   Park the card in "ready" until a human approves it.
                     End your turn after this; the approval arrives as a
                     new prompt.
  --note "<text>"    Short note shown on the card (max 500 chars).
  --json             Print the stage object as JSON.
  --project <id>     Operate on this project id (default: linked/default).
  --host <name>      Operate against a non-default Kortix host.
  -h, --help         Show this help.
`;

const STAGE_ALIASES: Record<string, SessionStage> = {
  todo: 'backlog',
  plan: 'planning',
  'in-progress': 'in_progress',
  inprogress: 'in_progress',
  progress: 'in_progress',
};

export function normalizeStage(raw: string): SessionStage | null {
  const key = raw.trim().toLowerCase();
  if ((SESSION_STAGES as readonly string[]).includes(key)) return key as SessionStage;
  return STAGE_ALIASES[key] ?? null;
}

export interface StageCommand {
  sessionId: string;
  stage: SessionStage | null;
  needsApproval: boolean;
  note: string | undefined;
  json: boolean;
  project?: string;
  host?: string;
}

/**
 * Pure parse: `[<session-id>] [<stage>]`. One positional is a stage when it
 * names one, else a session id. Falls back to `env.KORTIX_SESSION_ID`.
 */
export function parseStageCommand(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): StageCommand | 'help' {
  const rest = [...argv];
  if (takeFlagBool(rest, ['-h', '--help'])) return 'help';
  const project = takeFlagValue(rest, ['--project']);
  const host = takeFlagValue(rest, ['--host']);
  const json = takeFlagBool(rest, ['--json']);
  const needsApproval = takeFlagBool(rest, ['--needs-approval']);
  const note = takeFlagValue(rest, ['--note']);
  const unknown = rest.find((a) => a.startsWith('-'));
  if (unknown) throw new Error(`Unknown option "${unknown}".`);
  if (rest.length > 2) throw new Error(`Unexpected argument "${rest[2]}".`);

  let sessionId: string | undefined;
  let stage: SessionStage | null = null;
  if (rest.length === 2) {
    sessionId = rest[0];
    stage = normalizeStage(rest[1]);
    if (!stage) throw new Error(`Unknown stage "${rest[1]}". One of: ${SESSION_STAGES.join(', ')}.`);
  } else if (rest.length === 1) {
    stage = normalizeStage(rest[0]);
    // One positional that is not a stage is a session id — unless it cannot be
    // one: a session id is a uuid or a hex prefix of one, so `stage wizard`
    // with KORTIX_SESSION_ID set is a typo'd stage, not a lookup.
    if (!stage) {
      if (env.KORTIX_SESSION_ID && !/^[0-9a-f-]{4,}$/i.test(rest[0])) {
        throw new Error(`Unknown stage "${rest[0]}". One of: ${SESSION_STAGES.join(', ')}.`);
      }
      sessionId = rest[0];
    }
  }
  sessionId ??= env.KORTIX_SESSION_ID;
  if (!sessionId) {
    throw new Error('Pass a session id (or run inside a sandbox, where KORTIX_SESSION_ID is set).');
  }
  if (needsApproval && stage !== 'ready') {
    throw new Error('--needs-approval only applies to the "ready" stage.');
  }
  if (note !== undefined && note.length > 500) throw new Error('--note is limited to 500 characters.');
  return { sessionId, stage, needsApproval, note, json, project, host };
}

function printStage(sessionId: string, stage: SessionStageState | null, moved: boolean): void {
  if (!stage) {
    process.stdout.write(`${status.info(`${C.bold}${sessionId}${C.reset} has no stage yet (shown in backlog).`)}\n`);
    return;
  }
  const flags = stage.needs_approval ? `${C.dim} · awaiting approval${C.reset}` : '';
  const line = `${C.bold}${sessionId}${C.reset} → ${C.bold}${stage.value}${C.reset}${flags}`;
  process.stdout.write(`${moved ? status.ok(line) : status.info(line)}\n`);
  if (stage.note) process.stdout.write(`  ${C.dim}${stage.note}${C.reset}\n`);
}

export async function runSessionsStage(argv: string[]): Promise<number> {
  let command: StageCommand | 'help';
  try {
    command = parseStageCommand(argv);
  } catch (error) {
    process.stderr.write(`${status.err((error as Error).message)}\n\n${HELP}`);
    return 1;
  }
  if (command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }

  const located = await locateSessionAnywhere(
    command.sessionId,
    { projectArg: command.project, hostArg: command.host },
    (host) => `kortix sessions stage ${command.sessionId} ${command.stage ?? ''} --host ${host}`.trim(),
  );
  if (!located) return 1;
  const { auth, projectId, session } = located.located;

  // The CLI's own session row type predates `stage`; both shapes carry it.
  let row: { session_id: string; stage?: SessionStageState | null } = session;
  if (command.stage) {
    const stage = command.stage;
    try {
      row = await withKortixScope(auth, () =>
        setProjectSessionStage(projectId, session.session_id, {
          stage,
          ...(command.needsApproval ? { needs_approval: true } : {}),
          ...(command.note !== undefined ? { note: command.note } : {}),
        }),
      );
    } catch (err) {
      return surfaceApiError(err);
    }
  }
  if (command.json) emitJson(row.stage ?? null);
  else printStage(row.session_id, row.stage ?? null, Boolean(command.stage));
  return 0;
}
