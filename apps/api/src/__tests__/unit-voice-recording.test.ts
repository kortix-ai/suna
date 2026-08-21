import { beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * What a live call leaves behind.
 *
 * The bug these cover: the Kortix agent called the `kortix_voice` connector's
 * `send_prompt`, the room heard it, and `voice_call_turns` had no row for it —
 * so the /voice page rendered a conversation with one side missing. The record
 * of the agent side depended entirely on the LiveKit worker echoing its own
 * speech back through `ConversationItemAdded`, a client-side event in another
 * process that was observed not firing for a programmatic `generateReply`.
 *
 * So the assertion running through all of this is: whatever apps/api hands to
 * the room, apps/api records — and it records the SPOKEN payload, never the
 * "[result] …say it out loud in your own words" instruction wrapper that goes
 * on the wire.
 */

let dbResults: unknown[][] = [];
let inserts: Record<string, unknown>[] = [];
let insertThrows = false;
let agentInRoom = true;
const sent: Array<{ room: string; topic: string; payload: any }> = [];

function makeChain(kind?: string): any {
  const chain: any = {};
  for (const m of [
    'from',
    'where',
    'limit',
    'orderBy',
    'values',
    'onConflictDoNothing',
    'onConflictDoUpdate',
    'set',
  ]) {
    chain[m] = (...args: unknown[]) => {
      if (kind === 'insert' && m === 'values') {
        if (insertThrows) throw new Error('transcript write exploded');
        inserts.push(args[0] as Record<string, unknown>);
      }
      return chain;
    };
  }
  chain.returning = () => chain;
  chain.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(dbResults.shift() ?? []));
  return chain;
}

mock.module('../shared/db', () => ({
  db: {
    select: () => makeChain('select'),
    insert: () => makeChain('insert'),
    update: () => makeChain('update'),
  }, auditDb: {
    select: () => makeChain('select'),
    insert: () => makeChain('insert'),
    update: () => makeChain('update'),
  },
  hasDatabase: () => true,
}));

mock.module('../config', () => ({
  config: { KORTIX_URL: 'https://example.com', API_KEY_SECRET: 'test-secret' },
}));

mock.module('../channels/voice/livekit', () => ({
  KORTIX_REPLY_TOPIC: 'kortix',
  roomNameForCall: (callId: string) => `voice-${callId}`,
  roomHasAgent: async () => agentInRoom,
  roomCallbackUrl: async () => 'https://example.com',
  createRoom: async () => {},
  deleteRoom: async () => {},
  joinPageUrl: () => 'https://example.com/voice/tok',
  // Unused here, but bun's module mocks are registered globally for the whole
  // test RUN: a partial stand-in for livekit.ts breaks any other unit file in
  // the same run that imports an export this object omits (public-join-routes
  // imports `mintAccessToken`). Keep this a faithful superset, not a minimal one.
  mintAccessToken: async () => 'lk-jwt',
  sendRoomData: async (room: string, topic: string, payload: unknown) => {
    sent.push({ room, topic, payload });
  },
}));

mock.module('../channels/voice/answer-watch', () => ({
  speakAnswerWhenReady: () => {},
}));

mock.module('../projects/session-lifecycle', () => ({
  continueSession: async () => 'delivered',
}));

const { askKortix, buildAskPrompt, promptVoiceAgent, settleAsk } = await import(
  '../channels/voice/runtime'
);
const { ASK_SETTLED_SPEAKER, ASK_SPEAKER, IN_FLIGHT_MESSAGE } = await import(
  '../channels/voice/ask-ledger'
);

/**
 * An in-memory stand-in for the three transcript QUERIES, so the read-position
 * behaviour can be exercised without a database.
 *
 * Only those three are replaced — everything else in runtime.ts is spread
 * through untouched, because bun's module mocks are global for the whole test
 * RUN and a partial stand-in would break every other file that imports this
 * module (the same trap the livekit mock above documents). `promptVoiceAgent`
 * was destructured above, before this registration, so the recording tests keep
 * the real implementation.
 *
 * The fakes mirror the SQL exactly: forward from an exclusive floor, the tail in
 * speaking order, and a count that fetches nothing.
 */
interface FakeTurn {
  cursor: number;
  role: string;
  speaker: string | null;
  text: string;
  at: string;
}
let transcript: FakeTurn[] = [];

