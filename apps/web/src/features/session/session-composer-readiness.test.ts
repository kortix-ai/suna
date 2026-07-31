import { describe, expect, test } from 'bun:test';

import { sessionComposerReadiness } from './session-composer-readiness';

describe('sessionComposerReadiness', () => {
  test('a ready runtime leaves the composer alone', () => {
    expect(sessionComposerReadiness({ runtimeReady: true })).toEqual({ disabled: false });
  });

  test('locks the composer while the sandbox is still waking', () => {
    // The transcript is readable at this point — that is the whole feature — but
    // send() would post into a box that is not answering yet.
    expect(sessionComposerReadiness({ runtimeReady: false }).disabled).toBe(true);
  });

  test('says why it is locked instead of leaving a dead input', () => {
    const { placeholder } = sessionComposerReadiness({ runtimeReady: false });
    expect(placeholder).toBeTruthy();
    expect(placeholder).toMatch(/waking/i);
  });

  test('does not override the default placeholder once ready', () => {
    expect(sessionComposerReadiness({ runtimeReady: true }).placeholder).toBeUndefined();
  });
});
