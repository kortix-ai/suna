import { beforeEach, describe, expect, test } from 'bun:test';

import { useCarriedDraftStore } from './session-composer-handoff-store';

/**
 * The boot shell refuses a second message while the first is still starting,
 * and the composer's own recovery puts the text back in the SHELL's editor —
 * which the crossfade into `SessionChat` unmounts. This store is what carries
 * the draft across that replacement, so the toast's promise ("kept in the
 * composer") is true for the whole 19-25 s boot rather than only until it ends.
 */
describe('useCarriedDraftStore', () => {
  beforeEach(() => {
    useCarriedDraftStore.setState({ draftBySession: {} });
  });

  test('a carried draft is handed to the session that was typed into', () => {
    useCarriedDraftStore.getState().carryDraft('S1', 'use Tailwind', []);

    expect(useCarriedDraftStore.getState().draftBySession.S2).toBeUndefined();
    expect(useCarriedDraftStore.getState().draftBySession.S1).toMatchObject({
      text: 'use Tailwind',
      files: [],
    });
  });

  test('clearing is what stops a later remount ghosting the text back', () => {
    // A tab switch or a panel toggle remounts `SessionChat`. A draft held for
    // ever would reappear in an editor the user had already emptied.
    useCarriedDraftStore.getState().carryDraft('S1', 'use Tailwind', []);
    useCarriedDraftStore.getState().clearCarriedDraft('S1');

    expect(useCarriedDraftStore.getState().draftBySession.S1).toBeUndefined();
    // Clearing a session that carries nothing is a no-op, not a throw.
    expect(() => useCarriedDraftStore.getState().clearCarriedDraft('S1')).not.toThrow();
  });

  test('a second refusal replaces the first and carries a new id', () => {
    // The user edits the refused text and presses Enter again — the newer text
    // is the one that must arrive, under an id the composer has not applied.
    useCarriedDraftStore.getState().carryDraft('S1', 'use Tailwind', []);
    const first = useCarriedDraftStore.getState().draftBySession.S1;
    useCarriedDraftStore.getState().carryDraft('S1', 'use Tailwind v4', []);
    const second = useCarriedDraftStore.getState().draftBySession.S1;

    expect(second.text).toBe('use Tailwind v4');
    expect(second.id).toBeGreaterThan(first.id);
  });

  test('attachments ride along with the text', () => {
    const file = { id: 'f1', name: 'a.png' } as never;
    useCarriedDraftStore.getState().carryDraft('S1', 'look at this', [file]);

    expect(useCarriedDraftStore.getState().draftBySession.S1.files).toEqual([file]);
  });
});
