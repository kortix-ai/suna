import { describe, expect, test } from 'bun:test';
import { act } from 'react';

import { testRender } from '@opentui/react/test-utils';

import { type SessionLike, groupSessionsByDay } from '../../lib/session-groups.ts';
import { SidebarView, type SidebarViewProps } from './sidebar-view.tsx';

// React 19 needs this before `act`; without it a key press is asserted against
// the frame React had not yet committed. See docs/opentui-notes.md.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date(2026, 8, 17, 12, 0, 0).getTime();
const MINUTE = 60_000;
const DAY = 86_400_000;

function fixture(): SessionLike[] {
  const stamp = (msBack: number) => new Date(NOW - msBack).toISOString();
  return [
    {
      session_id: 'root-1',
      name: 'Digest the day',
      status: 'running',
      metadata: { last_activity_at: stamp(2 * MINUTE) },
    },
    {
      session_id: 'child-1',
      name: 'Ping request test',
      status: 'stopped',
      metadata: { last_activity_at: stamp(5 * MINUTE), spawned_by_session: 'root-1' },
    },
    {
      session_id: 'root-2',
      name: 'CRM pipeline deck',
      status: 'stopped',
      metadata: { last_activity_at: stamp(DAY + 3 * MINUTE) },
    },
  ];
}

function props(overrides: Partial<SidebarViewProps> = {}): SidebarViewProps {
  return {
    accountName: 'Acme',
    projectName: 'Acme',
    reviewCount: 2,
    groups: groupSessionsByDay(fixture(), { now: NOW }),
    selectedSessionId: null,
    focused: true,
    width: 28,
    height: 18,
    now: NOW,
    loading: false,
    errorMessage: null,
    onOpenSession: () => {},
    onOpenAccountPicker: () => {},
    onOpenProjectPicker: () => {},
    onNewSession: () => {},
    onNavigate: () => {},
    onRename: () => {},
    onDelete: () => {},
    onAttach: () => {},
    ...overrides,
  };
}

const SIZE = { width: 30, height: 20 };

/**
 * Press Esc and let the key parser resolve it.
 *
 * A lone `ESC` byte is the prefix of every escape sequence, so OpenTUI's key
 * parser holds it until a timeout proves nothing follows. Pressing Esc and
 * capturing the next frame immediately sees NO key at all — and the following
 * keystroke arrives as `Alt+<key>` (`\x1b` + the byte). Verified against
 * `mockInput.pressEscape()`: with no wait the handler saw
 * `{name:'y',sequence:'\u001by'}`; with the wait it saw
 * `{name:'escape'}`.
 */
