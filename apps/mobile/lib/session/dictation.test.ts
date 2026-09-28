import { describe, expect, test } from 'bun:test';

import {
  DICTATION_BAR_COUNT,
  EMPTY_TRANSCRIPT,
  dictationDraft,
  dictationErrorMessage,
  dictationLocale,
  levelFromVolume,
  pushLevel,
  reduceTranscript,
  transcriptText,
} from './dictation';

describe('reduceTranscript', () => {
  test('a partial result replaces the previous partial', () => {
    let t = reduceTranscript(EMPTY_TRANSCRIPT, { isFinal: false, transcript: 'hel' });
    t = reduceTranscript(t, { isFinal: false, transcript: 'hello wor' });
    expect(transcriptText(t)).toBe('hello wor');
  });

  test('Android segments: each final is kept and the next partial starts fresh', () => {
    let t = reduceTranscript(EMPTY_TRANSCRIPT, { isFinal: false, transcript: 'open the' });
    t = reduceTranscript(t, { isFinal: true, transcript: 'open the file' });
    t = reduceTranscript(t, { isFinal: false, transcript: 'and fix' });
    expect(transcriptText(t)).toBe('open the file and fix');
    t = reduceTranscript(t, { isFinal: true, transcript: 'and fix the bug' });
    expect(transcriptText(t)).toBe('open the file and fix the bug');
  });

  test('iOS 18 segments arrive with a leading space; words are joined by one space', () => {
    let t = reduceTranscript(EMPTY_TRANSCRIPT, { isFinal: true, transcript: 'First part.' });
    t = reduceTranscript(t, { isFinal: false, transcript: ' Second' });
    t = reduceTranscript(t, { isFinal: true, transcript: ' Second part.' });
    expect(transcriptText(t)).toBe('First part. Second part.');
  });

  test('an empty final (iOS end marker) commits the pending partial instead of dropping it', () => {
    let t = reduceTranscript(EMPTY_TRANSCRIPT, { isFinal: false, transcript: 'keep me' });
    t = reduceTranscript(t, { isFinal: true, transcript: '' });
    expect(transcriptText(t)).toBe('keep me');
    expect(t.interim).toBe('');
  });

  test('iOS < 18 cumulative partials end in one cumulative final', () => {
    let t = reduceTranscript(EMPTY_TRANSCRIPT, { isFinal: false, transcript: 'one' });
    t = reduceTranscript(t, { isFinal: false, transcript: 'one two' });
    t = reduceTranscript(t, { isFinal: true, transcript: 'One two.' });
    expect(transcriptText(t)).toBe('One two.');
  });
});

describe('dictationDraft', () => {
  test('an empty draft takes the transcript as is', () => {
    expect(dictationDraft('', 'hello')).toBe('hello');
  });

  test('a space separates the transcript from typed text', () => {
    expect(dictationDraft('Fix', 'the login bug')).toBe('Fix the login bug');
  });

  test('no extra space after existing whitespace or a newline', () => {
    expect(dictationDraft('Fix ', 'it')).toBe('Fix it');
    expect(dictationDraft('Line one\n', 'two')).toBe('Line one\ntwo');
  });

  test('no transcript leaves the draft untouched', () => {
    expect(dictationDraft('Fix', '')).toBe('Fix');
    expect(dictationDraft('Fix', '   ')).toBe('Fix');
  });
});

describe('levelFromVolume', () => {
  test('silence (<= 0) is 0', () => {
    expect(levelFromVolume(-2)).toBe(0);
    expect(levelFromVolume(0)).toBe(0);
  });

  test('10 and above is full', () => {
    expect(levelFromVolume(10)).toBe(1);
    expect(levelFromVolume(14)).toBe(1);
  });

  test('quiet speech still moves the bars visibly', () => {
    expect(levelFromVolume(2)).toBeGreaterThan(0.4);
    expect(levelFromVolume(5)).toBeLessThan(1);
  });

  test('NaN is 0', () => {
    expect(levelFromVolume(Number.NaN)).toBe(0);
  });
});

describe('pushLevel', () => {
  test('keeps the newest DICTATION_BAR_COUNT samples, newest last', () => {
    let h: number[] = [];
    for (let i = 0; i < DICTATION_BAR_COUNT + 5; i++) h = pushLevel(h, i);
    expect(h.length).toBe(DICTATION_BAR_COUNT);
    expect(h[h.length - 1]).toBe(DICTATION_BAR_COUNT + 4);
    expect(h[0]).toBe(5);
  });
});

describe('dictationLocale', () => {
  test('normalises an underscore locale', () => {
    expect(dictationLocale('en_GB')).toBe('en-GB');
  });

  test('drops unicode extensions', () => {
    expect(dictationLocale('de-DE-u-co-phonebk')).toBe('de-DE');
  });

  test('keeps a language-only tag', () => {
    expect(dictationLocale('fr')).toBe('fr');
  });

  test('falls back to en-US for missing or undetermined', () => {
    expect(dictationLocale(undefined)).toBe('en-US');
    expect(dictationLocale('und')).toBe('en-US');
    expect(dictationLocale('')).toBe('en-US');
  });
});

describe('dictationErrorMessage', () => {
  test('user-initiated or empty outcomes are silent', () => {
    expect(dictationErrorMessage('aborted')).toBeNull();
    expect(dictationErrorMessage('no-speech')).toBeNull();
    expect(dictationErrorMessage('speech-timeout')).toBeNull();
  });

  test('a denied permission says where to fix it', () => {
    expect(dictationErrorMessage('not-allowed')).toContain('Settings');
  });

  test('every other code gets a message', () => {
    for (const code of [
      'network',
      'audio-capture',
      'busy',
      'service-not-allowed',
      'language-not-supported',
      'unknown',
      'client',
      'interrupted',
    ]) {
      expect(dictationErrorMessage(code)).toBeString();
    }
  });
});
