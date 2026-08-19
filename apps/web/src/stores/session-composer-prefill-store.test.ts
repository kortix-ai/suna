import { describe, expect, test } from 'bun:test';
import { useSessionComposerPrefillStore } from './session-composer-prefill-store';

describe('session composer prefill (W12)', () => {
  test('scoped per session, id bumps on every set', () => {
    const s = useSessionComposerPrefillStore.getState();
    s.setPrefill('s1', 'In report.pdf, ');
    s.setPrefill('s2', 'In deck.pptx, ');
    const first = useSessionComposerPrefillStore.getState().prefillBySession['s1'];
    expect(first?.text).toBe('In report.pdf, ');
    expect(typeof first?.id).toBe('number');

    useSessionComposerPrefillStore.getState().setPrefill('s1', 'In data.csv, ');
    const second = useSessionComposerPrefillStore.getState().prefillBySession['s1'];
    expect(second?.text).toBe('In data.csv, ');
    // ids are monotonic within a page lifetime, not asserted as literal values —
    // the counter is module-scope and shared across every session/test.
    expect((second?.id ?? 0) > (first?.id ?? 0)).toBe(true);

    expect(useSessionComposerPrefillStore.getState().prefillBySession['s2']?.text).toBe(
      'In deck.pptx, ',
    );
  });

  // ─── IMPORTANT 5 — held-forever prefill ghosts back in on a later remount
  // (tab switch, panel toggle) unless the session clears it once delivered. ──
  test('set → clear → gone', () => {
    const s = useSessionComposerPrefillStore.getState();
    s.setPrefill('s1', 'In report.pdf, ');
    expect(useSessionComposerPrefillStore.getState().prefillBySession['s1']).toBeDefined();
    s.clearPrefill('s1');
    expect(useSessionComposerPrefillStore.getState().prefillBySession['s1']).toBeUndefined();
  });

  test('clearing one session never touches another', () => {
    const s = useSessionComposerPrefillStore.getState();
    s.setPrefill('s1', 'In report.pdf, ');
    s.setPrefill('s2', 'In deck.pptx, ');
    s.clearPrefill('s2');
    expect(useSessionComposerPrefillStore.getState().prefillBySession['s1']?.text).toBe(
      'In report.pdf, ',
    );
    expect(useSessionComposerPrefillStore.getState().prefillBySession['s2']).toBeUndefined();
  });
});

// ─── "Add context" (Task 5) — same held/id-keyed shape as the prefill above,
// its own record. ────────────────────────────────────────────────────────
describe('session composer attach request (Task 5)', () => {
  test('scoped per session, id bumps on every request', () => {
    const s = useSessionComposerPrefillStore.getState();
    s.requestAttach('a1');
    s.requestAttach('a2');
    const first = useSessionComposerPrefillStore.getState().attachRequestBySession['a1'];
    expect(typeof first).toBe('number');

    useSessionComposerPrefillStore.getState().requestAttach('a1');
    const second = useSessionComposerPrefillStore.getState().attachRequestBySession['a1'];
    // Monotonic within a page lifetime, not asserted as a literal value — the
    // counter is module-scope and shared with the prefill store above.
    expect((second ?? 0) > (first ?? 0)).toBe(true);

    expect(useSessionComposerPrefillStore.getState().attachRequestBySession['a2']).toBeDefined();
  });

  test('request → clear → gone', () => {
    const s = useSessionComposerPrefillStore.getState();
    s.requestAttach('a1');
    expect(useSessionComposerPrefillStore.getState().attachRequestBySession['a1']).toBeDefined();
    s.clearAttachRequest('a1');
    expect(useSessionComposerPrefillStore.getState().attachRequestBySession['a1']).toBeUndefined();
  });

  test('clearing one session never touches another', () => {
    const s = useSessionComposerPrefillStore.getState();
    s.requestAttach('a1');
    s.requestAttach('a2');
    s.clearAttachRequest('a2');
    expect(useSessionComposerPrefillStore.getState().attachRequestBySession['a1']).toBeDefined();
    expect(useSessionComposerPrefillStore.getState().attachRequestBySession['a2']).toBeUndefined();
  });

  test('an attach request never touches the prefill record for the same session, or vice versa', () => {
    const s = useSessionComposerPrefillStore.getState();
    s.setPrefill('a3', 'In report.pdf, ');
    s.requestAttach('a3');
    expect(useSessionComposerPrefillStore.getState().prefillBySession['a3']?.text).toBe(
      'In report.pdf, ',
    );
    expect(useSessionComposerPrefillStore.getState().attachRequestBySession['a3']).toBeDefined();

    s.clearPrefill('a3');
    expect(useSessionComposerPrefillStore.getState().prefillBySession['a3']).toBeUndefined();
    expect(useSessionComposerPrefillStore.getState().attachRequestBySession['a3']).toBeDefined();
  });
});
