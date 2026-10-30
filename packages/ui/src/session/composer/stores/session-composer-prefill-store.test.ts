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

  test('an old editor acknowledgement cannot clear a newer queued edit', () => {
    const store = useSessionComposerPrefillStore.getState();
    store.setPrefill('handoff', 'First edit');
    const first = useSessionComposerPrefillStore.getState().prefillBySession.handoff!;
    store.setPrefill('handoff', 'Second edit');
    store.clearPrefill('handoff', first.id);
    const current = useSessionComposerPrefillStore.getState().prefillBySession.handoff!;
    expect(current.text).toBe('Second edit');
    store.clearPrefill('handoff', current.id);
    expect(useSessionComposerPrefillStore.getState().prefillBySession.handoff).toBeUndefined();
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

describe('desktop Quick Entry into a picked session', () => {
  test('a submit prefill replaces the draft and asks the composer to send', () => {
    useSessionComposerPrefillStore.getState().setPrefill('qe1', 'Also update the changelog', undefined, 'replace', {
      submit: true,
    });
    expect(useSessionComposerPrefillStore.getState().prefillBySession['qe1']).toMatchObject({
      text: 'Also update the changelog',
      mode: 'replace',
      submit: true,
    });
  });

  test('every other prefill only fills the box', () => {
    useSessionComposerPrefillStore.getState().setPrefill('qe2', 'In report.pdf, ');
    expect(useSessionComposerPrefillStore.getState().prefillBySession['qe2']?.submit).toBeUndefined();
  });
});

describe('movePrefill', () => {
  test('re-keys a route-id prefill onto the chat id, keeping text, id and submit', () => {
    const store = useSessionComposerPrefillStore.getState();
    store.setPrefill('kortix-route-id', 'Ship it', undefined, 'replace', { submit: true });
    const before = useSessionComposerPrefillStore.getState().prefillBySession['kortix-route-id'];
    useSessionComposerPrefillStore.getState().movePrefill('kortix-route-id', 'ses_runtime');
    const state = useSessionComposerPrefillStore.getState().prefillBySession;
    expect(state['kortix-route-id']).toBeUndefined();
    expect(state['ses_runtime']).toEqual(before);
  });

  test('is a no-op with nothing to move, or when both ids are the same', () => {
    const store = useSessionComposerPrefillStore.getState();
    store.movePrefill('nothing-here', 'ses_x');
    expect(useSessionComposerPrefillStore.getState().prefillBySession['ses_x']).toBeUndefined();
    store.setPrefill('same', 'Keep me');
    useSessionComposerPrefillStore.getState().movePrefill('same', 'same');
    expect(useSessionComposerPrefillStore.getState().prefillBySession['same']?.text).toBe('Keep me');
  });
});
