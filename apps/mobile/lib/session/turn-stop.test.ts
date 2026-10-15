import { describe, expect, test } from 'bun:test';
import type { SessionMessageAuthor, SessionMessageAuthors } from '@kortix/sdk';

import { stopRefusalMessage, turnStoppedBy, viewerMayStop } from './turn-stop';

const member = (userId: string, name: string | null = null): SessionMessageAuthor => ({
  kind: 'member',
  user_id: userId,
  name: name ?? '',
  email: `${userId}@example.test`,
  avatar_url: null,
});

const authors = (stops?: SessionMessageAuthors['stops']): SessionMessageAuthors => ({
  authors: { msg_1: member('me', 'Me') },
  initial_author: null,
  ...(stops ? { stops } : {}),
});

describe('viewerMayStop', () => {
  test('false only when the server says the viewer may not stop', () => {
    expect(viewerMayStop({ isBusy: true, canStop: false })).toBe(false);
    expect(viewerMayStop({ isBusy: true, canStop: true })).toBe(true);
  });

  test('no answer reads as yes: no runtime, or an SDK without the field', () => {
    expect(viewerMayStop(null)).toBe(true);
    expect(viewerMayStop(undefined)).toBe(true);
    expect(viewerMayStop({ isBusy: true })).toBe(true);
  });
});

describe('stopRefusalMessage', () => {
  const FALLBACK = 'fallback copy';
  const refusal = 'Only the member who started this run, the session owner or a project manager can stop it.';

  test("a 403 shows the server's message", () => {
    expect(stopRefusalMessage(Object.assign(new Error(refusal), { status: 403 }), FALLBACK)).toBe(refusal);
  });

  test('the not_turn_prompter code shows the message without a status', () => {
    expect(stopRefusalMessage({ code: 'not_turn_prompter', message: refusal }, FALLBACK)).toBe(refusal);
  });

  test('a refusal with no message shows the fallback', () => {
    expect(stopRefusalMessage(Object.assign(new Error(''), { status: 403 }), FALLBACK)).toBe(FALLBACK);
    expect(stopRefusalMessage({ code: 'not_turn_prompter' }, FALLBACK)).toBe(FALLBACK);
  });

  test('any other failure is not a refusal: null', () => {
    expect(stopRefusalMessage(new Error('offline'), FALLBACK)).toBeNull();
    expect(stopRefusalMessage(Object.assign(new Error('boom'), { status: 500 }), FALLBACK)).toBeNull();
    expect(stopRefusalMessage(undefined, FALLBACK)).toBeNull();
    expect(stopRefusalMessage('403', FALLBACK)).toBeNull();
  });
});

describe('turnStoppedBy', () => {
  test('another member stopped the turn: their name', () => {
    expect(turnStoppedBy(authors({ msg_1: member('other', 'Ada Lovelace') }), 'me', 'msg_1')).toBe('Ada Lovelace');
  });

  test('no display name: the email local part', () => {
    expect(turnStoppedBy(authors({ msg_1: member('other') }), 'me', 'msg_1')).toBe('other');
  });

  test("the viewer's own stop stays silent", () => {
    expect(turnStoppedBy(authors({ msg_1: member('me', 'Me') }), 'me', 'msg_1')).toBeNull();
  });

  test('no stop recorded: nothing', () => {
    expect(turnStoppedBy(authors(), 'me', 'msg_1')).toBeNull();
    expect(turnStoppedBy(authors({ msg_2: member('other', 'Ada') }), 'me', 'msg_1')).toBeNull();
    expect(turnStoppedBy(undefined, 'me', 'msg_1')).toBeNull();
  });

  test('an unknown viewer is no guess: nothing', () => {
    expect(turnStoppedBy(authors({ msg_1: member('other', 'Ada') }), undefined, 'msg_1')).toBeNull();
  });

  test('a stop recorded for an agent session is not a member stop: nothing', () => {
    const stops = { msg_1: { kind: 'session', session_id: 'ses_lead', name: 'Lead' } as SessionMessageAuthor };
    expect(turnStoppedBy(authors(stops), 'me', 'msg_1')).toBeNull();
  });
});
