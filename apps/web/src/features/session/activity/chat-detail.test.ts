import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CHAT_DETAIL,
  densityForDetail,
  getChatDetail,
  oppositeDetail,
  parseChatDetail,
  setChatDetail,
} from './chat-detail';

const source = readFileSync(fileURLToPath(new URL('./chat-detail.tsx', import.meta.url)), 'utf8');

describe('densityForDetail', () => {
  test('narrative is the folded reading — every adjacent run collapses', () => {
    expect(densityForDetail('narrative')).toBe('simple');
  });

  test('"show full history" maps to the per-kind step list, not to raw output', () => {
    // 'detailed' groups like-with-like and still humanizes each row. Full
    // history means every step is visible and in order — it does NOT mean
    // reverting to the raw `$ cd /workspace && …` wall this work removed.
    expect(densityForDetail('full')).toBe('detailed');
  });
});

describe('the default reading', () => {
  test('a reader who has never touched the toggle gets the folded reading', () => {
    // The resting state is the ask, the answer, the deliverable. The full log
    // is one click away for anyone who wants it — it is not what you land on.
    expect(DEFAULT_CHAT_DETAIL).toBe('narrative');
  });

  test('the default renders at simple density, so the transcript is folded at rest', () => {
    expect(densityForDetail(DEFAULT_CHAT_DETAIL)).toBe('simple');
  });

  test('server and pre-hydration client snapshots both start at the default', () => {
    // A localStorage read during render hydrates as a mismatch and flashes the
    // wrong transcript, so the stored choice is applied in an effect instead.
    expect(source).toContain('const getServerSnapshot = () => DEFAULT_CHAT_DETAIL');
    expect(source).toContain('let currentDetail: ChatDetail = DEFAULT_CHAT_DETAIL');
  });
});

describe('oppositeDetail', () => {
  test('flips between the two ends of the one control', () => {
    expect(oppositeDetail('full')).toBe('narrative');
    expect(oppositeDetail('narrative')).toBe('full');
  });
});

describe('parseChatDetail', () => {
  test('accepts the two known values', () => {
    expect(parseChatDetail('full')).toBe('full');
    expect(parseChatDetail('narrative')).toBe('narrative');
  });

  test('treats anything else as "no stored choice" rather than throwing', () => {
    // A stale or hand-edited localStorage value must fall back to the default,
    // never wedge the transcript into an unrenderable third state.
    for (const raw of [null, undefined, '', 'FULL', 'detailed', '{"detail":"full"}']) {
      expect(parseChatDetail(raw)).toBeNull();
    }
  });
});

describe('the store', () => {
  test('starts at the default and follows explicit changes', () => {
    expect(getChatDetail()).toBe(DEFAULT_CHAT_DETAIL);

    setChatDetail('narrative');
    expect(getChatDetail()).toBe('narrative');

    setChatDetail('full');
    expect(getChatDetail()).toBe('full');
  });

  test('survives a missing/blocked localStorage instead of throwing', () => {
    // No `window` here at all — the same path private mode and storage-disabled
    // browsers take. The knob must still work for the life of the tab.
    expect(() => setChatDetail('narrative')).not.toThrow();
    setChatDetail(DEFAULT_CHAT_DETAIL);
  });

  test('persists even when the chosen value equals the current default', () => {
    // Otherwise an explicit "keep showing everything" is indistinguishable from
    // never having chosen, and would silently flip if the default ever changes.
    const setter = source.slice(
      source.indexOf('export function setChatDetail'),
      source.indexOf('function applyStoredDetail'),
    );
    expect(setter.indexOf('setItem(STORAGE_KEY, next)')).toBeLessThan(
      setter.indexOf('if (next === currentDetail) return'),
    );
  });
});

describe('placement', () => {
  test('the knob is a module store, so no consumer can be outside a provider', () => {
    // The toggle lives in the session header, which mounts from both
    // `session-chat` and `instant-session-shell`. Under React context the
    // second shell rendered a menu item that silently did nothing and
    // mislabelled the current state.
    expect(source).not.toContain('createContext');
    expect(source).not.toContain('ChatDetailProvider');
    expect(source).toContain('useSyncExternalStore');
  });

  test('the ⌘/ shortcut is installed once for the app, not once per turn', () => {
    // A transcript mounts one consumer per turn; N listeners would toggle the
    // knob N times per keypress and land back where it started.
    expect(source).toContain("if (clientInitialized || typeof window === 'undefined') return");
    const listeners = source.match(/window\.addEventListener\('keydown'/g) ?? [];
    expect(listeners.length).toBe(1);
  });
});
