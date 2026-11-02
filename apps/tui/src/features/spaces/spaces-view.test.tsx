import { describe, expect, test } from 'bun:test';
import { act } from 'react';

import { testRender } from '@opentui/react/test-utils';

import type { ProjectSession, ProjectSpace } from '@kortix/sdk';

import { spaceRow, spaceWebUrl, threadRow, threadTitle } from './spaces-screen.tsx';
import {
  type SpaceRow,
  SpacesView,
  type SpacesViewProps,
  type ThreadRow,
  spaceRowText,
  threadRowText,
} from './spaces-view.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date(2026, 8, 17, 12, 0, 0).getTime();
const HOUR = 3_600_000;
const SIZE = { width: 84, height: 24 };

function spaces(): SpaceRow[] {
  return [
    {
      id: 's1',
      kind: 'channel',
      label: '# general',
      description: 'Everyone',
      badge: '',
      updatedMs: NOW - HOUR,
    },
    {
      id: 's2',
      kind: 'channel',
      label: '# finance',
      description: '',
      badge: 'private',
      updatedMs: NOW - 5 * HOUR,
    },
    {
      id: 's3',
      kind: 'dm',
      label: '@ kortix',
      description: '',
      badge: '',
      updatedMs: NOW - 30 * HOUR,
    },
  ];
}

function threads(): ThreadRow[] {
  return [
    {
      id: 'sess-1',
      title: 'Quarterly close',
      replies: 4,
      status: 'running',
      updatedMs: NOW - HOUR,
    },
    {
      id: 'sess-2',
      title: 'Untitled thread',
      replies: 1,
      status: 'stopped',
      updatedMs: NOW - 3 * HOUR,
    },
  ];
}

function props(overrides: Partial<SpacesViewProps> = {}): SpacesViewProps {
  return {
    spaces: spaces(),
    threads: threads(),
    focused: true,
    width: 82,
    height: 20,
    now: NOW,
    loading: false,
    threadsLoading: false,
    errorMessage: null,
    threadsError: null,
    onOpenSpace: () => {},
    onOpenThread: () => {},
    onNewThread: () => {},
    onOpenBrowser: () => {},
    onRefresh: () => {},
    onBack: () => {},
    ...overrides,
  };
}

