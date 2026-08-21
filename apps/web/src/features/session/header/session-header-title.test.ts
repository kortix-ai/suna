/**
 * The header must show the SAME name as the sidebar row.
 *
 * They were two different names. The sidebar shows Kortix's session name, which
 * is what a rename edits; the header was handed opencode's own `session.title`
 * — the summary the agent writes for itself. So one session read as "Just A
 * Simple Hey" on the left and "Greeting" on top, and renaming changed only the
 * left one.
 */
import { describe, expect, test } from 'bun:test';
import type { ProjectSession } from '@kortix/sdk';
import { resolveSessionHeaderTitle } from '@/features/session/header/header-title';
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
  test('resolves through the one resolver, never inline', () => {
    const src = code();
    expect(src).toContain('resolveSessionHeaderTitle({');
    // The regression shape: the raw prop back in the label.
    expect(src).not.toContain('truncate">{sessionTitle}<');
  });

  test('the delete confirmation names it the same way', () => {
    // "Delete Greeting?" for a session the user knows as something else is the
    // same bug with worse consequences.
    expect(code()).toContain('sessionLabel={headerTitle}');
  });
});

describe('the title cannot change more than once', () => {
  const named = session({ name: 'Just A Simple Hey' });

  test('a loading row on the session route shows the placeholder, not opencode', () => {
    // THE FLICKER. The row is not in the cache yet, and the caller's prop on
    // this route is opencode's own `session.title` — a different name, which
    // opencode then rewrites. Falling back to it painted two or three distinct
    // titles for a session that was only ever called one thing.
    expect(
      resolveSessionHeaderTitle({
        projectSession: null,
        isProjectSession: true,
        fallbackTitle: 'Greeting',
      }),
    ).toBe('New session');
  });

  test('opencode rewriting its own title moves nothing', () => {
    // Same inputs bar the prop: the header must not follow it at all here.
    const first = resolveSessionHeaderTitle({
      projectSession: null,
      isProjectSession: true,
      fallbackTitle: 'Greeting',
    });
    const afterOpencodeRetitles = resolveSessionHeaderTitle({
      projectSession: null,
      isProjectSession: true,
      fallbackTitle: 'Debugging a flaky test',
    });
    expect(afterOpencodeRetitles).toBe(first);
  });

  test('the whole arrival is one change: placeholder then the real name', () => {
    // What the user should see, in order, and nothing else.
    const frames = [
      // list still loading
      { projectSession: null, isProjectSession: true, fallbackTitle: 'Greeting' },
      // row arrives, server has not named it yet
      { projectSession: session({}), isProjectSession: true, fallbackTitle: 'Greeting' },
      // opencode retitles itself mid-boot
      { projectSession: session({}), isProjectSession: true, fallbackTitle: 'Chat' },
      // the Kortix name lands
      { projectSession: named, isProjectSession: true, fallbackTitle: 'Chat' },
    ].map(resolveSessionHeaderTitle);

    expect(frames).toEqual(['New session', 'New session', 'New session', 'Just A Simple Hey']);
    const changes = frames.filter((t, i) => i > 0 && t !== frames[i - 1]).length;
    expect(changes).toBe(1);
  });

  test('the boot shell and the real chat cannot disagree mid-crossfade', () => {
    // Both are mounted for the fade and pass DIFFERENT fallbacks. Identical
    // inputs otherwise must produce identical text, or the dissolve shows two
    // names at once.
    const shell = resolveSessionHeaderTitle({
      projectSession: null,
      isProjectSession: true,
      fallbackTitle: 'New session',
    });
    const chat = resolveSessionHeaderTitle({
      projectSession: null,
      isProjectSession: true,
      fallbackTitle: 'Untitled',
    });
    expect(chat).toBe(shell);
  });

  test('off the session route the prop is still the only name there is', () => {
    // The share viewer has no Kortix row to read; hardcoding the placeholder
    // would blank a title that is genuinely correct there.
    expect(
      resolveSessionHeaderTitle({
        projectSession: null,
        isProjectSession: false,
        fallbackTitle: 'Shared conversation',
      }),
    ).toBe('Shared conversation');
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
