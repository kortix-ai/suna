import { describe, expect, test } from 'bun:test';
import { act } from 'react';

import type { Drive, DriveEntry, SessionDrive } from '@kortix/sdk';
import { testRender } from '@opentui/react/test-utils';

import {
  type DriveRow,
  buildPlaces,
  crumbText,
  driveWebUrl,
  entryRows,
  errorText,
  featureFlagsWebUrl,
  locatePlace,
  moveTarget,
  placeRows,
} from './drive-model.ts';
import { DriveView, type DriveViewProps } from './drive-view.tsx';

// React 19 needs this before `act`; without it a key press is asserted against
// the frame React had not yet committed. See docs/opentui-notes.md.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date(2026, 9, 30, 12, 0, 0).getTime();
const SIZE = { width: 90, height: 24 };

const DRIVE: Pick<Drive, 'personalFolder' | 'sharedWithMe' | 'access'> = {
  personalFolder: '/Users/ana',
  sharedWithMe: [{ path: '/Users/ben/Plans', access: 'read' }],
  access: 'manage',
};

function entry(path: string, type: DriveEntry['type'], extra: Partial<DriveEntry> = {}): DriveEntry {
  return {
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    type,
    size: 0,
    mtime: Math.floor((NOW - 5 * 60_000) / 1000),
    access: 'write',
    ...extra,
  };
}

const ROOT_ENTRIES: DriveEntry[] = [
  entry('/Company', 'dir'),
  entry('/Users', 'dir'),
  entry('/Finance', 'dir', { access: 'none' }),
];

const MOUNTS: SessionDrive[] = [
  {
    driveId: 'drv-1',
    name: 'Company',
    kind: 'project',
    mountPath: '/drives/Company',
    readOnly: false,
    subdir: '/Company',
  },
];

function folderRows(): DriveRow[] {
  return entryRows(
    [
      entry('/Users/ana/notes.md', 'file', { size: 1200 }),
      entry('/Users/ana/Memory', 'dir'),
      entry('/Users/ana/readme.txt', 'file', { size: 40, access: 'read' }),
      entry('/Users/ana/link', 'symlink'),
    ],
    NOW,
  );
}

function props(overrides: Partial<DriveViewProps> = {}): DriveViewProps {
  return {
    focused: true,
    width: SIZE.width - 2,
    height: SIZE.height - 2,
    notice: null,
    list: 'folder',
    crumb: 'My files',
    rows: folderRows(),
    loading: false,
    errorMessage: null,
    locationKey: 'folder:/Users/ana',
    canWrite: true,
    conflictCount: 0,
    viewer: { kind: 'empty' },
    onOpen: () => {},
    onParent: () => {},
    onMakeFolder: () => {},
    onMove: () => {},
    onDelete: () => {},
    onUpload: () => {},
    onOpenWeb: () => {},
    onCopy: () => {},
    onRefresh: () => {},
    onShowConflicts: () => {},
    onDismissConflict: () => {},
    onCloseViewer: () => {},
    onToast: () => {},
    onBack: () => {},
    ...overrides,
  };
}

async function settle(flush: () => Promise<void>, ms = 30): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
  await flush();
}

