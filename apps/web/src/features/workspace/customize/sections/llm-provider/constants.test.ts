import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SECRET_VISIBILITY,
  SECRET_VISIBILITY_COPY,
} from './constants';

// BYOK gateway-blindness fix, layer 1: the provider-key connect form's
// visibility toggle must default to SHARED, and its copy must describe what
// actually happens post-fix — a private key only ever routes the SAVER's own
// sessions, never anyone else's, and it no longer silently dies the way it
// did before the gateway learned to fall back to it (2026-07-07 incident).

describe('provider-key visibility default + copy', () => {
  test('defaults to shared, not private', () => {
    expect(DEFAULT_SECRET_VISIBILITY).toBe('shared');
  });

  test('shared copy says it is usable by the whole workspace', () => {
    expect(SECRET_VISIBILITY_COPY.shared.label).toBe('Shared');
    expect(SECRET_VISIBILITY_COPY.shared.description.toLowerCase()).toContain('workspace');
  });

  test('private copy says it only routes the saver\'s own sessions (not "will not route" — the old, now-fixed behavior)', () => {
    expect(SECRET_VISIBILITY_COPY.private.label).toBe('Only me');
    expect(SECRET_VISIBILITY_COPY.private.description.toLowerCase()).toContain('your own sessions');
    expect(SECRET_VISIBILITY_COPY.private.description.toLowerCase()).not.toContain('not');
  });

  test('exactly two options — shared and private, nothing else to confuse the default', () => {
    expect(Object.keys(SECRET_VISIBILITY_COPY).sort()).toEqual(['private', 'shared']);
  });
});
