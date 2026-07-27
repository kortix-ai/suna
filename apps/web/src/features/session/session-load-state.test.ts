import { describe, expect, test } from 'bun:test';

import {
  canMountSessionChat,
  canShowSessionChat,
  findInitialSessionPin,
} from './session-load-state';

describe('session load state', () => {
  test('uses the authorized project-session list as an initial transcript pin', () => {
    expect(
      findInitialSessionPin(
        [
          { session_id: 'session-a', opencode_session_id: 'ses_a' },
          { session_id: 'session-b', opencode_session_id: 'ses_b' },
        ],
        'session-b',
      ),
    ).toBe('ses_b');
    expect(findInitialSessionPin(undefined, 'session-b')).toBeNull();
  });

  test('mounts cached transcript content before the runtime switch completes', () => {
    expect(
      canMountSessionChat({
        switched: false,
        opencodeSessionId: 'opencode-cached',
      }),
    ).toBe(true);
  });

  test('keeps a session without a known transcript pin on the boot surface', () => {
    expect(
      canMountSessionChat({
        switched: false,
        opencodeSessionId: null,
      }),
    ).toBe(false);
  });

  test('shows the chat as soon as a transcript pin is available', () => {
    expect(
      canShowSessionChat({
        chatSessionId: 'opencode-cached',
        runtimeError: null,
        runtimeBootError: null,
      }),
    ).toBe(true);
  });
});