const realRuntime = await import('../channels/voice/runtime');
mock.module('../channels/voice/runtime', () => ({
  ...realRuntime,
  readTurns: async (_callId: string, cursor: number, limit = 200) => {
    const turns = transcript.filter((t) => t.cursor > cursor).slice(0, limit);
    return { turns, cursor: turns.length > 0 ? turns[turns.length - 1]!.cursor : cursor };
  },
  readLastTurns: async (_callId: string, limit = 10) => {
    const turns = limit >= transcript.length ? [...transcript] : transcript.slice(-limit);
    return { turns, cursor: turns.length > 0 ? turns[turns.length - 1]!.cursor : 0 };
  },
  countTurnsAfter: async (_callId: string, cursor: number) =>
    transcript.filter((t) => t.cursor > cursor).length,
}));

const { readTranscriptForAgent, resolveReadPlan } = await import(
  '../channels/voice/transcript-read'
);

const { relayTurnAnswer, relayTurnEnd, relayTurnStep } = await import('../channels/voice/turn');
const {
  KORTIX_SPEAKER,
  kortixError,
  kortixProgress,
  kortixQuestion,
  kortixResult,
  kortixReview,
  kortixSay,
} = await import('../channels/voice/utterance');

beforeEach(() => {
  dbResults = [];
  inserts = [];
  insertThrows = false;
  agentInRoom = true;
  sent.length = 0;
  transcript = [];
  storedPosition = 0;
});

describe('kortix utterances — instruction on the wire, payload in the record', () => {
  const cases = [
    { name: 'say', u: kortixSay('the connector works straight from the session'), tag: '[say]' },
    { name: 'progress', u: kortixProgress('reading the config'), tag: '[progress]' },
    { name: 'result', u: kortixResult('four tests failed'), tag: '[result]' },
    { name: 'question', u: kortixQuestion('should I deploy it?'), tag: '[question]' },
    { name: 'review', u: kortixReview('the login fix'), tag: '[review]' },
    { name: 'error', u: kortixError('sandbox not ready'), tag: '[error]' },
  ];

  for (const { name, u, tag } of cases) {
    test(`${name}: the instruction is tagged, and the transcript is not the instruction`, () => {
      expect(u.instruction).toContain(tag);
      expect(u.transcript).not.toBe(u.instruction);
      expect(u.transcript.trim().length).toBeGreaterThan(0);
      // The transcript is what a human reads back. Stage directions aimed at
      // the voice model must never survive into it — recording the wire text
      // verbatim is the other half of this bug, and it reads as the agent
      // literally saying "mention this briefly and naturally".
      expect(u.transcript).not.toContain(tag);
      expect(u.transcript.toLowerCase()).not.toContain('in your own words');
      expect(u.transcript.toLowerCase()).not.toContain('say it out loud');
      expect(u.transcript.toLowerCase()).not.toContain('briefly and naturally');
    });
  }

  test('the transcript carries the thing that was actually said', () => {
    expect(kortixSay('deploy is green').transcript).toBe('deploy is green');
    expect(kortixResult('four tests failed').transcript).toBe('four tests failed');
    expect(kortixQuestion('should I deploy it?').transcript).toBe('should I deploy it?');
    expect(kortixProgress('reading the config').transcript).toContain('reading the config');
    expect(kortixReview('the login fix').transcript).toContain('the login fix');
    expect(kortixError('sandbox not ready').transcript).toContain('sandbox not ready');
  });

  test('send_prompt keeps the framing that stopped the call answering statements as questions', () => {
    const instruction = kortixSay('the connector works straight from the session').instruction;
    expect(instruction).toContain('Your Kortix agent');
    expect(instruction).toContain('do not treat it');
    expect(instruction).toContain('as a question or a task to act on');
    expect(instruction).toContain('the connector works straight from the session');
  });
});

/**
 * The reframing that breaks the loop.
 *
 * Voice is the ONLY channel with its own LLM on the far side — Slack, Teams and
 * email are one model talking to humans. So whatever apps/api says here is read
 * by a second model with its own conversation history and its own beliefs, and
 * that model can be wrong: on a real call a transcription artifact led it to
 * assert "this project is about developing a system involving dogs", and because
 * that claim sat in its history as fact, every correct answer sent from here
 * CONTRADICTED it. It could not relay an answer that disagreed with itself, so
 * it asked Kortix again to resolve the contradiction — at real cost per ask —
 * until a human hung up.
 *
 * "[result] … say it out loud now, in your own words" is what made that
 * possible: own words is a licence to blend the answer with the belief. The
 * replacement has to do two things instead — state the answer, and explicitly
 * SUPERSEDE anything the model said earlier that conflicts with it. Without the
 * second, the model has no permission to have been wrong, and keeps trying to
 * reconcile.
 */
