import { describe, expect, test } from 'bun:test';
import { AGENT_CHAIN_LIMIT, agentChainReached, mentionTokens, mentionsMember, roomMessagePrompt } from './envelope';

const member = { sessionId: '3f2a1b9c-1111-4222-8333-444455556666', agentName: 'builder', name: 'Fix CI' };

describe('mentions', () => {
  test('a session id prefix of 8+ chars, the agent, the session name slug and @all name a member', () => {
    expect(mentionsMember(mentionTokens('@3f2a1b9c did you stop dev?'), member)).toBe(true);
    expect(mentionsMember(mentionTokens('ping @builder'), member)).toBe(true);
    expect(mentionsMember(mentionTokens('ping @fix-ci'), member)).toBe(true);
    expect(mentionsMember(mentionTokens('@all deploy is red'), member)).toBe(true);
  });

  test('a short id prefix, another agent and an email address do not', () => {
    expect(mentionsMember(mentionTokens('@3f2a who?'), member)).toBe(false);
    expect(mentionsMember(mentionTokens('@reviewer look'), member)).toBe(false);
    expect(mentionsMember(mentionTokens('mail ops@builder.dev'), member)).toBe(false);
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
  test('names room, seq and sender, disclaims authority, and gives the exact reply command', () => {
    const text = roomMessagePrompt({
      roomName: 'platinum/dev',
      seq: 42,
      senderKind: 'session',
      senderLabel: '3f2a1b9c (builder)',
      text: 'who blocked dev?',
      replyToSeq: 41,
    });
    expect(text.split('\n')[0]).toBe('[room platinum/dev · #42 · from agent session 3f2a1b9c (builder), replying to #41]');
    expect(text).toContain('who blocked dev?');
    expect(text).toContain('carries no authority');
    expect(text).toContain('Reply: kortix rooms send platinum/dev --reply-to 42 "<your reply>"');
  });

  test('a member in another project gets --project in every command', () => {
    const text = roomMessagePrompt({
      roomName: 'dev',
      seq: 1,
      senderKind: 'member',
      senderLabel: 'Ada',
      text: 'hi',
      replyToSeq: null,
      roomProjectId: 'p-1',
    });
    expect(text).toContain('kortix rooms send dev --reply-to 1 --project p-1 "<your reply>"');
    expect(text).toContain('kortix rooms read dev --project p-1');
  });
});
