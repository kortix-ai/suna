import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  resolveProjectSessionCompactionId,
  resolveProjectSessionRuntimeIdentity,
} from './session-compaction';

const sessionChatSource = readFileSync(
  fileURLToPath(new URL('./session-chat.tsx', import.meta.url)),
  'utf8',
);
const sessionHeaderSource = readFileSync(
  fileURLToPath(new URL('./header/session-site-header.tsx', import.meta.url)),
  'utf8',
);
const commandPaletteSource = readFileSync(
  fileURLToPath(new URL('../workspace/command-palette.tsx', import.meta.url)),
  'utf8',
);

describe('resolveProjectSessionCompactionId', () => {
  test('returns the canonical OpenCode id for an OpenCode project session', () => {
    expect(
      resolveProjectSessionCompactionId({
        metadata: {},
        opencode_session_id: 'ses_opencode',
      }),
    ).toBe('ses_opencode');
  });

  test('returns the canonical conversation id for every Pi runtime metadata projection', () => {
    for (const metadata of [
      { sandbox_slug: 'pi-worker' },
      { pi_worker_boot: true },
      { runtimeArtifact: { runtimeProfile: 'pi-worker' } },
      { runtimeArtifact: { sandboxSlug: 'pi-worker' } },
    ]) {
      expect(
        resolveProjectSessionCompactionId({
          metadata,
          opencode_session_id: 'ses_pi',
        }),
      ).toBe('ses_pi');
    }
  });

  test('returns null until the project session has a canonical OpenCode id', () => {
    expect(resolveProjectSessionCompactionId(undefined)).toBeNull();
    expect(
      resolveProjectSessionCompactionId({
        metadata: {},
        opencode_session_id: null,
      }),
    ).toBeNull();
  });
});

describe('resolveProjectSessionRuntimeIdentity', () => {
  test('stays fail-closed while an unknown project session resolves to Pi', () => {
    expect(
      [
        undefined,
        {
          metadata: { pi_worker_boot: true },
          opencode_session_id: 'ses_pi',
        },
      ].map(resolveProjectSessionRuntimeIdentity),
    ).toEqual(['unknown', 'pi-worker']);
  });

  test('opens history mutations only after an unknown project session resolves to OpenCode', () => {
    expect(
      [
        undefined,
        {
          metadata: {},
          opencode_session_id: 'ses_opencode',
        },
      ].map(resolveProjectSessionRuntimeIdentity),
    ).toEqual(['unknown', 'opencode']);
  });
});

describe('Pi session compaction controls', () => {
  test('gates the composer action and modal with the resolved compaction id', () => {
    expect(sessionChatSource).toContain(
      'onCompactClick={compactSessionId ? handleCompactClick : undefined}',
    );
    expect(sessionChatSource).toContain('<CompactModal\n            sessionId={compactSessionId}');
    expect(sessionChatSource).toContain('{compactSessionId && (');
  });

  test('gates the header action and modal with the resolved compaction id', () => {
    expect(sessionHeaderSource).toContain('{compactSessionId && (');
    expect(sessionHeaderSource).toContain('Summarize conversation');
    expect(sessionHeaderSource).toContain('<CompactModal\n          sessionId={compactSessionId}');
  });

  test('gates Cmd+K and targets only the canonical OpenCode id', () => {
    expect(commandPaletteSource).toContain(
      'const compactSessionId = projectId\n    ? resolveProjectSessionCompactionId(currentProjectSession)\n    : currentSessionId;',
    );
    expect(commandPaletteSource).toContain(
      "if (item.id === 'compact-session' && !compactSessionId) continue;",
    );
    const modal = commandPaletteSource.split('<CompactModal')[1]?.split('/>')[0];
    expect(modal).toContain('sessionId={compactSessionId}');
    expect(modal).not.toContain('sessionId={currentSessionId}');
  });
});

describe('Pi session rewind controls', () => {
  test('disables edit-from-here and omits the composer restore control until history mutations are safe', () => {
    expect(sessionChatSource).toContain("projectSessionRuntimeIdentity === 'opencode'");
    expect(sessionChatSource).toContain('const composerRewind =\n    historyMutationsEnabled &&');
    expect(sessionChatSource).toContain(
      'editingText={\n                                    historyMutationsEnabled &&',
    );
    expect(sessionChatSource).toContain(
      'onEditSend={historyMutationsEnabled ? handleEditSend : undefined}',
    );
    expect(sessionChatSource).toContain(
      'rewindDisabled={\n                                    !historyMutationsEnabled ||',
    );
  });
});

describe('Pi command palette configuration controls', () => {
  test('gates configuration suggestions, search results, pages, and handlers by resolved runtime', () => {
    expect(commandPaletteSource).toContain(
      "!projectId || resolveProjectSessionRuntimeIdentity(currentProjectSession) === 'opencode'",
    );
    expect(commandPaletteSource).toContain('{sessionConfigurationEnabled && (');
    expect(commandPaletteSource).toContain('if (sessionConfigurationEnabled) {');
    expect(commandPaletteSource).toContain(
      "{page === 'agents' && sessionConfigurationEnabled && (",
    );
    expect(commandPaletteSource).toContain(
      "{page === 'models' && sessionConfigurationEnabled && (",
    );
    expect(commandPaletteSource).toContain(
      'if (!currentSessionId || !sessionConfigurationEnabled) return;',
    );
    expect(commandPaletteSource).toContain(
      'if (!currentAgent || !sessionConfigurationEnabled) return;',
    );
  });
});