describe('a result is authoritative, and says so', () => {
  const result = kortixResult('the migration applied cleanly');

  test('it states the answer rather than inviting a reinterpretation', () => {
    expect(result.instruction).toContain('Kortix has answered');
    expect(result.instruction).toContain('State this answer to the room');
    expect(result.instruction).toContain('the migration applied cleanly');
    // The exact licence that let a false belief survive contact with the truth.
    expect(result.instruction).not.toContain('in your own words');
  });

  test('it explicitly overrides what the voice model said earlier — the clause that ends the loop', () => {
    expect(result.instruction).toContain('REPLACES anything you said or assumed earlier');
    expect(result.instruction).toContain('Do not ask Kortix about it again');
  });

  test('it corrects the record when the room already heard the contradiction', () => {
    // A supersede the room never hears is a supersede that leaves two
    // incompatible statements standing in the transcript and in the meeting.
    expect(result.instruction).toContain('correct that plainly in the same');
    expect(result.instruction).toContain('I had that wrong');
  });

  test('it forbids adding anything to the answer', () => {
    expect(result.instruction).toContain('Add no detail, no explanation, no');
    expect(result.instruction).toContain('guess');
  });

  test('the answer text itself is still the whole transcript line', () => {
    // The supersede framing is for the model. None of it may leak into what a
    // human reads back as "what was said".
    expect(result.transcript).toBe('the migration applied cleanly');
  });

  test('a say and an error supersede too — half a rule leaves the contradiction standing', () => {
    // If a result overrides but an error does not, a model holding a false
    // belief still has something to chase the moment a turn fails.
    for (const u of [kortixSay('deploy is green'), kortixError('sandbox not ready')]) {
      expect(u.instruction).toContain('REPLACES anything you said or assumed earlier');
    }
    expect(kortixError('sandbox not ready').instruction).toContain('Do not offer a theory');
    expect(kortixError('sandbox not ready').instruction).toContain('do not hand the same request over again');
  });

  test('a progress step does NOT supersede — it is not a finding', () => {
    // Telling the model that "reading the config" overrides its beliefs would
    // invite it to spin a step into an answer.
    const progress = kortixProgress('reading the config');
    expect(progress.instruction).not.toContain('REPLACES anything you said');
    expect(progress.instruction).toContain('there is no answer yet');
    expect(progress.instruction).toContain('do not guess what it will find');
  });

  test('results still go through generateReply, not say() — verbatim robot phrasing is worse', () => {
    // Removing the licence to invent is not the same as removing natural
    // phrasing: these stay INSTRUCTIONS (tagged, addressed to a model), because
    // an answer written for a chat surface read aloud verbatim sounds like a
    // machine reading a ticket. See inbound-replies.ts's header.
    expect(result.instruction.startsWith('[result]')).toBe(true);
    expect(result.instruction).not.toBe(result.transcript);
  });

  test('an error with no readable cause still says something', () => {
    expect(kortixError(null).transcript).toBe('That request failed');
    expect(kortixError('  ').instruction).not.toContain('::');
  });

  test('Kortix speaks under its own name, not the bot voice', () => {
    // The worker labels what the voice ACTUALLY said with the bot's display
    // name (apps/voice-agent/src/transcripts.ts). These two are both the agent
    // side and must stay distinguishable.
    expect(KORTIX_SPEAKER).toBe('kortix');
  });
});

