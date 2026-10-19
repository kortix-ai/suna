import { describe, expect, test } from 'bun:test';
import { AGENT_CHAIN_LIMIT, agentChainReached, mentionTokens, mentionsMember, roomMessagePrompt } from './envelope';

const session = { ids: ['3f2a1b9c-1111-4222-8333-444455556666'], names: ['builder', 'Fix CI'] };
const person = { ids: ['7c1d2e3f-aaaa-4bbb-8ccc-dddddddddddd'], names: [] };

describe('mentions', () => {
  test('an 8+ char id prefix, the agent, the session name slug and @all name a member', () => {
    expect(mentionsMember(mentionTokens('@3f2a1b9c did you stop dev?'), session)).toBe(true);
    expect(mentionsMember(mentionTokens('ping @builder'), session)).toBe(true);
    expect(mentionsMember(mentionTokens('ping @fix-ci'), session)).toBe(true);
    expect(mentionsMember(mentionTokens('@all deploy is red'), session)).toBe(true);
    expect(mentionsMember(mentionTokens('@7c1d2e3f can I drop it?'), person)).toBe(true);
  });

  test('a short id prefix, another agent and an email address do not', () => {
    expect(mentionsMember(mentionTokens('@3f2a who?'), session)).toBe(false);
    expect(mentionsMember(mentionTokens('@reviewer look'), session)).toBe(false);
    expect(mentionsMember(mentionTokens('mail ops@builder.dev'), session)).toBe(false);
  });
});

describe('agent chain', () => {
  test('pauses only when the last AGENT_CHAIN_LIMIT messages are all from sessions', () => {
    expect(agentChainReached(Array(AGENT_CHAIN_LIMIT).fill('session'))).toBe(true);
    expect(agentChainReached(Array(AGENT_CHAIN_LIMIT - 1).fill('session'))).toBe(false);
    expect(agentChainReached(['member', ...Array(AGENT_CHAIN_LIMIT).fill('session')])).toBe(false);
  });
});

describe('roomMessagePrompt', () => {
  test('a room message names room, seq and sender and gives the reply command', () => {
    const text = roomMessagePrompt({
      room: { kind: 'room', name: 'platinum/dev', roomId: 'r-1' },
      seq: 42, senderKind: 'session', senderLabel: '3f2a1b9c (builder)', text: 'who blocked dev?', replyToSeq: 41,
    });
    expect(text.split('\n')[0]).toBe('[room platinum/dev · #42 · from agent session 3f2a1b9c (builder), replying to #41]');
    expect(text).toContain('Reply: kortix rooms send platinum/dev --reply-to 42 "<your reply>"');
  });

  test('a direct message is addressed by its id', () => {
    const text = roomMessagePrompt({
      room: { kind: 'direct', name: null, roomId: '1131a78f-eec6-4bd2-bd67-5fcbb365fca1' },
      seq: 1, senderKind: 'member', senderLabel: 'Ada', text: 'hi', replyToSeq: null,
    });
    expect(text.split('\n')[0]).toBe('[direct message · #1 · from Ada]');
    expect(text).toContain('kortix rooms send 1131a78f-eec6-4bd2-bd67-5fcbb365fca1 --reply-to 1 "<your reply>"');
  });
});