async function pressEscape(mockInput: { pressEscape: () => void }): Promise<void> {
  await act(async () => {
    mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
}

const BASE_SPACE: ProjectSpace = {
  space_id: 's1',
  kind: 'channel',
  slug: 'general',
  name: 'general',
  description: 'Everyone',
  is_default: true,
  dm_agent_name: null,
  archived_at: null,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-17T10:00:00.000Z',
};

describe('mappers', () => {
  test('spaceRow labels a channel with # and a DM with @', () => {
    expect(spaceRow(BASE_SPACE)).toMatchObject({
      label: '# general',
      description: 'Everyone',
      badge: '',
    });
    expect(
      spaceRow({ ...BASE_SPACE, kind: 'dm', slug: null, name: 'Kortix', dm_agent_name: 'kortix' }),
    ).toMatchObject({ label: '@ kortix', kind: 'dm' });
    expect(spaceRow({ ...BASE_SPACE, visibility: 'private' }).badge).toBe('private');
  });

  test('threadTitle prefers the name, then the first prompt line', () => {
    const base = {
      session_id: 'x',
      status: 'running',
      updated_at: '2026-09-17T10:00:00Z',
    } as ProjectSession;
    expect(threadTitle({ ...base, custom_name: 'Mine', name: 'Auto' })).toBe('Mine');
    expect(threadTitle({ ...base, name: 'Auto' })).toBe('Auto');
    expect(threadTitle({ ...base, first_prompt: 'Close the books\nplease' })).toBe(
      'Close the books',
    );
    expect(threadTitle(base)).toBe('Untitled thread');
    expect(threadRow({ ...base, reply_count: 3 })).toMatchObject({ id: 'x', replies: 3 });
  });

  test('spaceWebUrl builds /c/<slug> and /dm/<agent>', () => {
    expect(spaceWebUrl('https://kortix.com/', 'p1', BASE_SPACE)).toBe(
      'https://kortix.com/projects/p1/c/general',
    );
    expect(
      spaceWebUrl('https://kortix.com', 'p1', { kind: 'dm', slug: null, dm_agent_name: 'kortix' }),
    ).toBe('https://kortix.com/projects/p1/dm/kortix');
  });

  test('row text fits the width and carries the age', () => {
    const space = spaceRowText(spaces()[1] as SpaceRow, NOW, 82);
    expect(space.trimEnd().endsWith('private · 5h')).toBe(true);
    const thread = threadRowText(threads()[0] as ThreadRow, NOW, 82);
    expect(thread.trimEnd().endsWith('4 replies · 1h')).toBe(true);
    expect(thread.length).toBeLessThanOrEqual(81);
    expect(threadRowText({ ...(threads()[1] as ThreadRow) }, NOW, 82)).toContain('1 reply');
  });
});

describe('<SpacesView/> through the OpenTUI test renderer', () => {
  test('lists the spaces and moves the cursor', async () => {
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <SpacesView {...props()} />,
      SIZE,
    );
    await flush();
    const marked = () =>
      captureCharFrame()
        .split('\n')
        .find((line) => line.startsWith('▌'))
        ?.trim();
    expect(captureCharFrame()).toContain('# general · Everyone');
    expect(marked()).toContain('# general');
    await act(async () => mockInput.pressKey('G'));
    await flush();
    expect(marked()).toContain('@ kortix');
    renderer.destroy();
  });

  test('Enter opens the space, shows its threads, and Enter on a thread opens the session', async () => {
    const asked: Array<string | null> = [];
    const opened: string[] = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <SpacesView
        {...props({ onOpenSpace: (id) => asked.push(id), onOpenThread: (id) => opened.push(id) })}
      />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(asked).toEqual(['s1']);
    const frame = captureCharFrame();
    expect(frame).toContain('2 threads');
    expect(frame).toContain('Quarterly close');
    await act(async () => mockInput.pressKey('j'));
    await act(async () => mockInput.pressEnter());
    expect(opened).toEqual(['sess-2']);

    await pressEscape(mockInput);
    await flush();
    expect(asked).toEqual(['s1', null]);
    expect(captureCharFrame()).toContain('# finance');
    renderer.destroy();
  });

  test('n starts a thread only inside a space; o opens the browser for the row', async () => {
    const calls: string[] = [];
    const { flush, mockInput, renderer } = await testRender(
      <SpacesView
        {...props({
          onNewThread: (space) => calls.push(`new ${space.id}`),
          onOpenBrowser: (space) => calls.push(`web ${space.id}`),
        })}
      />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.pressKey('n'));
    expect(calls).toEqual([]);
    await act(async () => mockInput.pressKey('j'));
    await act(async () => mockInput.pressKey('o'));
    await act(async () => mockInput.pressEnter());
    await act(async () => mockInput.pressKey('n'));
    expect(calls).toEqual(['web s2', 'new s2']);
    renderer.destroy();
  });

  test('loading, error and empty states each say what is happening', async () => {
    const loading = await testRender(
      <SpacesView {...props({ spaces: [], loading: true })} />,
      SIZE,
    );
    await loading.flush();
    expect(loading.captureCharFrame()).toContain('loading spaces');
    loading.renderer.destroy();

    const failed = await testRender(
      <SpacesView {...props({ spaces: [], errorMessage: 'HTTP 403: feature_disabled' })} />,
      SIZE,
    );
    await failed.flush();
    expect(failed.captureCharFrame()).toContain('HTTP 403: feature_disabled');
    failed.renderer.destroy();

    const empty = await testRender(<SpacesView {...props({ spaces: [] })} />, SIZE);
    await empty.flush();
    expect(empty.captureCharFrame()).toContain('No channels or DMs yet.');
    empty.renderer.destroy();

    const noThreads = await testRender(<SpacesView {...props({ threads: [] })} />, SIZE);
    await noThreads.flush();
    await act(async () => noThreads.mockInput.pressEnter());
    await noThreads.flush();
    expect(noThreads.captureCharFrame()).toContain('No threads in this space yet.');
    noThreads.renderer.destroy();
  });
});