describe('promptVoiceAgent records what the room was given', () => {
  test('delivers the instruction and writes the payload as an agent turn', async () => {
    const res = await promptVoiceAgent('sess-1', kortixSay('deploy is green'), { projectId: 'proj-1' });

    expect(res.delivered).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.room).toBe('voice-sess-1');
    expect(sent[0]!.payload.type).toBe('kortix_reply');
    expect(sent[0]!.payload.text).toContain('[say]');

    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toEqual({
      callId: 'sess-1',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      role: 'agent',
      speaker: 'kortix',
      text: 'deploy is green',
    });
  });

  test('resolves the project from the session when the caller has none', async () => {
    // turn.ts and answer-watch.ts only ever hold a session id — project_id is
    // NOT NULL on voice_call_turns, so a missing lookup here means the turn is
    // silently never recorded.
    dbResults = [[{ projectId: 'proj-9' }]];

    await promptVoiceAgent('sess-2', kortixResult('four tests failed'));

    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.projectId).toBe('proj-9');
    expect(inserts[0]!.text).toBe('four tests failed');
  });

  test('records nothing when the room has no worker — the utterance was never delivered', async () => {
    agentInRoom = false;

    const res = await promptVoiceAgent('sess-3', kortixSay('nobody is listening'), { projectId: 'p' });

    expect(res.delivered).toBe(false);
    expect(res.reason).toContain('no voice agent');
    expect(sent).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  test('a failed transcript write never turns a delivered utterance into a failure', async () => {
    // Otherwise the agent believes the room did not hear it and says it again.
    insertThrows = true;

    const res = await promptVoiceAgent('sess-4', kortixSay('deploy is green'), { projectId: 'p' });

    expect(res.delivered).toBe(true);
    expect(sent).toHaveLength(1);
  });

  test('an unresolvable project degrades to "delivered but unrecorded", never to a throw', async () => {
    dbResults = [[]];
    const res = await promptVoiceAgent('sess-5', kortixResult('done'));
    expect(res.delivered).toBe(true);
    expect(inserts).toHaveLength(0);
  });
});

/**
 * ONE HAND-OFF AT A TIME, against the real query chain.
 *
 * unit-voice-ask-ledger.test.ts covers the decision exhaustively as pure logic;
 * what is left — and what actually broke in production — is the WIRING: that the
 * ask row is written here, awaited, before anything can read the ledger, and
 * that a refusal comes back as a sentence the model can act on rather than as a
 * silent no-op.
 */
describe('askKortix — one hand-off in flight per call', () => {
  const call = {
    callId: 'sess-ask',
    projectId: 'proj-1',
    sessionId: 'sess-ask',
    voice: 'alloy',
    room: 'voice-sess-ask',
    startedAt: 0,
    closed: false,
  };

  test('an empty ledger allows the ask, and the ask row is written as part of it', async () => {
    dbResults = [[]]; // readAskLedger

    expect(await askKortix(call, '  what is the build status?  ')).toEqual({ ok: true });

    // Written HERE and awaited, not fire-and-forget from the MCP layer: this row
    // IS the in-flight flag, so the next ask's ledger read must be guaranteed to
    // see it, and it must never land after its own settle row.
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toEqual({
      callId: 'sess-ask',
      projectId: 'proj-1',
      sessionId: 'sess-ask',
      role: 'tool',
      speaker: ASK_SPEAKER,
      text: 'ask_kortix: what is the build status?',
    });
  });

  test('a second ask while one is outstanding is refused, and writes nothing', async () => {
    dbResults = [[{ cursor: 7, speaker: ASK_SPEAKER, createdAt: new Date(Date.now() - 3_000) }]];

    const res = await askKortix(call, 'are you sure about the dogs?');

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error).toBe(IN_FLIGHT_MESSAGE);
    // A refused ask is not a hand-off: recording one would make the NEXT ledger
    // read see a fresh outstanding ask and lock the call out for longer on every
    // repeat — the loop, inverted.
    expect(inserts).toHaveLength(0);
  });

  test('once the answer has settled, the next ask goes through again', async () => {
    dbResults = [
      [
        { cursor: 8, speaker: ASK_SETTLED_SPEAKER, createdAt: new Date(Date.now() - 1_000) },
        { cursor: 7, speaker: ASK_SPEAKER, createdAt: new Date(Date.now() - 30_000) },
      ],
    ];

    expect(await askKortix(call, 'and now?')).toEqual({ ok: true });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.speaker).toBe(ASK_SPEAKER);
  });

  test('an empty request is still rejected before any of this', async () => {
    expect(await askKortix(call, '   ')).toEqual({ ok: false, error: 'empty request' });
    expect(inserts).toHaveLength(0);
  });

  test('a long request is truncated — a transcript row is permanent and this is free text', async () => {
    dbResults = [[]];
    await askKortix(call, 'x'.repeat(900));
    expect(String(inserts[0]!.text).length).toBeLessThanOrEqual(512);
    expect(String(inserts[0]!.text).endsWith('…')).toBe(true);
  });

  test('an unreadable ledger ALLOWS the ask — a DB blip must not mute a live call', async () => {
    // The deliberate direction of the trade. Failing closed here turns a
    // possible overspend into a certain one: a call that cannot hand anything
    // over cannot answer anyone, and has no way to explain why.
    dbResults = [];
    const chainThatThrows = () => {
      throw new Error('connection reset');
    };
    const { db } = await import('../shared/db');
    const originalSelect = db.select;
    (db as { select: unknown }).select = chainThatThrows;
    try {
      expect(await askKortix(call, 'still there?')).toEqual({ ok: true });
    } finally {
      (db as { select: unknown }).select = originalSelect;
    }
  });
});

