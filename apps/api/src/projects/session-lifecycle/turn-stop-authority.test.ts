/**
 * Who may stop a running turn: its prompter, the session owner or a project
 * manager. The rule is `decideTurnStop`; the reads feeding it run here against
 * a database stub that answers by table. The real SQL runs in the DB suites.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { sessionLifecycleCommands, sessionSandboxes } from '@kortix/db';

const SESSION = 'sess-1';
const PROMPTER = 'user-prompter';
const OTHER = 'user-other';

let boxRows: Array<Record<string, unknown>> = [];
let promptRows: Array<Record<string, unknown>> = [];
/** Every table the code read, in order. */
let reads: string[] = [];

mock.module('../../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const name = table === sessionSandboxes ? 'sandboxes' : table === sessionLifecycleCommands ? 'commands' : 'other';
          const limit = async (n: number) => {
            reads.push(name);
            return (name === 'sandboxes' ? boxRows : name === 'commands' ? promptRows : []).slice(0, n);
          };
          return { limit, orderBy: () => ({ limit }) };
        },
      }),
    }),
  },
}));

const { canStopTurns, decideTurnStop, mayStopRunningTurn, readRunningTurn, turnPrompterOf } = await import(
  './turn-stop-authority'
);

const activeTurn = (messageId: string, startedAtMs: number) => ({
  token: `t-${messageId}`,
  state: 'active',
  opencodeSessionId: 'ses_root',
  messageId,
  startedAtMs,
});
const runningBox = (...turns: ReturnType<typeof activeTurn>[]) => ({
  status: 'active',
  metadata: { activeTurns: Object.fromEntries(turns.map((turn) => [turn.token, turn])) },
});
/** The inbox row a person sent, as `POST .../prompts` stores it. */
const personPrompt = (actorUserId: string, payload: Record<string, unknown> = {}) => ({
  actorUserId,
  payload: { bindTurnIdentity: true, ...payload },
});

beforeEach(() => {
  boxRows = [];
  promptRows = [];
  reads = [];
});

describe('decideTurnStop', () => {
  // [canManageLifecycle, callerUserId, running, prompterUserId] → allowed
  const table: Array<[boolean, string | null, boolean, string | null, boolean]> = [
    [false, PROMPTER, false, OTHER, true], // nothing runs: a hold only pauses the queue
    [true, OTHER, true, PROMPTER, true], // owner or manager
    [true, null, true, PROMPTER, true], // an agent with owner standing on its session
    [false, PROMPTER, true, PROMPTER, true], // the turn's own prompter
    [false, OTHER, true, PROMPTER, false], // another member
    [false, OTHER, true, null, false], // a trigger's or an agent's turn: owner or manager only
    [false, null, true, null, false], // an agent credential is never a prompter, even of a prompterless turn
    [false, null, true, PROMPTER, false],
  ];
  for (const [canManageLifecycle, callerUserId, running, prompterUserId, allowed] of table) {
    test(`manage=${canManageLifecycle} caller=${callerUserId} running=${running} prompter=${prompterUserId} → ${allowed}`, () => {
      const verdict = decideTurnStop({ canManageLifecycle, callerUserId, running, prompterUserId });
      expect(verdict).toEqual(allowed ? { allowed: true } : { allowed: false, prompterUserId });
    });
  }
});

describe('turnPrompterOf', () => {
  test("names the person whose inbox row started the turn", async () => {
    promptRows = [personPrompt(PROMPTER)];
    expect(await turnPrompterOf(SESSION, 'msg_1')).toBe(PROMPTER);
  });

  test("an agent session's prompt, or a row that does not bind a person, names nobody", async () => {
    promptRows = [personPrompt(PROMPTER, { authorSessionId: 'sess-agent' })];
    expect(await turnPrompterOf(SESSION, 'msg_1')).toBeNull();
    promptRows = [{ actorUserId: PROMPTER, payload: {} }];
    expect(await turnPrompterOf(SESSION, 'msg_1')).toBeNull();
    promptRows = [];
    expect(await turnPrompterOf(SESSION, 'msg_1')).toBeNull();
  });

  test('a turn with no message id names nobody and reads nothing', async () => {
    expect(await turnPrompterOf(SESSION, null)).toBeNull();
    expect(reads).toEqual([]);
  });
});

describe('readRunningTurn', () => {
  test('the newest active turn of a running box', async () => {
    boxRows = [runningBox(activeTurn('msg_old', 1), activeTurn('msg_new', 2))];
    expect(await readRunningTurn(SESSION)).toEqual({ messageId: 'msg_new' });
  });

  test('a stopped box holds no turn whatever its metadata still says', async () => {
    boxRows = [{ ...runningBox(activeTurn('msg_1', 1)), status: 'stopped' }];
    expect(await readRunningTurn(SESSION)).toBeNull();
    boxRows = [];
    expect(await readRunningTurn(SESSION)).toBeNull();
  });
});

describe('mayStopRunningTurn', () => {
  test('an owner or manager is allowed without a read', async () => {
    boxRows = [runningBox(activeTurn('msg_1', 1))];
    expect(await mayStopRunningTurn({ sessionId: SESSION, callerUserId: OTHER, canManageLifecycle: true })).toEqual({
      allowed: true,
    });
    expect(reads).toEqual([]);
  });

  test('with nothing running anyone is allowed, and the prompter is never read', async () => {
    expect(await mayStopRunningTurn({ sessionId: SESSION, callerUserId: OTHER, canManageLifecycle: false })).toEqual({
      allowed: true,
    });
    expect(reads).toEqual(['sandboxes']);
  });

  test("the prompter stops their own turn; another member is refused and told whose it is", async () => {
    boxRows = [runningBox(activeTurn('msg_1', 1))];
    promptRows = [personPrompt(PROMPTER)];
    const input = { sessionId: SESSION, canManageLifecycle: false };
    expect(await mayStopRunningTurn({ ...input, callerUserId: PROMPTER })).toEqual({ allowed: true });
    expect(await mayStopRunningTurn({ ...input, callerUserId: OTHER })).toEqual({
      allowed: false,
      prompterUserId: PROMPTER,
    });
    // An agent credential launched by the prompter is not the prompter.
    expect(await mayStopRunningTurn({ ...input, callerUserId: null })).toEqual({
      allowed: false,
      prompterUserId: PROMPTER,
    });
  });

  test('a turn the caller already read is not read again', async () => {
    promptRows = [personPrompt(PROMPTER)];
    const verdict = await mayStopRunningTurn({
      sessionId: SESSION,
      callerUserId: OTHER,
      canManageLifecycle: false,
      running: { messageId: 'msg_1' },
    });
    expect(verdict).toEqual({ allowed: false, prompterUserId: PROMPTER });
    expect(reads).toEqual(['commands']);
  });
});

describe('canStopTurns', () => {
  test("answers from the newest turn of the read the caller holds, and true when it is empty", async () => {
    promptRows = [personPrompt(PROMPTER)];
    const caller = { sessionId: SESSION, callerUserId: OTHER, canManageLifecycle: false };
    expect(await canStopTurns({ turns: [{ message_id: 'msg_new' }, { message_id: 'msg_old' }] }, caller)).toBe(false);
    expect(await canStopTurns({ turns: [{ message_id: 'msg_new' }] }, { ...caller, callerUserId: PROMPTER })).toBe(true);
    expect(await canStopTurns({ turns: [] }, caller)).toBe(true);
    expect(reads).toEqual(['commands', 'commands']);
  });
});
