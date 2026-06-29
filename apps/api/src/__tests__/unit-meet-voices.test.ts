/**
 * Meet voice catalog — the predefined ElevenLabs voices a project can pick from.
 * Pure catalog integrity + lookup (DB-backed resolve/set are covered by the
 * route layer). Guards against dupe slugs, missing ElevenLabs ids, and a default
 * that isn't actually in the list.
 */
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_MEET_BOT_NAME,
  DEFAULT_MEET_VOICE,
  MEET_VOICES,
  SILENT_MP3_B64,
  deriveWakeWord,
  getMeetVoice,
  isMeetVoice,
} from '../channels/meet-voices';

describe('MEET_VOICES catalog', () => {
  test('every voice has a unique slug + name + a non-empty ElevenLabs id', () => {
    const ids = MEET_VOICES.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(MEET_VOICES.length).toBeGreaterThanOrEqual(4);
    for (const v of MEET_VOICES) {
      expect(v.id).toMatch(/^[a-z0-9-]+$/);
      expect(v.name.length).toBeGreaterThan(0);
      expect(v.desc.length).toBeGreaterThan(0);
      expect(v.elevenVoiceId.length).toBeGreaterThan(0);
    }
  });

  test('the default voice exists in the catalog', () => {
    expect(isMeetVoice(DEFAULT_MEET_VOICE)).toBe(true);
  });

  test('the silent placeholder mp3 is a real base64 mp3 (ID3/MPEG header)', () => {
    const head = Buffer.from(SILENT_MP3_B64, 'base64');
    // "ID3" tag or an MPEG frame sync (0xFF 0xFB/0xF3/0xF2).
    const isId3 = head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33;
    const isMpeg = head[0] === 0xff && (head[1] & 0xe0) === 0xe0;
    expect(isId3 || isMpeg).toBe(true);
  });
});

describe('bot name + wake word', () => {
  test('default bot name is Kortix Notetaker', () => {
    expect(DEFAULT_MEET_BOT_NAME).toBe('Kortix Notetaker');
  });

  test('wake word is the first word of the bot name, lowercased', () => {
    expect(deriveWakeWord('Kortix Notetaker')).toBe('kortix');
    expect(deriveWakeWord('Acme Notetaker')).toBe('acme');
    expect(deriveWakeWord('Jarvis')).toBe('jarvis');
  });

  test('empty / whitespace name falls back to kortix', () => {
    expect(deriveWakeWord('   ')).toBe('kortix');
    expect(deriveWakeWord('')).toBe('kortix');
  });
});

describe('getMeetVoice / isMeetVoice', () => {
  test('resolves a known slug', () => {
    expect(getMeetVoice('adam').id).toBe('adam');
    expect(isMeetVoice('adam')).toBe(true);
  });

  test('falls back to the default for unknown/empty', () => {
    expect(getMeetVoice('nope').id).toBe(DEFAULT_MEET_VOICE);
    expect(getMeetVoice(null).id).toBe(DEFAULT_MEET_VOICE);
    expect(getMeetVoice(undefined).id).toBe(DEFAULT_MEET_VOICE);
    expect(isMeetVoice('nope')).toBe(false);
  });
});
