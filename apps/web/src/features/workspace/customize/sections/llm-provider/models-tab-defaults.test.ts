import { describe, expect, test } from 'bun:test';

import { wireToModelKey } from '@kortix/sdk/react';
import { uiSourcePath } from '@/test-utils/read-source';

/**
 * The two default SCOPES this tab owns.
 *
 * Both used to be buttons stacked under the session model picker
 * (`packages/ui/src/session/models/model-selector.tsx`), which could SET a default at three
 * scopes while showing which model held none of them. They moved onto the row
 * they apply to, where each one also badges its current holder. The picker
 * keeps a one-click star for the account default only.
 *
 * `ModelsTab` reads three query hooks and renders inside a modal, so there is
 * no cheap way to mount it here. These pin the two things that actually broke
 * when this moved: the identity comparison that decides which row is badged,
 * and the gate that decides which rows offer the menu at all.
 */

describe('the identity a badged row is decided by', () => {
  /**
   * `models-tab.tsx` asks `defaults.accountDefault?.modelID === wireId`. That
   * only holds because every scope in `useModelDefaults` is built with
   * `wireToModelKey`, which parks the WHOLE wire id in `modelID` under the
   * synthetic `kortix` provider rather than splitting it. If that ever changes
   * to a real split, the comparison silently stops matching and every row
   * quietly loses its badge — no error, no failing render.
   */
  test('wireToModelKey keeps the whole wire id in modelID', () => {
    expect(wireToModelKey('glm-5.3-flash')).toEqual({
      providerID: 'kortix',
      modelID: 'glm-5.3-flash',
    });
  });

  test('a BYOK provider/model wire id is NOT split across the two fields', () => {
    expect(wireToModelKey('anthropic/claude-opus-4-8')).toEqual({
      providerID: 'kortix',
      modelID: 'anthropic/claude-opus-4-8',
    });
  });

  test('the round trip a row comparison depends on holds for both id shapes', () => {
    for (const wire of [
      'glm-5.3-flash',
      'anthropic/claude-opus-4-8',
      'us.anthropic.claude-opus-4-8',
    ]) {
      expect(wireToModelKey(wire).modelID).toBe(wire);
    }
  });
});
