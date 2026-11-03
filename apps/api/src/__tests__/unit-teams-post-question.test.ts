import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const ordered: string[] = [];
let failStage: string | null = null;
let sentRef: unknown;

const SESSION_ID = 'sess-asking';

let turn: Record<string, unknown> | null = null;
const finalized: Array<Record<string, unknown>> = [];
const deleted: string[] = [];
const replied: string[] = [];
/** The conversation the session still owns, for a prompt with no card of its own. */
let ownedRef: Record<string, unknown> | null = null;
mock.module('../channels/teams/turn', () => ({
  loadTurn: async () => { ordered.push('load'); return turn; },
  conversationRefForSession: async () => { ordered.push('reference'); return ownedRef; },
  finalizeTurn: async (_h: unknown, opts: Record<string, unknown>) => {
    ordered.push('finalize');
    if (failStage === 'finalize') throw new Error('finalize failed');
    finalized.push(opts);
  },
  deleteTurn: async (id: string) => {
    deleted.push(id);
  },
  markTurnReplied: async (id: string) => {
    ordered.push('replied');
    if (failStage === 'replied') throw new Error('replied failed');
    replied.push(id);
  },
}));

let cardPosted: Record<string, unknown> | null = null;
let cardOk = true;
const texts: string[] = [];
mock.module('../channels/teams-api', () => ({
  sendCard: async (_ref: unknown, card: Record<string, unknown>) => {
    ordered.push('card');
    sentRef = _ref;
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
  ordered.length = 0;
  failStage = null;
  sentRef = undefined;
  ownedRef = null;
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
  replied.length = 0;
  texts.length = 0;
  cardPosted = null;
  cardOk = true;
  ownedRef = null;
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
      // Kept as a replied-turn marker, not deleted: a `teams send` from the
      // same run after the question must not open a second card.
      expect(replied).toEqual([SESSION_ID]);
      expect(deleted).toEqual([]);
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

    const res = await postTeamsQuestion(SESSION_ID, [{ header: 'Ready', question: 'Ready?', options: [] }]);

    expect(res.answers).toHaveLength(1);
    expect(res.answers?.[0][0]).toContain('finish this turn now');
  });

  test('no live turn and no conversation is an error, not a silent drop', async () => {
    turn = null;
    const { postTeamsQuestion } = await load();

    const res = await postTeamsQuestion(SESSION_ID, [{ header: 'Ready', question: 'Ready?', options: [] }]);

    expect(res.ok).toBe(false);
    expect(res.error).toContain('No active Teams turn');
    expect(finalized).toEqual([]);
  });

  test('a prompt with no card of its own still asks in the conversation it owns', async () => {
    // A message sent while another run was going, or a queued start, runs
    // with no live card. Its question used to be dropped as "no turn".
    turn = null;
    ownedRef = { serviceUrl: 'https://smba.trafficmanager.net/emea/', conversationId: 'a:synthetic-chat', tenantId: 'tenant-1', projectId: 'proj-1' };
    const { postTeamsQuestion } = await load();

    const res = await postTeamsQuestion(SESSION_ID, [
      { question: 'Deploy to prod?', options: [{ label: 'Yes' }, { label: 'No' }] },
    ] as never);

    expect(res.ok).toBe(true);
    expect(JSON.stringify(cardPosted)).toContain('Deploy to prod?');
    // No card of its own, so nothing to close.
    expect(finalized).toEqual([]);
  });
});

describe('postTeamsQuestion waiting-turn characterization', () => {
  test('finalizes, marks replied, then posts to the exact stored reference', async () => {
    const { postTeamsQuestion } = await load();
    await postTeamsQuestion(SESSION_ID, [{ header: 'Ready', question: 'Ready?', options: [] }]);
    expect(ordered).toEqual(['load', 'finalize', 'replied', 'card']);
    expect(sentRef).toEqual({
      serviceUrl: turn?.serviceUrl, conversationId: turn?.conversationId,
      botId: undefined, fromId: undefined, tenantId: turn?.tenantId, projectId: turn?.projectId,
    });
  });
  test('uses the owned reference unchanged without a live turn', async () => {
    turn = null;
    ownedRef = { serviceUrl: 'https://example.test', conversationId: 'synthetic-conversation' };
    const { postTeamsQuestion } = await load();
    await postTeamsQuestion(SESSION_ID, [{ header: 'Ready', question: 'Ready?', options: [] }]);
    expect(ordered).toEqual(['load', 'reference', 'card']);
    expect(sentRef).toBe(ownedRef);
  });
  for (const stage of ['finalize', 'replied']) {
    test(`propagates ${stage} failure without posting`, async () => {
      failStage = stage;
      const { postTeamsQuestion } = await load();
      await expect(postTeamsQuestion(SESSION_ID, [{ header: 'Ready', question: 'Ready?', options: [] }])).rejects.toThrow(`${stage} failed`);
      expect(ordered).toEqual(stage === 'finalize' ? ['load', 'finalize'] : ['load', 'finalize', 'replied']);
      expect(sentRef).toBeUndefined();
    });
  }
});
