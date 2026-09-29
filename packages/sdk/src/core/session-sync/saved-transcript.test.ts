import { describe, expect, test } from 'bun:test';
import {
  type SavedTranscriptInput,
  isEmptyConversation,
  resolveSavedTranscript,
  savedCopyEmptyRoot,
} from './saved-transcript';
import type { SessionTranscriptSyncEnvelope } from '../rest/projects-client/sessions';

const base: SavedTranscriptInput = {
  enabled: true,
  hasMessages: false,
  history: 'off',
  mirror: 'idle',
  root: 'known',
};

describe('resolveSavedTranscript', () => {
  test('messages on screen are shown, whatever else is still resolving', () => {
    expect(resolveSavedTranscript({ ...base, hasMessages: true })).toBe('shown');
    expect(
      resolveSavedTranscript({ ...base, hasMessages: true, enabled: false, root: 'unknown' }),
    ).toBe('shown');
    expect(resolveSavedTranscript({ ...base, hasMessages: true, history: 'absent' })).toBe('shown');
  });

  test('a hook that has not started yet cannot rule a saved copy out', () => {
    expect(resolveSavedTranscript({ ...base, enabled: false, root: 'unknown' })).toBe('loading');
    expect(resolveSavedTranscript({ ...base, enabled: false, mirror: 'absent' })).toBe('loading');
  });

  test('with saved history on, the history read decides', () => {
    expect(resolveSavedTranscript({ ...base, history: 'loading' })).toBe('loading');
    expect(resolveSavedTranscript({ ...base, history: 'absent' })).toBe('none');
    expect(resolveSavedTranscript({ ...base, history: 'present', mirror: 'loading' })).toBe(
      'loading',
    );
    // The read found a copy, but the paint refused it (another root).
    expect(resolveSavedTranscript({ ...base, history: 'present', mirror: 'absent' })).toBe('none');
  });

  test('without saved history, the mirror paint decides once the root is known', () => {
    expect(resolveSavedTranscript({ ...base, mirror: 'idle' })).toBe('loading');
    expect(resolveSavedTranscript({ ...base, mirror: 'loading' })).toBe('loading');
    expect(resolveSavedTranscript({ ...base, mirror: 'absent' })).toBe('none');
  });

  test('a root still resolving waits; a root nothing can supply rules the copy out', () => {
    expect(resolveSavedTranscript({ ...base, root: 'pending' })).toBe('loading');
    expect(resolveSavedTranscript({ ...base, root: 'unknown' })).toBe('none');
    expect(resolveSavedTranscript({ ...base, root: 'unknown', history: 'loading' })).toBe(
      'loading',
    );
  });

  test('a copy that proves the conversation empty waits for the turn record: the next surface is the composer or the boot screen', () => {
    // The two reads answer independently. Declaring `none` first would paint
    // the boot screen for the moment until the turn record lands.
    expect(resolveSavedTranscript({ ...base, history: 'absent', emptyAwaitingTurnRead: true })).toBe('loading');
    expect(resolveSavedTranscript({ ...base, history: 'absent', emptyAwaitingTurnRead: false })).toBe('none');
    expect(resolveSavedTranscript({ ...base, hasMessages: true, emptyAwaitingTurnRead: true })).toBe('shown');
  });

  test('invariants hold for every input', () => {
    const histories = ['off', 'loading', 'present', 'absent'] as const;
    const mirrors = ['idle', 'loading', 'painted', 'absent'] as const;
    const roots = ['known', 'pending', 'unknown'] as const;
    let cases = 0;
    for (const enabled of [true, false])
      for (const hasMessages of [true, false])
        for (const history of histories)
          for (const mirror of mirrors)
            for (const root of roots) {
              const input = { enabled, hasMessages, history, mirror, root };
              const answer = resolveSavedTranscript(input);
              cases++;
              // `shown` exactly when there is something to show.
              expect(answer === 'shown').toBe(hasMessages);
              // Nothing is ruled out before the hook runs.
              if (!enabled && !hasMessages) expect(answer).toBe('loading');
              // A read still in flight never rules the copy out.
              if (enabled && !hasMessages && history === 'loading') expect(answer).toBe('loading');
              // A history read that found nothing always rules it out.
              if (enabled && !hasMessages && history === 'absent') expect(answer).toBe('none');
              // A root still resolving is "not yet", never "no".
              if (enabled && !hasMessages && root === 'pending' && history !== 'absent')
                expect(answer).toBe('loading');
            }
    expect(cases).toBe(2 * 2 * 4 * 4 * 3);
  });
});