describe('settleAsk — the arriving answer is what clears the flag', () => {
  test('it writes a settle row naming the outcome, in the shape every tool row uses', async () => {
    dbResults = [[{ projectId: 'proj-9' }]]; // projectIdForSession

    await settleAsk('sess-settle', 'answered');

    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      callId: 'sess-settle',
      projectId: 'proj-9',
      role: 'tool',
      speaker: ASK_SETTLED_SPEAKER,
      // `<tool>: <detail>` — so the call page's existing splitter renders it
      // without a change there (apps/web .../call-record.ts `interpretTool`).
      text: 'ask_kortix_done: answered',
    });
  });

  test('it never throws — a settle that throws costs the call its next hand-off', async () => {
    dbResults = [[{ projectId: 'proj-9' }]];
    insertThrows = true;

    await settleAsk('sess-settle', 'timed out');

    expect(inserts).toHaveLength(0);
  });

  test('an unresolvable project degrades quietly rather than throwing into the watcher', async () => {
    dbResults = [[]];
    await settleAsk('sess-orphan', 'answered');
    expect(inserts).toHaveLength(0);
  });
});

describe('in-call turn relay lands in the transcript', () => {
  test('an answer spoken into the call is recorded as an agent turn', async () => {
    dbResults = [[{ projectId: 'proj-1' }]];

    expect(await relayTurnAnswer('sess-answer', 'the migration applied cleanly')).toBe(true);

    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      role: 'agent',
      speaker: 'kortix',
      text: 'the migration applied cleanly',
      sessionId: 'sess-answer',
    });
  });

  test('a spoken progress step is recorded; a throttled one is not spoken and not recorded', async () => {
    dbResults = [[{ projectId: 'proj-1' }]];

    expect(await relayTurnStep('sess-step', 'reading the config')).toBe(true);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.text).toContain('reading the config');

    // Throttled: nothing reaches the room, so nothing may claim it did.
    expect(await relayTurnStep('sess-step', 'writing the file')).toBe(false);
    expect(inserts).toHaveLength(1);
  });

  test('a clean end says nothing and therefore records nothing', async () => {
    expect(await relayTurnEnd('sess-end', 'idle')).toBe(false);
    expect(inserts).toHaveLength(0);
  });

  test('a failed turn is spoken and recorded with its cause', async () => {
    dbResults = [[{ projectId: 'proj-1' }]];

    expect(await relayTurnEnd('sess-err', 'error', { message: 'sandbox not ready' })).toBe(true);

    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.text).toContain('sandbox not ready');
    expect(String(inserts[0]!.text)).not.toContain('[error]');
  });
});

/**
 * `db-deps.ts` pulls in most of the API to import, so its voice wiring is
 * asserted by reading the source — the same approach
 * unit-connector-router-deps.test.ts uses, and for the same reason: these are
 * one-line wirings whose absence is invisible until production.
 */
const DB_DEPS_SOURCE = await Bun.file(
  new URL('../connectors/db-deps.ts', import.meta.url).pathname,
).text();

