import { describe, expect, test } from 'bun:test';

import { sessionsNeedingRehydrate } from './rehydrate-targets';

describe('sessionsNeedingRehydrate', () => {
  /**
   * The runtime stream is per (projectId, sessionId): `connectSessionStream`
   * opens one connection for one session. A gap or resync on THIS stream means
   * this tab lost frames for THIS session — and only this session. Every other
   * open session runs its OWN stream and detects its OWN gaps.
   *
   * The rule this replaced re-read EVERY held transcript on any one stream's
   * resync ("re-read every transcript this tab is holding"). Against the tiny
   * 2,000-frame daemon replay ring, a routine ~30-60s reconnect resyncs
   * (`gap-too-old`) constantly, and each resync dragged a multi-MB `?limit=50`
   * tail page down for every background session no gap had touched — the
   * "why is it hitting /messages so often, for two sessions at once" storm.
   * Scope the repair to the stream's own session.
   */
  test("a gap repairs only the stream's own session", () => {
    expect(sessionsNeedingRehydrate('ses_a')).toEqual(['ses_a']);
  });

  test('no session id, nothing to repair', () => {
    expect(sessionsNeedingRehydrate('')).toEqual([]);
  });
});
