import { describe, expect, test } from 'bun:test';
import { HUMAN_SESSION_SURFACES, sessionCreateSurface } from './session-surface';

// KRTX-2914: a session created from the CLI was stamped `ui`, so analytics
// could not tell the CLI from the web app.
describe('sessionCreateSurface', () => {
  test('the self-reported client names the surface: cli and mobile; anything else is ui', () => {
    expect(sessionCreateSurface('cli/0.14.3')).toBe('cli');
    expect(sessionCreateSurface('cli/dev')).toBe('cli');
    expect(sessionCreateSurface('mobile/1.2.0')).toBe('mobile');
    expect(sessionCreateSurface('web/0.14.3')).toBe('ui');
    expect(sessionCreateSurface(undefined)).toBe('ui');
    expect(sessionCreateSurface('')).toBe('ui');
    // Only the exact surface names count: no prefix match, no other source.
    expect(sessionCreateSurface('cli-tool/1')).toBe('ui');
    expect(sessionCreateSurface('trigger:cron/1')).toBe('ui');
    expect(sessionCreateSurface('system:x/1')).toBe('ui');
  });

  test('every surface it returns is a human surface, so the origin policy treats them alike', () => {
    for (const header of ['cli/1', 'mobile/1', 'web/1', undefined]) {
      expect(HUMAN_SESSION_SURFACES.has(sessionCreateSurface(header))).toBe(true);
    }
  });
});
