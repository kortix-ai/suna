import { describe, expect, test } from 'bun:test';

import { SESSION_TAB_TITLE_MAX_NAME, sessionTabTitle, sessionTabTitleFromSession } from './session-tab-title';
import type { WorkspaceSession } from '@kortix/sdk';

const session = (over: Partial<WorkspaceSession> = {}) =>
  ({ session_id: 'bb9f9ed2-52bc-4db7-b41f-97656d6ff599', ...over }) as WorkspaceSession;

describe('sessionTabTitle', () => {
  test('a named session reads "<name> — Kortix"', () => {
    expect(sessionTabTitle('Build PRISM Analytics Console')).toBe(
      'Build PRISM Analytics Console — Kortix',
    );
  });

  test('the name leads, so a crowded tab strip truncates the app name first', () => {
    expect(sessionTabTitle('Build PRISM Analytics Console').startsWith('Build PRISM')).toBe(true);
  });

  test('an absent name is explicit, never blank and never a raw id', () => {
    for (const value of [null, undefined, '', '   ']) {
      const title = sessionTabTitle(value);
      expect(title).toBe('Session — Kortix');
      expect(title).not.toContain('bb9f9ed2');
    }
  });

  test('surrounding whitespace is trimmed', () => {
    expect(sessionTabTitle('  Simple Greeting Introduction  ')).toBe(
      'Simple Greeting Introduction — Kortix',
    );
  });

  test('newlines collapse to a single space so the tab stays one line', () => {
    expect(sessionTabTitle('Fix login\nbug')).toBe('Fix login bug — Kortix');
  });

  test('a very long name is elided, and the app name survives', () => {
    const title = sessionTabTitle('A'.repeat(200));
    expect(title.endsWith(' — Kortix')).toBe(true);
    expect(title).toContain('…');
    expect(title.slice(0, -' — Kortix'.length).length).toBe(SESSION_TAB_TITLE_MAX_NAME);
  });

  test('a name exactly at the cap is not elided', () => {
    const exact = 'A'.repeat(SESSION_TAB_TITLE_MAX_NAME);
    expect(sessionTabTitle(exact)).toBe(`${exact} — Kortix`);
    expect(sessionTabTitle(exact)).not.toContain('…');
  });
});

describe('sessionTabTitleFromSession', () => {
  test('a user rename (custom_name) wins over the server name', () => {
    expect(
      sessionTabTitleFromSession(session({ custom_name: 'My rename', name: 'Auto title' })),
    ).toBe('My rename — Kortix');
  });

  test('the server name wins over the legacy metadata name', () => {
    expect(
      sessionTabTitleFromSession(
        session({ name: 'Auto title', metadata: { session_name: 'Legacy' } }),
      ),
    ).toBe('Auto title — Kortix');
  });

  test('the legacy metadata name is still honoured', () => {
    expect(sessionTabTitleFromSession(session({ metadata: { session_name: 'Legacy' } }))).toBe(
      'Legacy — Kortix',
    );
  });

  test('an untitled session reuses the sidebar wording, and leaks neither branch nor id', () => {
    // Same string `getSessionDisplayTitle` gives the sidebar row, so the tab and
    // the list never disagree about what this session is called.
    const title = sessionTabTitleFromSession(session({ branch_name: 'jay-20-bb9f9ed2' }));
    expect(title).toBe('New session — Kortix');
    expect(title).not.toContain('bb9f9ed2');
    expect(title).not.toContain('jay-20');
  });

  test('a session that could not be read is labelled distinctly from an untitled one', () => {
    expect(sessionTabTitleFromSession(null)).toBe('Session — Kortix');
    expect(sessionTabTitleFromSession(undefined)).toBe('Session — Kortix');
    expect(sessionTabTitleFromSession(null)).not.toBe(sessionTabTitleFromSession(session()));
  });
});