/** A lone ESC byte waits for the key parser's timeout (docs/opentui-notes.md). */
async function pressEscape(mockInput: { pressEscape: () => void }): Promise<void> {
  await act(async () => {
    mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
}

function markedLine(frame: string): string | undefined {
  return frame
    .split('\n')
    .find((line) => line.startsWith('▌'))
    ?.trim();
}

describe('drive-model', () => {
  test('buildPlaces follows the web rail: mine, shared, team, session, all', () => {
    const places = buildPlaces({ drive: DRIVE, rootEntries: ROOT_ENTRIES, sessionMounts: MOUNTS });
    expect(places.map((place) => [place.kind, place.label, place.root])).toEqual([
      ['mine', 'My files', '/Users/ana'],
      ['shared', 'Plans', '/Users/ben/Plans'],
      // `/Users` is the per-person tree and `/Finance` has no access: neither is a team folder.
      ['team', 'Company', '/Company'],
      ['session', 'Company', '/Company'],
      ['all', 'All files', '/'],
    ]);
    expect(places[3]?.meta).toBe('/drives/Company');
  });

  test('a member sees no All files', () => {
    const places = buildPlaces({ drive: { ...DRIVE, access: 'write' }, rootEntries: ROOT_ENTRIES });
    expect(places.some((place) => place.kind === 'all')).toBe(false);
  });

  test('locatePlace picks the longest root; crumbText names the place', () => {
    const places = buildPlaces({ drive: DRIVE, rootEntries: ROOT_ENTRIES });
    expect(locatePlace('/Users/ana/Memory/2026', places)?.label).toBe('My files');
    expect(locatePlace('/Company/Reports', places)?.label).toBe('Company');
    expect(locatePlace('/Other', places)?.label).toBe('All files');
    expect(crumbText(locatePlace('/Users/ana/Memory/2026', places), '/Users/ana/Memory/2026')).toBe(
      'My files / Memory / 2026',
    );
  });

  test('entryRows: folders first, symlinks dropped, size and age on files', () => {
    const rows = folderRows();
    expect(rows.map((row) => row.name)).toEqual(['Memory', 'notes.md', 'readme.txt']);
    expect(rows[1]?.meta).toBe('1.2 KiB · 5m');
    expect(rows[2]).toMatchObject({ readOnly: true, meta: '40 B · 5m · read only' });
  });

  test('placeRows: headings take no cursor, empty team folders say so', () => {
    const rows = placeRows(buildPlaces({ drive: { ...DRIVE, sharedWithMe: [] }, rootEntries: [] }));
    expect(rows.map((row) => `${row.kind}:${row.name}`)).toEqual([
      'place:My files',
      'heading:Team folders',
      'note:No team folders yet.',
      'heading:Admin',
      'place:All files',
    ]);
  });

  test('driveWebUrl uses the web ?path= encoding', () => {
    const web = 'https://dev.kortix.com/';
    expect(driveWebUrl(web, 'p1', '/Users/ana/Memory', '/Users/ana')).toBe(
      'https://dev.kortix.com/projects/p1/drive?path=~/Memory',
    );
    expect(driveWebUrl(web, 'p1', '/Company/Q3 plan', '/Users/ana')).toBe(
      'https://dev.kortix.com/projects/p1/drive?path=Company/Q3+plan',
    );
    expect(driveWebUrl(web, 'p1', '/', null)).toBe('https://dev.kortix.com/projects/p1/drive');
    expect(featureFlagsWebUrl(web, 'p1')).toBe('https://dev.kortix.com/projects/p1/admin/feature-flags');
  });

  test('moveTarget: a name renames in place, a /path moves, junk is refused', () => {
    expect(moveTarget('/Company/a.md', 'b.md')).toBe('/Company/b.md');
    expect(moveTarget('/Company/a.md', '/Archive/a.md')).toBe('/Archive/a.md');
    expect(moveTarget('/Company/a.md', 'a.md')).toBeNull();
    expect(moveTarget('/Company/a.md', '../x')).toBeNull();
    expect(moveTarget('/Company/a.md', '  ')).toBeNull();
  });

  test('errorText leads with the HTTP status', () => {
    const error = Object.assign(new Error('Forbidden'), { status: 403 });
    expect(errorText(error)).toBe('HTTP 403 · Forbidden');
    expect(errorText(new Error('offline'))).toBe('offline');
  });
});

describe('<DriveView/> through the OpenTUI test renderer', () => {
  test('renders the crumb, folders first, sizes and the read-only marker', async () => {
    const { captureCharFrame, flush, renderer } = await testRender(<DriveView {...props()} />, SIZE);
    await flush();
    const lines = captureCharFrame().split('\n');
    expect(lines[0]).toContain('My files');
    const rowOf = (name: string) => lines.findIndex((line) => line.includes(name));
    expect(rowOf('Memory/')).toBeLessThan(rowOf('notes.md'));
    expect(lines[rowOf('notes.md')]).toContain('1.2 KiB · 5m');
    expect(lines[rowOf('readme.txt')]).toContain('read only');
    expect(captureCharFrame()).not.toContain('link');
    renderer.destroy();
  });

  test('j/k move, Enter opens the row, Backspace goes up', async () => {
    const opened: string[] = [];
    let parent = 0;
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <DriveView
        {...props({
          onOpen: (row) => opened.push(row.path),
          onParent: () => {
            parent += 1;
          },
        })}
      />,
      SIZE,
    );
    await flush();
    expect(markedLine(captureCharFrame())).toContain('Memory/');
    await act(async () => mockInput.pressKey('j'));
    await flush();
    expect(markedLine(captureCharFrame())).toContain('notes.md');
    await act(async () => mockInput.pressEnter());
    await flush();
    await act(async () => mockInput.pressKey('k'));
    await flush();
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(opened).toEqual(['/Users/ana/notes.md', '/Users/ana/Memory']);

    await act(async () => mockInput.pressBackspace());
    await flush();
    await act(async () => mockInput.pressKey('h'));
    await flush();
    expect(parent).toBe(2);
    renderer.destroy();
  });

  test('Places: the cursor skips headings and Enter opens a place', async () => {
    const opened: DriveRow[] = [];
    const rows = placeRows(buildPlaces({ drive: DRIVE, rootEntries: ROOT_ENTRIES, sessionMounts: MOUNTS }));
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <DriveView
        {...props({ list: 'places', crumb: 'Places', rows, locationKey: 'places', onOpen: (row) => opened.push(row) })}
      />,
      SIZE,
    );
    await flush();
    const frame = captureCharFrame();
    expect(frame).toContain('Shared with me');
    expect(frame).toContain('Team folders');
    expect(frame).toContain('This session');
    expect(frame).toContain('/drives/Company');
    expect(markedLine(frame)).toContain('My files');
    // One `j` passes the "Shared with me" heading and lands on Plans.
    await act(async () => mockInput.pressKey('j'));
    await flush();
    expect(markedLine(captureCharFrame())).toContain('Plans');
    await act(async () => mockInput.pressKey('G'));
    await flush();
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(opened.map((row) => [row.kind, row.path])).toEqual([['place', '/']]);
    renderer.destroy();
  });

  test('d asks y/N: n keeps the file, y deletes it', async () => {
    const deleted: string[] = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <DriveView {...props({ onDelete: (row) => deleted.push(row.path) })} />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('d'));
    await flush();
    expect(captureCharFrame()).toContain('Delete folder Memory and everything in it?');
    await act(async () => mockInput.pressKey('n'));
    await flush();
    expect(deleted).toEqual([]);
    expect(captureCharFrame()).not.toContain('Delete folder');

    await act(async () => mockInput.pressKey('j'));
    await flush();
    await act(async () => mockInput.pressKey('d'));
    await flush();
    expect(captureCharFrame()).toContain('Delete notes.md?');
    await act(async () => mockInput.pressKey('y'));
    await flush();
    expect(deleted).toEqual(['/Users/ana/notes.md']);
    renderer.destroy();
  });

  test('a read-only row refuses d and m with a reason', async () => {
    const toasts: string[] = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <DriveView {...props({ onToast: (message) => toasts.push(message) })} />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('G'));
    await flush();
    await act(async () => mockInput.pressKey('d'));
    await flush();
    await act(async () => mockInput.pressKey('m'));
    await flush();
    expect(toasts).toEqual(['You can only read readme.txt.', 'You can only read readme.txt.']);
    expect(captureCharFrame()).not.toContain('Delete readme.txt?');
    renderer.destroy();
  });

  test('n takes a folder name inline and submits it', async () => {
    const made: string[] = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <DriveView {...props({ onMakeFolder: (name) => made.push(name) })} />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('n'));
    await settle(flush);
    expect(captureCharFrame()).toContain('New folder name');
    await act(async () => {
      await mockInput.typeText('Reports', 5);
    });
    await settle(flush);
    await act(async () => mockInput.pressEnter());
    await settle(flush);
    expect(made).toEqual(['Reports']);
    renderer.destroy();
  });

  test('m starts from the current name; u asks before replacing a file', async () => {
    const moved: Array<[string, string]> = [];
    const uploads: string[] = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <DriveView
        {...props({
          onMove: (row, to) => moved.push([row.path, to]),
          onUpload: (local) => uploads.push(local),
        })}
      />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('j'));
    await flush();
    await act(async () => mockInput.pressKey('m'));
    await settle(flush);
    expect(captureCharFrame()).toContain('notes.md');
    await act(async () => {
      await mockInput.typeText('-old', 5);
    });
    await settle(flush);
    await act(async () => mockInput.pressEnter());
    await settle(flush);
    expect(moved).toEqual([['/Users/ana/notes.md', 'notes.md-old']]);

    await act(async () => mockInput.pressKey('u'));
    await settle(flush);
    await act(async () => {
      await mockInput.typeText('/tmp/notes.md', 5);
    });
    await settle(flush);
    await act(async () => mockInput.pressEnter());
    await settle(flush);
    expect(captureCharFrame()).toContain('Replace notes.md in this folder?');
    expect(uploads).toEqual([]);
    await act(async () => mockInput.pressKey('y'));
    await settle(flush);
    expect(uploads).toEqual(['/tmp/notes.md']);
    renderer.destroy();
  });

  test('a read-only folder refuses n and u', async () => {
    const toasts: string[] = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <DriveView {...props({ canWrite: false, onToast: (message) => toasts.push(message) })} />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('n'));
    await flush();
    await act(async () => mockInput.pressKey('u'));
    await flush();
    expect(toasts).toEqual(['You can only read this folder.', 'You can only read this folder.']);
    expect(captureCharFrame()).toContain('read only · r reload');
    renderer.destroy();
  });

  test('o, y, r and c reach the host with the selected row', async () => {
    const calls: string[] = [];
    const { flush, mockInput, renderer } = await testRender(
      <DriveView
        {...props({
          onOpenWeb: (row) => calls.push(`web:${row?.path}`),
          onCopy: (row) => calls.push(`copy:${row?.path}`),
          onRefresh: () => calls.push('refresh'),
          onShowConflicts: (open) => calls.push(`conflicts:${open}`),
        })}
      />,
      SIZE,
    );
    await flush();
    for (const key of ['o', 'y', 'r', 'c']) {
      await act(async () => mockInput.pressKey(key));
      await flush();
    }
    expect(calls).toEqual([
      'web:/Users/ana/Memory',
      'copy:/Users/ana/Memory',
      'refresh',
      'conflicts:true',
    ]);
    renderer.destroy();
  });

  test('/ filters by name and Esc clears the filter before leaving', async () => {
    let back = 0;
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <DriveView
        {...props({
          onBack: () => {
            back += 1;
          },
        })}
      />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('/'));
    await settle(flush);
    await act(async () => {
      await mockInput.typeText('read', 5);
    });
    await settle(flush);
    let frame = captureCharFrame();
    expect(frame).toContain('readme.txt');
    expect(frame).not.toContain('notes.md');
    await pressEscape(mockInput);
    await flush();
    frame = captureCharFrame();
    expect(frame).toContain('notes.md');
    expect(back).toBe(0);
    await pressEscape(mockInput);
    await flush();
    expect(back).toBe(1);
    renderer.destroy();
  });

  test('a text preview opens beside the list; Esc closes it first', async () => {
    let closed = 0;
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <DriveView
        {...props({
          viewer: {
            kind: 'text',
            path: '/Users/ana/notes.md',
            content: '# Plan\n\nShip Drive in the TUI.\n',
            bytes: 30,
            truncated: false,
          },
          onCloseViewer: () => {
            closed += 1;
          },
        })}
      />,
      SIZE,
    );
    await flush();
    const frame = captureCharFrame();
    expect(frame).toContain('Ship Drive in the TUI.');
    expect(frame).toContain('│');
    await pressEscape(mockInput);
    await flush();
    expect(closed).toBe(1);
    renderer.destroy();
  });

  test('the conflicts list: x dismisses, Enter opens, a badge counts them', async () => {
    const dismissed: string[] = [];
    const rows: DriveRow[] = [
      {
        id: 'c-1',
        kind: 'conflict',
        name: '/Company/plan (conflict 2026-10-30).md',
        path: '/Company/plan (conflict 2026-10-30).md',
        meta: 'copy of plan.md · 2h',
      },
    ];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <DriveView
        {...props({
          list: 'conflicts',
          crumb: 'Conflicts',
          rows,
          locationKey: 'conflicts',
          conflictCount: 1,
          onDismissConflict: (row) => dismissed.push(row.id),
        })}
      />,
      SIZE,
    );
    await flush();
    const frame = captureCharFrame();
    expect(frame.split('\n')[0]).toContain('1 conflict');
    expect(frame).toContain('copy of plan.md');
    await act(async () => mockInput.pressKey('x'));
    await flush();
    expect(dismissed).toEqual(['c-1']);
    renderer.destroy();
  });

  test('loading, empty, error and notice states each render their own body', async () => {
    const loading = await testRender(<DriveView {...props({ rows: [], loading: true })} />, SIZE);
    await loading.flush();
    expect(loading.captureCharFrame()).toContain('loading folder');
    loading.renderer.destroy();

    const empty = await testRender(<DriveView {...props({ rows: [] })} />, SIZE);
    await empty.flush();
    expect(empty.captureCharFrame()).toContain('Empty folder. n makes a folder, u uploads a file.');
    empty.renderer.destroy();

    const failed = await testRender(
      <DriveView {...props({ rows: [], errorMessage: 'HTTP 403 · Forbidden' })} />,
      SIZE,
    );
    await failed.flush();
    expect(failed.captureCharFrame()).toContain('HTTP 403 · Forbidden');
    failed.renderer.destroy();

    const opened: Array<string | null> = [];
    const off = await testRender(
      <DriveView
        {...props({
          notice: {
            tone: 'info',
            message: 'Drive is off for this project. Turn on Volumes in Feature flags.',
            hint: 'o open Feature flags in the web app · Esc back',
          },
          onOpenWeb: (row) => opened.push(row?.path ?? null),
        })}
      />,
      SIZE,
    );
    await off.flush();
    const frame = off.captureCharFrame();
    expect(frame).toContain('Drive is off for this project. Turn on Volumes in Feature flags.');
    expect(frame).not.toContain('notes.md');
    await act(async () => off.mockInput.pressKey('o'));
    await off.flush();
    expect(opened).toEqual([null]);
    off.renderer.destroy();
  });

  test('an unfocused screen ignores keys', async () => {
    const opened: string[] = [];
    const { flush, mockInput, renderer } = await testRender(
      <DriveView {...props({ focused: false, onOpen: (row) => opened.push(row.path) })} />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(opened).toEqual([]);
    renderer.destroy();
  });
});
