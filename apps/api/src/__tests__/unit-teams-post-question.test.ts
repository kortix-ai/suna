import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const SESSION_ID = 'sess-asking';

let turn: Record<string, unknown> | null = null;
const finalized: Array<Record<string, unknown>> = [];
const deleted: string[] = [];
mock.module('../channels/teams/turn', () => ({
  loadTurn: async () => turn,
  finalizeTurn: async (_h: unknown, opts: Record<string, unknown>) => {
    finalized.push(opts);
  },
  deleteTurn: async (id: string) => {
    deleted.push(id);
  },
}));

let cardPosted: Record<string, unknown> | null = null;
let cardOk = true;
const texts: string[] = [];
mock.module('../channels/teams-api', () => ({
  sendCard: async (_ref: unknown, card: Record<string, unknown>) => {
    cardPosted = card;
    return cardOk ? 'activity-1' : null;
  },
  sendText: async (_ref: unknown, text: string) => {
    texts.push(text);
    return 'activity-2';
  },
}));

const load = async () => await import('../channels/teams/questions');

beforeEach(() => {
  turn = {
    sessionId: SESSION_ID,
    serviceUrl: 'https://smba.trafficmanager.net/emea/',
    conversationId: '19:abc@thread.tacv2',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    steps: [],
    finalized: false,
  };
  finalized.length = 0;
  deleted.length = 0;
  texts.length = 0;
  cardPosted = null;
  cardOk = true;
});

afterEach(() => {
  mock.restore();
});

describe('postTeamsQuestion', () => {
  test('the live card does NOT close as "Task complete" — the agent asked, it did not finish', () => {
    // The default finalize title told the user the work was done, one line
    // above a card asking them a question.
    return load().then(async ({ postTeamsQuestion }) => {
      await postTeamsQuestion(SESSION_ID, [
        { question: 'Deploy to prod?', options: [{ label: 'Yes' }, { label: 'No' }] },
      ] as never);

      expect(finalized).toHaveLength(1);
      expect(finalized[0].title).toBe('Waiting for your answer');
      // The step in flight neither finished nor failed.
      expect(finalized[0].unfinished).toBe(true);
      expect(deleted).toEqual([SESSION_ID]);
    });
  });

  test('the question reaches the conversation as a card', async () => {
    const { postTeamsQuestion } = await load();

    const res = await postTeamsQuestion(SESSION_ID, [
      { question: 'Deploy to prod?', options: [{ label: 'Yes' }, { label: 'No' }] },
    ] as never);

    expect(res.ok).toBe(true);
    expect(JSON.stringify(cardPosted)).toContain('Deploy to prod?');
    expect(texts).toEqual([]);
  });

  test('a card the service rejects falls back to plain text, options and all', async () => {
    cardOk = false;
    const { postTeamsQuestion } = await load();

    const res = await postTeamsQuestion(SESSION_ID, [
      { question: 'Which environment?', options: [{ label: 'dev' }, { label: 'prod' }] },
    ] as never);

    expect(res.ok).toBe(true);
    expect(texts[0]).toContain('Which environment?');
    expect(texts[0]).toContain('• dev');
    expect(texts[0]).toContain('• prod');
  });

  test('the agent is told to finish its turn rather than block on an answer', async () => {
    // Teams questions are async: the reply arrives as a NEW turn. An agent that
    // waits here holds a sandbox open for nothing.
    const { postTeamsQuestion } = await load();

    const res = await postTeamsQuestion(SESSION_ID, [{ question: 'Ready?', options: [] }] as never);

    expect(res.answers).toHaveLength(1);
    expect(res.answers?.[0][0]).toContain('finish this turn now');
  });

  test('no live turn is an error, not a silent drop', async () => {
    turn = null;
    const { postTeamsQuestion } = await load();

    const res = await postTeamsQuestion(SESSION_ID, [{ question: 'Ready?', options: [] }] as never);

    expect(res.ok).toBe(false);
    expect(res.error).toContain('No active Teams turn');
    expect(finalized).toEqual([]);
  });
});
