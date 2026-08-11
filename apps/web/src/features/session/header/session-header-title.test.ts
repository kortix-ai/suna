/**
 * The header must show the SAME name as the sidebar row.
 *
 * They were two different names. The sidebar shows dosco's session name, which
 * is what a rename edits; the header was handed opencode's own `session.title`
 * — the summary the agent writes for itself. So one session read as "Just A
 * Simple Hey" on the left and "Greeting" on top, and renaming changed only the
 * left one.
 */
import { describe, expect, test } from 'bun:test';
import type { ProjectSession } from '@kortix/sdk';
import { getSessionDisplayTitle } from '@/features/workspace/project-sidebar/project-session-list-helpers';

const SRC = await Bun.file(new URL('./session-site-header.tsx', import.meta.url).pathname).text();

function code(): string {
  return SRC.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
}

function session(over: Partial<ProjectSession>): ProjectSession {
  return {
    session_id: '3f9a1c2b-0000-0000-0000-000000000000',
    branch_name: 'feature/some-branch-name',
    custom_name: null,
    name: null,
    metadata: {},
    ...over,
  } as unknown as ProjectSession;
}

describe('the header renders the sidebar name', () => {
  test('uses the sidebar helper, not opencode\'s title', () => {
    const src = code();
    expect(src).toContain('getSessionDisplayTitle(projectSession)');
    // The regression shape: the raw prop back in the label.
    expect(src).not.toContain('truncate">{sessionTitle}<');
  });

  test('the delete confirmation names it the same way', () => {
    // "Delete Greeting?" for a session the user knows as something else is the
    // same bug with worse consequences.
    expect(code()).toContain('sessionLabel={headerTitle}');
  });

  test('still falls back to the prop without a project session', () => {
    // The share viewer and instant shell render this header with no project
    // session; hardcoding the helper would blank the title there.
    expect(code()).toContain('projectSession ? getSessionDisplayTitle(projectSession) : sessionTitle');
  });
});

describe('the two surfaces cannot disagree', () => {
  test('a rename wins in both', () => {
    const s = session({ custom_name: 'My Rename', name: 'Greeting' });
    expect(getSessionDisplayTitle(s)).toBe('My Rename');
  });

  test('the server name beats opencode auto-title drift', () => {
    const s = session({ name: 'Just A Simple Hey' });
    expect(getSessionDisplayTitle(s)).toBe('Just A Simple Hey');
  });

  test('an untitled session reads "New session", never a uuid slice', () => {
    // This is why the sidebar helper is used rather than sessionDisplayLabel:
    // that one ends at `session_id.slice(0, 8)`, so the header would have shown
    // a raw hash where the sidebar shows words.
    expect(getSessionDisplayTitle(session({}))).toBe('New session');
  });
});