describe('kortix_voice connector wiring', () => {
  const source = DB_DEPS_SOURCE;

  test('send_prompt goes through kortixSay, so what it says is also what gets recorded', () => {
    expect(source).toContain("from '../channels/voice/utterance'");
    expect(source).toContain('kortixSay(text)');
    // The framing must live in utterance.ts next to the transcript line, not
    // be re-inlined here where nothing can record it.
    expect(source).not.toContain('[say] Your Kortix agent');
  });

  test('read_transcript delegates the whole read, and only adds liveness', () => {
    // Mode/position/shape belong to transcript-read.ts, which is unit-testable.
    // What db-deps must not do is re-derive any of it here, or add a second
    // place where the response shape can drift.
    const mapping = source.slice(
      source.indexOf("if (op === 'read_transcript')"),
      source.indexOf("if (op === 'send_prompt')"),
    );
    expect(mapping).toContain('readTranscriptForAgent');
    // Liveness is a LiveKit question, not a transcript one, so it is the one
    // field added on this side.
    expect(mapping).toContain('live: await isCallLive(sessionId)');
    expect(mapping).not.toContain('readTurns(');
  });

  test('the shaped turn still carries `speaker`, not just role and text', async () => {
    // role 'agent' covers BOTH the voice speaking and the agent's own
    // send_prompt lines, and role 'tool' is meaningless without the tool name —
    // so a transcript without `speaker` is one the agent cannot attribute.
    const shaping = await Bun.file(
      new URL('../channels/voice/transcript-read.ts', import.meta.url).pathname,
    ).text();
    expect(shaping).toContain('speaker: t.speaker');
  });
});

describe('voice_call_turns accepts the roles the code writes', () => {
  const migrations = new URL('../../../../packages/db/migrations/', import.meta.url).pathname;

  test("the CHECK constraint allows 'tool', so MCP tool lines are insertable", async () => {
    const sql = await Bun.file(`${migrations}20260726151842728_voice_call_turns_allow_tool_role.sql`).text();
    expect(sql).toContain(`CHECK ("role" IN ('user', 'agent', 'tool'))`);
  });

  test('the widened constraint is validated in a follow-up migration, not left NOT VALID forever', async () => {
    const sql = await Bun.file(`${migrations}20260726151944122_validate_voice_call_turns_role_check.sql`).text();
    expect(sql).toContain('VALIDATE CONSTRAINT');
    expect(sql).toContain('voice_call_turns_role_check');
  });
});

describe('the inbound voice prompt teaches the agent how to work the call', () => {
  /**
   * The defect: this prompt explained tone and nothing else, so an agent woken
   * by someone speaking never learned that it could read the room or talk back
   * — it just answered and went quiet. Slack and Teams both open their turn
   * instructions by pointing at their skill (channels/slack/session.ts,
   * channels/teams/session.ts); voice now does the same.
   */
  const prompt = buildAskPrompt('can you check the build?', 'sess-42');

  test('points at the kortix-voice skill, the way Slack and Teams do', () => {
    expect(prompt).toContain('`kortix-voice` skill');
    expect(prompt).toContain('`skill` tool');
  });

  test('names the two actions the agent has no other way to discover', () => {
    expect(prompt).toContain('send_prompt');
    expect(prompt).toContain('read_transcript');
  });

  test('still carries the request, the call, and the spoken-language rule', () => {
    expect(prompt).toContain('can you check the build?');
    expect(prompt).toContain('sess-42');
    expect(prompt).toContain('no markdown');
  });

  test('says nothing blocks, so the agent does not sit on the line', () => {
    expect(prompt.toLowerCase()).toContain('nothing blocks');
    expect(prompt).toContain('not holding the line');
  });

  test('stays short — this is prepended to every single thing said in the call', () => {
    // Not a style rule: the whole block is re-sent per utterance, so length
    // here is paid over and over for the life of the call.
    expect(prompt.length).toBeLessThan(900);
  });
});

/**
 * `read_transcript` — the read position, and why the DEFAULT is the cheap one.
 *
 * The defect these exist for is not a crash, it is a bill. The transcript was
 * always cursor-paged, but the cursor was the AGENT's to carry: forget it, or
 * start a fresh turn without it, and you passed 0 and re-read the whole call.
 * A bare `read_transcript {}` must now return only what has not been handed over
 * before — and the second bare call in a row must return nothing at all. That
 * one property is the entire change, so it is the first test here.
 */

/** The one row in `voice_call_read_cursors` this call would have. */
let storedPosition = 0;

/**
 * One `read_transcript`, against a persisted position.
 *
 * `getReadCursor` is the only SELECT the code under test issues (the transcript
 * queries are faked above), so queueing one row answers it; `advanceReadCursor`
 * shows up in `inserts`, and applying it to `storedPosition` here — max(), never
 * backwards, exactly as the upsert's `setWhere` does — is what makes the next
 * call see a real, surviving position rather than a fresh 0.
 */
