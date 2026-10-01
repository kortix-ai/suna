import { describe, expect, test } from 'bun:test';
import { sessionListQuery, takeSessionListFlags } from './sessions-list.ts';
import { parseSendArgs } from './send.ts';

const SID = '3f2a9c1e-7b04-4d58-9a21-0c5e8d6b1f77';

describe('parseSendArgs', () => {
  test('session target + text', () => {
    expect(parseSendArgs([SID, 'status?', '--json'])).toEqual({
      kind: 'session', targets: [SID], text: 'status?', project: undefined, host: undefined, name: undefined, json: true,
    });
  });
  test('one email', () => {
    const a = parseSendArgs(['avery@example.com', 'Which', 'region?', '--name', 'Region']);
    expect(a).toMatchObject({ kind: 'people', targets: ['avery@example.com'], text: 'Which region?', name: 'Region' });
  });
  test('several emails form a group', () => {
    const a = parseSendArgs(['avery@example.com', 'sam@example.com', 'Launch date?', '--project', 'p1']);
    expect(a).toMatchObject({ kind: 'people', targets: ['avery@example.com', 'sam@example.com'], text: 'Launch date?', project: 'p1' });
  });
  test('-p carries the text', () => {
    expect(parseSendArgs(['avery@example.com', '-p', 'hi'])).toMatchObject({ kind: 'people', text: 'hi' });
  });
  test('mixing a session id with emails is an error', () => {
    expect(parseSendArgs([SID, 'avery@example.com', 'hi'])).toHaveProperty('error');
  });
  test('missing text is an error', () => {
    expect(parseSendArgs(['avery@example.com'])).toHaveProperty('error');
    expect(parseSendArgs([SID])).toHaveProperty('error');
  });
  test('missing target, bad target and unknown flag are errors', () => {
    expect(parseSendArgs(['hello there'])).toHaveProperty('error');
    expect(parseSendArgs(['-p', 'hi'])).toHaveProperty('error');
    expect(parseSendArgs(['nope', '-p', 'hi'])).toHaveProperty('error');
    expect(parseSendArgs([SID, 'hi', '--bogus'])).toHaveProperty('error');
  });
});

describe('sessions ls --asked', () => {
  test('asks for participant=me', () => {
    expect(sessionListQuery(takeSessionListFlags(['--asked']))).toBe('?participant=me');
  });
});