describe('isEmptyConversation', () => {
  // A session whose saved copy proves it empty has nothing to wait for, so it
  // opens on its composer instead of a boot screen. The proof is the server's:
  // a complete read of the runtime found no messages.
  const ROOT = 'ses_root';
  const empty = {
    savedEmptyRoot: ROOT,
    rootSessionId: ROOT,
    turnRead: true,
    hasEndedTurn: false,
    hasOpenOrQueuedTurn: false,
  };

  test('a saved copy that proves this root empty, no turn ever, nothing queued: empty', () => {
    expect(isEmptyConversation(empty)).toBe(true);
  });

  test('no saved copy is not evidence: a session may have run turns no record kept', () => {
    // The turn ledger exists since 2026-08-17 and its writes are best-effort,
    // so "no turn ever ended" is also what an older session with history says.
    expect(isEmptyConversation({ ...empty, savedEmptyRoot: null })).toBe(false);
  });

  test('an empty copy of another root says nothing about this one', () => {
    expect(isEmptyConversation({ ...empty, rootSessionId: 'ses_repinned' })).toBe(false);
    expect(isEmptyConversation({ ...empty, rootSessionId: '' })).toBe(false);
  });

  test('a turn that ended outranks the saved copy: the copy is older than it', () => {
    expect(isEmptyConversation({ ...empty, hasEndedTurn: true })).toBe(false);
  });

  test('an open or queued turn is a conversation starting', () => {
    expect(isEmptyConversation({ ...empty, hasOpenOrQueuedTurn: true })).toBe(false);
  });

  test('an unanswered turn read is an unknown, never an empty', () => {
    expect(isEmptyConversation({ ...empty, turnRead: false })).toBe(false);
  });
});

describe('savedCopyEmptyRoot', () => {
  // The server's proof that a conversation is empty: a complete, available
  // saved window that counts zero messages, named by the root it was read from.
  const window = (fields: Partial<SessionTranscriptSyncEnvelope> = {}) =>
    ({
      available: true,
      reason: null,
      source: 'mirror',
      complete: true,
      captured_at: '2026-09-28T00:00:00Z',
      opencode_session_id: 'ses_root',
      message_count: 0,
      total: 0,
      messages: [],
      ...fields,
    }) as SessionTranscriptSyncEnvelope;

  test('a complete, available window that counts zero names its root', () => {
    expect(savedCopyEmptyRoot(window())).toBe('ses_root');
  });

  test('anything short of that proves nothing', () => {
    expect(savedCopyEmptyRoot(null)).toBeNull();
    expect(savedCopyEmptyRoot(undefined)).toBeNull();
    expect(savedCopyEmptyRoot(window({ complete: false }))).toBeNull();
    expect(savedCopyEmptyRoot(window({ available: false, source: 'none' }))).toBeNull();
    // An older API sends no total, and never an available empty window.
    expect(savedCopyEmptyRoot(window({ total: undefined }))).toBeNull();
    expect(savedCopyEmptyRoot(window({ total: 1 }))).toBeNull();
    expect(savedCopyEmptyRoot(window({ opencode_session_id: null }))).toBeNull();
    expect(
      savedCopyEmptyRoot(
        window({ messages: [{ info: { id: 'msg_1' }, parts: [] }] as SessionTranscriptSyncEnvelope['messages'] }),
      ),
    ).toBeNull();
  });

  test('both rules are public, so every host decides an empty conversation the same way', async () => {
    const sdk = await import('../../index');
    expect(sdk.savedCopyEmptyRoot).toBe(savedCopyEmptyRoot);
    expect(sdk.isEmptyConversation).toBe(isEmptyConversation);
  });
});