async function agentRead(args: Record<string, unknown> = {}) {
  dbResults = [[{ cursor: storedPosition }]];
  inserts = [];
  const res = await readTranscriptForAgent({ callId: 'call-1', projectId: 'proj-1', args });
  const advance = inserts.find((i) => 'cursor' in i && 'callId' in i && !('role' in i));
  if (advance) storedPosition = Math.max(storedPosition, Number(advance.cursor));
  return res;
}

function seed(n: number): void {
  transcript = Array.from({ length: n }, (_, i) => ({
    cursor: i + 1,
    role: i % 2 === 0 ? 'user' : 'agent',
    speaker: i % 2 === 0 ? 'Marko' : 'kortix',
    text: `turn ${i + 1}`,
    at: new Date(1700000000000 + i).toISOString(),
  }));
}

describe('read_transcript — a bare call never re-reads what it already read', () => {
  test('THE property: the second bare read returns nothing, and the position survived it', async () => {
    seed(4);

    const first = await agentRead();
    expect(first.mode).toBe('unread');
    expect(first.turns.map((t) => t.text)).toEqual(['turn 1', 'turn 2', 'turn 3', 'turn 4']);
    expect(first.cursor).toBe(4);
    expect(first.unread).toBe(0);
    expect(storedPosition).toBe(4);

    const second = await agentRead();
    expect(second.turns).toEqual([]);
    expect(second.unread).toBe(0);
    // Nothing new arrived, so nothing was written — an idle poll must not churn
    // the row on every turn of every live call.
    expect(inserts).toHaveLength(0);
  });

  test('only what arrives after the last read comes back', async () => {
    seed(2);
    await agentRead();

    transcript.push({
      cursor: 3,
      role: 'user',
      speaker: 'Marko',
      text: 'and the deploy?',
      at: new Date().toISOString(),
    });

    const next = await agentRead();
    expect(next.turns.map((t) => t.text)).toEqual(['and the deploy?']);
    expect(next.unread).toBe(0);
  });

  test('a clipped page advances only to what it actually handed over — nothing is skipped', async () => {
    // The failure this rules out is the bad one: marking turns read because they
    // EXISTED rather than because they were delivered.
    seed(5);

    const a = await agentRead({ limit: 2 });
    expect(a.turns.map((t) => t.text)).toEqual(['turn 1', 'turn 2']);
    expect(a.truncated).toBe(true);
    expect(a.unread).toBe(3);
    expect(storedPosition).toBe(2);

    const b = await agentRead({ limit: 2 });
    expect(b.turns.map((t) => t.text)).toEqual(['turn 3', 'turn 4']);
    expect(b.unread).toBe(1);

    const c = await agentRead({ limit: 2 });
    expect(c.turns.map((t) => t.text)).toEqual(['turn 5']);
    expect(c.truncated).toBeUndefined();
    expect(c.unread).toBe(0);
  });

  test('`unread` counts what is still waiting, so "is it worth reading" costs nothing', async () => {
    seed(5);
    const peeked = await agentRead({ peek: true, limit: 1 });
    expect(peeked.unread).toBe(5);
  });
});

describe('read_transcript — the modes that do not consume', () => {
  test('peek returns the unread and leaves the position where it was', async () => {
    seed(3);

    const first = await agentRead({ peek: true });
    expect(first.turns).toHaveLength(3);
    expect(storedPosition).toBe(0);

    // The whole point of peek: a turn that may not survive can look first.
    const second = await agentRead({ peek: true });
    expect(second.turns).toHaveLength(3);
    expect(storedPosition).toBe(0);
  });

  test('`last` re-orients without replaying the call and without consuming it', async () => {
    seed(6);

    const glance = await agentRead({ mode: 'last', limit: 2 });
    expect(glance.mode).toBe('last');
    expect(glance.turns.map((t) => t.text)).toEqual(['turn 5', 'turn 6']);
    // A `last` window always has older turns behind it; saying so every time
    // would be noise, so `truncated` is a forward-page signal only.
    expect(glance.truncated).toBeUndefined();
    expect(storedPosition).toBe(0);

    // It skipped turns 1-4, so it must NOT have claimed them as read.
    const drain = await agentRead();
    expect(drain.turns).toHaveLength(6);
  });

  test('`last` is the documented recovery when a turn dies right after reading', async () => {
    seed(3);
    await agentRead(); // read... and then, in the failure being modelled, the turn dies.
    expect((await agentRead()).turns).toEqual([]);

    const recovered = await agentRead({ mode: 'last', limit: 20 });
    expect(recovered.turns.map((t) => t.text)).toEqual(['turn 1', 'turn 2', 'turn 3']);
  });

  test('an explicit cursor still works exactly as before and never moves the position', async () => {
    seed(4);

    const paged = await agentRead({ cursor: 2 });
    expect(paged.mode).toBe('cursor');
    expect(paged.turns.map((t) => t.text)).toEqual(['turn 3', 'turn 4']);
    expect(storedPosition).toBe(0);

    // `{"cursor":0}` — the old habit — is still the whole call, unchanged.
    const fromZero = await agentRead({ cursor: 0 });
    expect(fromZero.turns).toHaveLength(4);
    expect(storedPosition).toBe(0);
  });
});

