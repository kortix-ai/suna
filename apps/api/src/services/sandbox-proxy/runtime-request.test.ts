import { describe, expect, test } from 'bun:test';
import { classifyRuntimeRequest, turnStartBodyFields } from './runtime-request';
import { clientAbortTarget } from './client-abort';
import { isNonIdempotentSessionWrite } from './prompt-dedupe';
import { isLongTurnCompletionRequest } from './preview-retry-budget';
import { isTurnStartEnvSync } from './pre-prompt-env-sync';
import { isTurnStartRequest } from '../sandboxes/turn-start-request';
import { extractTurnIdentity } from '../sessions/session-turn-ledger';

const body = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer;

describe('classifyRuntimeRequest', () => {
  test.each([
    ['POST', '/session/ses_1/prompt_async', { kind: 'turn-start', verb: 'prompt_async', runtimeSessionId: 'ses_1', prefix: '' }],
    ['POST', '/session/ses_1/message', { kind: 'turn-start', verb: 'message', runtimeSessionId: 'ses_1', prefix: '' }],
    ['POST', '/session/ses_1/command/', { kind: 'turn-start', verb: 'command', runtimeSessionId: 'ses_1', prefix: '' }],
    ['post', '/session/ses_1/summarize', { kind: 'turn-start', verb: 'summarize', runtimeSessionId: 'ses_1', prefix: '' }],
    ['POST', '/proxy/4096/session/ses_1/prompt_async', { kind: 'turn-start', verb: 'prompt_async', runtimeSessionId: 'ses_1', prefix: '/proxy/4096' }],
    ['POST', '/kortix/runtime/sessions/ses_1/prompt', { kind: 'turn-start', verb: 'prompt', runtimeSessionId: 'ses_1', prefix: '' }],
    ['POST', '/kortix/opencode/sessions/ses_1/prompt', { kind: 'turn-start', verb: 'prompt', runtimeSessionId: 'ses_1', prefix: '' }],
    ['POST', '/session/ses_1/abort', { kind: 'abort', runtimeSessionId: 'ses_1', prefix: '' }],
    ['POST', '/proxy/4096/session/ses_1/abort/', { kind: 'abort', runtimeSessionId: 'ses_1', prefix: '/proxy/4096' }],
    ['POST', '/kortix/runtime/sessions/ses_%31/abort', { kind: 'abort', runtimeSessionId: 'ses_1', prefix: '' }],
    ['GET', '/session/ses_1/message', { kind: 'message-list', runtimeSessionId: 'ses_1', prefix: '' }],
    ['GET', '/session/ses_1/message/', { kind: 'message-list', runtimeSessionId: 'ses_1', prefix: '' }],
  ] as const)('%s %s', (method, path, expected) => {
    expect(classifyRuntimeRequest(method, path)).toEqual(expected);
  });

  test.each([
    ['GET', '/session/ses_1/prompt_async'],
    ['POST', '/session/ses_1/message/msg_1'],
    ['GET', '/session/ses_1/message/msg_1'],
    ['DELETE', '/session/ses_1/message/msg_1'],
    ['GET', '/session/ses_1/abort'],
    ['POST', '/session/ses_1/abortx'],
    ['POST', '/session/ses_1'],
    ['GET', '/kortix/runtime/sessions/ses_1/prompt'],
    ['POST', '/kortix/runtime/sessions/ses_1/prompt/extra'],
    ['POST', '/kortix/runtime/messages/ses_1'],
    ['POST', '/session/%E0%A4%A/prompt_async'],
    ['POST', '/global/event'],
  ])('%s %s is not a runtime turn route', (method, path) => {
    expect(classifyRuntimeRequest(method, path)).toEqual({ kind: 'other' });
  });
});

describe('turnStartBodyFields', () => {
  test('reads both the Kortix and the OpenCode spelling', () => {
    expect(turnStartBodyFields(body({ message_id: 'msg_a', no_reply: true }))).toEqual({ messageId: 'msg_a', noReply: true });
    expect(turnStartBodyFields(body({ messageID: ' msg_b ', noReply: false }))).toEqual({ messageId: 'msg_b', noReply: false });
    expect(turnStartBodyFields(body({ parts: [] }))).toEqual({ messageId: null, noReply: false });
    expect(turnStartBodyFields(new TextEncoder().encode('{').buffer as ArrayBuffer)).toEqual({ messageId: null, noReply: false });
    expect(turnStartBodyFields(undefined)).toEqual({ messageId: null, noReply: false });
  });
});

describe('the proxy predicates agree on one classification', () => {
  test('the Kortix prompt route is a turn start, a user turn, and non-idempotent', () => {
    const path = '/kortix/runtime/sessions/ses_1/prompt';
    expect(isTurnStartRequest(8000, 'POST', path)).toBe(true);
    expect(isTurnStartEnvSync(8000, 'POST', path)).toBe(true);
    expect(isNonIdempotentSessionWrite(8000, 'POST', path)).toBe(true);
    // It answers 202 at once; only the blocking routes get the long timeout.
    expect(isLongTurnCompletionRequest({ method: 'POST', path })).toBe(false);
  });

  test('the Kortix abort route is a stop somebody asked for', () => {
    expect(clientAbortTarget(8000, 'POST', '/kortix/runtime/sessions/ses_1/abort')).toBe('ses_1');
    expect(clientAbortTarget(4096, 'POST', '/kortix/runtime/sessions/ses_1/abort')).toBeNull();
  });

  // Behavior change: these predicates used to miss the in-box `/proxy/<port>`
  // spelling of the same call, so an abort through it was not stamped a
  // UserStop and a prompt through it could be re-sent by the retry loop.
  test('every predicate reads the /proxy/<port> spelling as the same call', () => {
    expect(clientAbortTarget(8000, 'POST', '/proxy/4096/session/ses_1/abort')).toBe('ses_1');
    expect(isNonIdempotentSessionWrite(8000, 'POST', '/proxy/4096/session/ses_1/prompt_async')).toBe(true);
    expect(isLongTurnCompletionRequest({ method: 'POST', path: '/proxy/4096/session/ses_1/message' })).toBe(true);
  });

  test('/summarize starts a turn but is not a user turn', () => {
    expect(isTurnStartRequest(8000, 'POST', '/session/ses_1/summarize')).toBe(true);
    expect(isTurnStartEnvSync(8000, 'POST', '/session/ses_1/summarize')).toBe(false);
  });

  test('the ledger reads the identity of a Kortix prompt body', () => {
    expect(extractTurnIdentity('/kortix/runtime/sessions/ses_1/prompt', body({ message_id: 'msg_a', parts: [] }))).toEqual({
      runtimeSessionId: 'ses_1',
      messageId: 'msg_a',
    });
    expect(extractTurnIdentity('/kortix/runtime/sessions/ses_1/prompt', body({ no_reply: true, parts: [] }))).toBeNull();
    expect(extractTurnIdentity('/session/ses_1/prompt_async', body({ messageID: 'msg_b' }))).toEqual({
      runtimeSessionId: 'ses_1',
      messageId: 'msg_b',
    });
  });
});