async function pressEscape(mockInput: { pressEscape: () => void }): Promise<void> {
  await act(async () => {
    mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
}

describe('<SidebarView/> through the OpenTUI test renderer', () => {
  test('renders the account, project, nav rows and day-grouped sessions', async () => {
    const { captureCharFrame, flush, renderer } = await testRender(
      <SidebarView {...props()} />,
      SIZE,
    );
    await flush();
    const frame = captureCharFrame();
    const lines = frame.split('\n').map((line) => line.trimEnd());

    expect(lines[0]).toContain('Acme');
    expect(lines[2]).toContain('+ New session');
    expect(lines[3]).toContain('Customize');
    expect(lines[4]).toContain('Apps');
    // The Review row carries its open change-request count, right-aligned.
    expect(lines[5]).toMatch(/Review\s+2$/);
    expect(lines[6]).toContain('Files');

    // Day sections in activity order, each above its own rows.
    const today = lines.indexOf('Today');
    const yesterday = lines.indexOf('Yesterday');
    expect(today).toBeGreaterThan(-1);
    expect(yesterday).toBeGreaterThan(today);
    expect(lines[today + 1]).toContain('Digest the day');
    expect(lines[yesterday + 1]).toContain('CRM pipeline deck');
    renderer.destroy();
  });

  test('a spawned session is indented under its parent with the child mark', async () => {
    const { captureCharFrame, flush, renderer } = await testRender(
      <SidebarView {...props()} />,
      SIZE,
    );
    await flush();
    const lines = captureCharFrame().split('\n');
    const parentIndex = lines.findIndex((line) => line.includes('Digest the day'));
    const childLine = lines[parentIndex + 1] ?? '';

    expect(childLine).toContain('Ping request test');
    // ` ` cursor gutter, two columns of indent, then the child glyph.
    expect(childLine.slice(0, 5)).toBe('   · ');
    // No session is selected in this fixture, so the cursor sits on the nav
    // rows and the parent row prints its running glyph with an empty gutter.
    expect(lines[parentIndex]?.slice(0, 3)).toBe(' ● ');
    renderer.destroy();
  });

  test('the age column is right-aligned inside the width', async () => {
    const { captureCharFrame, flush, renderer } = await testRender(
      <SidebarView {...props()} />,
      SIZE,
    );
    await flush();
    const line = captureCharFrame()
      .split('\n')
      .find((row) => row.includes('Digest the day'));
    expect(line?.trimEnd().endsWith('2m')).toBe(true);
    expect(line?.trimEnd().length).toBeLessThanOrEqual(28);
    renderer.destroy();
  });

  test('j and k move the cursor over rows, skipping the day headers', async () => {
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <SidebarView {...props({ selectedSessionId: 'root-1' })} />,
      SIZE,
    );
    await flush();
    const marked = () =>
      captureCharFrame()
        .split('\n')
        .find((line) => line.startsWith('▌'))
        ?.trim();

    expect(marked()).toContain('Digest the day');

    await act(async () => mockInput.pressKey('j'));
    await flush();
    expect(marked()).toContain('Ping request test');

    await act(async () => mockInput.pressKey('j'));
    await flush();
    // The `Yesterday` header sits between the two rows and is never selected.
    expect(marked()).toContain('CRM pipeline deck');

    await act(async () => mockInput.pressKey('k'));
    await flush();
    expect(marked()).toContain('Ping request test');
    renderer.destroy();
  });

  test('g and G jump to the first and last row', async () => {
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <SidebarView {...props()} />,
      SIZE,
    );
    await flush();
    const marked = () =>
      captureCharFrame()
        .split('\n')
        .find((line) => line.startsWith('▌'))
        ?.trim();

    await act(async () => mockInput.pressKey('G'));
    await flush();
    expect(marked()).toContain('CRM pipeline deck');

    await act(async () => mockInput.pressKey('g'));
    await flush();
    expect(marked()).toContain('Acme');
    renderer.destroy();
  });

  test('Enter opens the session under the cursor with its id', async () => {
    const opened: string[] = [];
    const { flush, mockInput, renderer } = await testRender(
      <SidebarView
        {...props({ selectedSessionId: 'root-1', onOpenSession: (id) => opened.push(id) })}
      />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(opened).toEqual(['root-1']);

    await act(async () => mockInput.pressKey('j'));
    await flush();
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(opened).toEqual(['root-1', 'child-1']);
    renderer.destroy();
  });

  test('Enter on a nav row routes, and on the account row opens the picker', async () => {
    const screens: string[] = [];
    let accountPicker = 0;
    const { flush, mockInput, renderer } = await testRender(
      <SidebarView
        {...props({
          onNavigate: (screen) => screens.push(screen),
          onOpenAccountPicker: () => {
            accountPicker += 1;
          },
        })}
      />,
      SIZE,
    );
    await flush();
    // Cursor starts on `+ New session` when no session is selected.
    await act(async () => mockInput.pressKey('j'));
    await flush();
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(screens).toEqual(['customize']);

    await act(async () => mockInput.pressKey('g'));
    await flush();
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(accountPicker).toBe(1);
    renderer.destroy();
  });

  test('n creates a session and a asks the host to attach the selected one', async () => {
    let created = 0;
    const attached: string[] = [];
    const { flush, mockInput, renderer } = await testRender(
      <SidebarView
        {...props({
          selectedSessionId: 'root-1',
          onNewSession: () => {
            created += 1;
          },
          onAttach: (id) => attached.push(id),
        })}
      />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('n'));
    await flush();
    expect(created).toBe(1);

    await act(async () => mockInput.pressKey('a'));
    await flush();
    expect(attached).toEqual(['root-1']);
    renderer.destroy();
  });

  test('d asks before deleting: y confirms, Esc cancels', async () => {
    const deleted: string[] = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <SidebarView
        {...props({ selectedSessionId: 'root-1', onDelete: (id) => deleted.push(id) })}
      />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('d'));
    await flush();
    expect(captureCharFrame()).toContain('Delete session');

    await pressEscape(mockInput);
    await flush();
    expect(deleted).toEqual([]);
    expect(captureCharFrame()).not.toContain('Delete session');

    await act(async () => mockInput.pressKey('d'));
    await flush();
    await act(async () => mockInput.pressKey('y'));
    await flush();
    expect(deleted).toEqual(['root-1']);
    renderer.destroy();
  });

  test('/ opens the filter input and Esc clears it', async () => {
    const queries: string[] = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <SidebarView {...props({ onFilterChange: (query) => queries.push(query) })} />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('/'));
    await flush();
    expect(captureCharFrame()).toContain('filter sessions');

    await act(async () => mockInput.typeText('crm'));
    await flush();
    expect(queries.at(-1)).toBe('crm');

    await pressEscape(mockInput);
    await flush();
    expect(queries.at(-1)).toBe('');
    expect(captureCharFrame()).not.toContain('filter sessions');
    renderer.destroy();
  });

  test('r renames through an inline input on the selected row', async () => {
    const renames: Array<[string, string]> = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <SidebarView
        {...props({
          selectedSessionId: 'root-1',
          onRename: (id, name) => renames.push([id, name]),
        })}
      />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('r'));
    await flush();
    // The row is replaced in place by an input seeded with the current title.
    expect(captureCharFrame()).toContain('Digest the day');

    await act(async () => mockInput.typeText('!'));
    await flush();
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(renames).toEqual([['root-1', 'Digest the day!']]);
    renderer.destroy();
  });

  test('the cursor reaching the last row asks the host to page', async () => {
    let reached = 0;
    const { flush, mockInput, renderer } = await testRender(
      <SidebarView
        {...props({
          onReachEnd: () => {
            reached += 1;
          },
        })}
      />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('G'));
    await flush();
    expect(reached).toBe(1);
    renderer.destroy();
  });

  test('an unfocused sidebar ignores keys', async () => {
    const opened: string[] = [];
    const { flush, mockInput, renderer } = await testRender(
      <SidebarView
        {...props({
          focused: false,
          selectedSessionId: 'root-1',
          onOpenSession: (id) => opened.push(id),
        })}
      />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(opened).toEqual([]);
    renderer.destroy();
  });

  test('loading, empty and error states each render their own line', async () => {
    const loading = await testRender(
      <SidebarView {...props({ groups: [], loading: true })} />,
      SIZE,
    );
    await loading.flush();
    expect(loading.captureCharFrame()).toContain('loading sessions');
    loading.renderer.destroy();

    const empty = await testRender(<SidebarView {...props({ groups: [] })} />, SIZE);
    await empty.flush();
    expect(empty.captureCharFrame()).toContain('No sessions yet.');
    empty.renderer.destroy();

    const failed = await testRender(
      <SidebarView {...props({ groups: [], errorMessage: 'HTTP 403 forbidden' })} />,
      SIZE,
    );
    await failed.flush();
    expect(failed.captureCharFrame()).toContain('HTTP 403 forbidden');
    failed.renderer.destroy();
  });

  test('a long title is truncated instead of overflowing the width', async () => {
    const long: SessionLike[] = [
      {
        session_id: 'long',
        name: 'A session name far wider than the sidebar column allows',
        status: 'stopped',
        metadata: { last_activity_at: new Date(NOW - MINUTE).toISOString() },
      },
    ];
    const { captureCharFrame, flush, renderer } = await testRender(
      <SidebarView {...props({ groups: groupSessionsByDay(long, { now: NOW }) })} />,
      SIZE,
    );
    await flush();
    const line = captureCharFrame()
      .split('\n')
      .find((row) => row.includes('A session name'));
    expect(line?.trimEnd().length).toBeLessThanOrEqual(28);
    expect(line).toContain('…');
    renderer.destroy();
  });
});