describe('read_transcript — full', () => {
  test('returns the whole call and marks it read, since it covered everything', async () => {
    seed(3);
    await agentRead(); // drain first, so "full" is proving it ignores the position
    transcript.push({
      cursor: 4,
      role: 'user',
      speaker: 'Marko',
      text: 'one more',
      at: new Date().toISOString(),
    });

    const whole = await agentRead({ mode: 'full' });
    expect(whole.mode).toBe('full');
    expect(whole.turns).toHaveLength(4);
    expect(storedPosition).toBe(4);
    expect((await agentRead()).turns).toEqual([]);
  });
});

describe('read_transcript — the turn shape is the thing paid for on every line', () => {
  test('no per-turn cursor, and `speaker` is omitted rather than sent as null', async () => {
    transcript = [
      { cursor: 1, role: 'user', speaker: 'Marko', text: 'hi', at: 'x' },
      { cursor: 2, role: 'agent', speaker: null, text: 'hello', at: 'x' },
    ];

    const page = await agentRead();
    expect(page.turns[0]).toEqual({ role: 'user', speaker: 'Marko', text: 'hi' });
    // `speaker` still rides along when there IS one: role 'agent' covers both
    // the voice and this agent's own send_prompt lines, so role alone cannot
    // answer "who said this".
    expect(page.turns[1]).toEqual({ role: 'agent', text: 'hello' });
    // The per-turn cursor was ~5 tokens of noise per line; the page-level one is
    // the only resume point anything uses.
    expect(page.turns[0]).not.toHaveProperty('cursor');
    expect(page.turns[0]).not.toHaveProperty('at');
  });
});

describe('resolveReadPlan — what the agent asked for vs what runs', () => {
  test('nothing at all means unread', () => {
    expect(resolveReadPlan({})).toEqual({ mode: 'unread', limit: 100, peek: false, cursor: 0 });
  });

  test('a bare cursor selects the old stateless contract', () => {
    expect(resolveReadPlan({ cursor: 7 }).mode).toBe('cursor');
    expect(resolveReadPlan({ cursor: 0 }).mode).toBe('cursor');
  });

  test('an explicit mode beats a stray cursor', () => {
    expect(resolveReadPlan({ mode: 'unread', cursor: 7 }).mode).toBe('unread');
    expect(resolveReadPlan({ mode: 'LAST' }).mode).toBe('last');
  });

  test('an unknown mode falls back to unread instead of costing the agent a turn', () => {
    expect(resolveReadPlan({ mode: 'tail' }).mode).toBe('unread');
    expect(resolveReadPlan({ mode: 'follow' }).mode).toBe('unread');
  });

  test('per-mode defaults, and a hard ceiling on any of them', () => {
    expect(resolveReadPlan({ mode: 'last' }).limit).toBe(10);
    expect(resolveReadPlan({ mode: 'full' }).limit).toBe(500);
    expect(resolveReadPlan({ limit: 9999 }).limit).toBe(500);
    expect(resolveReadPlan({ limit: 0 }).limit).toBe(1);
    expect(resolveReadPlan({ limit: -5 }).limit).toBe(1);
  });

  test('args that arrive as strings still parse — a JSON arg is not always a number', () => {
    expect(resolveReadPlan({ limit: '3' }).limit).toBe(3);
    expect(resolveReadPlan({ cursor: '12' })).toMatchObject({ mode: 'cursor', cursor: 12 });
    expect(resolveReadPlan({ peek: 'true' }).peek).toBe(true);
    expect(resolveReadPlan({ peek: false }).peek).toBe(false);
  });
});
