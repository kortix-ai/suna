import { describe, expect, test } from 'bun:test';
import { act } from 'react';

import { testRender } from '@opentui/react/test-utils';

import { REPO_KEYS } from './keys.ts';
import type { BranchRow, CommitRow } from './repo-model.ts';
import { type RepoLoaders, RepoView, type RepoViewProps } from './repo-view.tsx';

// React 19 needs this before `act`; without it a key press is asserted against
// the frame React had not yet committed.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SIZE = { width: 100, height: 24 };
const NOW = new Date(2026, 9, 30, 12, 0, 0).getTime();
const HOUR = 3_600_000;

const COMMITS: CommitRow[] = [
  { hash: 'a'.repeat(40), shortHash: 'aaaaaaa', subject: 'Add readme', author: 'Ada', atMs: NOW - HOUR },
  { hash: 'b'.repeat(40), shortHash: 'bbbbbbb', subject: 'Init repo', author: 'Lin', atMs: NOW - 5 * HOUR },
];

const BRANCHES: BranchRow[] = [
  { name: 'main', isDefault: true, subject: 'x', atMs: NOW - HOUR, sessionTitle: null },
  { name: 'feature-x', isDefault: false, subject: 'y', atMs: NOW - 2 * HOUR, sessionTitle: null },
];

interface Calls {
  listed: Array<[string, string | undefined]>;
  read: Array<[string, string | undefined]>;
  history: Array<[string | null, string | undefined]>;
}

function loaders(calls: Calls, over: Partial<RepoLoaders> = {}): RepoLoaders {
  return {
    listDirectory: async (path, ref) => {
      calls.listed.push([path, ref]);
      if (path === '/') {
        return {
          truncated: false,
          nodes: [
            { name: 'README.md', path: '/README.md', type: 'file' },
            { name: 'src', path: '/src', type: 'directory' },
            { name: '.github', path: '/.github', type: 'directory' },
          ],
        };
      }
      if (path === '/src') {
        return { truncated: false, nodes: [{ name: 'index.ts', path: '/src/index.ts', type: 'file' }] };
      }
      throw new Error(`no such directory ${path}`);
    },
    readFile: async (path, ref) => {
      calls.read.push([path, ref]);
      if (path === '/README.md') return { content: '# Kortix\n\nA terminal client.\n' };
      throw new Error(`no such file ${path}`);
    },
    history: async (path, ref) => {
      calls.history.push([path, ref]);
      return COMMITS;
    },
    branches: async () => ({ defaultBranch: 'main', branches: BRANCHES }),
    ...over,
  };
}

async function settle(flush: () => Promise<void>, ms = 60): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
  await flush();
}

async function press(
  input: { pressKey: (key: string) => void },
  flush: () => Promise<void>,
  key: string,
): Promise<void> {
  await act(async () => {
    input.pressKey(key);
  });
  await settle(flush);
}

async function pressEnter(
  input: { pressEnter: () => void },
  flush: () => Promise<void>,
): Promise<void> {
  await act(async () => {
    input.pressEnter();
  });
  await settle(flush);
}

function element(calls: Calls, over: Partial<RepoViewProps> = {}) {
  return (
    <RepoView
      loaders={over.loaders ?? loaders(calls)}
      focused
      width={SIZE.width}
      height={SIZE.height}
      now={NOW}
      onBack={() => {}}
      onOpenWeb={() => {}}
      onCopy={() => {}}
      {...over}
    />
  );
}

const fresh = (): Calls => ({ listed: [], read: [], history: [] });

describe('REPO_KEYS', () => {
  test('every binding is scoped repo, ids are unique, and h is history', () => {
    expect(REPO_KEYS.every((binding) => binding.scope === 'repo')).toBe(true);
    expect(new Set(REPO_KEYS.map((binding) => binding.id)).size).toBe(REPO_KEYS.length);
    expect(REPO_KEYS.find((binding) => binding.id === 'repo.history')?.chords).toEqual([{ key: 'h' }]);
  });
});

describe('<RepoView/>', () => {
  test('lists the root of the default branch: directories first, dotfiles hidden', async () => {
    const calls = fresh();
    const { captureCharFrame, flush, renderer } = await testRender(element(calls), SIZE);
    await settle(flush, 120);
    const frame = captureCharFrame();
    expect(calls.listed[0]).toEqual(['/', undefined]);
    expect(frame).toContain('branch main');
    const lines = frame.split('\n');
    const rowOf = (name: string) => lines.findIndex((line) => line.includes(name));
    expect(rowOf(' src')).toBeLessThan(rowOf('README.md'));
    expect(frame).not.toContain('.github');
    renderer.destroy();
  });

  test('Enter on a file reads it and shows the text', async () => {
    const calls = fresh();
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(element(calls), SIZE);
    await settle(flush, 120);
    await press(mockInput, flush, 'j'); // src -> README.md
    await pressEnter(mockInput, flush);
    expect(calls.read).toEqual([['/README.md', undefined]]);
    const frame = captureCharFrame();
    expect(frame).toContain('README.md');
    expect(frame).toContain('A terminal client.');
    renderer.destroy();
  });

  test('h on a file shows its history; y copies the commit hash; h closes', async () => {
    const calls = fresh();
    const copied: string[] = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      element(calls, { onCopy: (text) => copied.push(text) }),
      SIZE,
    );
    await settle(flush, 120);
    await press(mockInput, flush, 'j');
    await press(mockInput, flush, 'h');
    expect(calls.history).toEqual([['README.md', undefined]]);
    const frame = captureCharFrame();
    expect(frame).toContain('history · README.md');
    expect(frame).toContain('Add readme');
    expect(frame).toContain('Ada · 1h');
    await press(mockInput, flush, 'j');
    await press(mockInput, flush, 'y');
    expect(copied).toEqual(['b'.repeat(40)]);
    await press(mockInput, flush, 'h');
    expect(captureCharFrame()).not.toContain('history · README.md');
    renderer.destroy();
  });

  test('b lists branches; Enter on another branch re-reads the tree at that ref', async () => {
    const calls = fresh();
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(element(calls), SIZE);
    await settle(flush, 120);
    await press(mockInput, flush, 'b');
    let frame = captureCharFrame();
    expect(frame).toContain('main (default)');
    expect(frame).toContain('feature-x');
    await act(async () => {
      mockInput.pressArrow('down');
    });
    await settle(flush);
    await pressEnter(mockInput, flush);
    expect(calls.listed.at(-1)).toEqual(['/', 'feature-x']);
    frame = captureCharFrame();
    expect(frame).toContain('branch feature-x');
    renderer.destroy();
  });

  test('a failed root listing shows the status and message', async () => {
    const calls = fresh();
    const failing = loaders(calls, {
      listDirectory: async () => {
        throw Object.assign(new Error('Forbidden'), { status: 403 });
      },
    });
    const { captureCharFrame, flush, renderer } = await testRender(
      element(calls, { loaders: failing }),
      SIZE,
    );
    await settle(flush, 120);
    expect(captureCharFrame()).toContain('403 Forbidden');
    renderer.destroy();
  });

  test('an empty repository says so', async () => {
    const calls = fresh();
    const empty = loaders(calls, { listDirectory: async () => ({ nodes: [], truncated: false }) });
    const { captureCharFrame, flush, renderer } = await testRender(
      element(calls, { loaders: empty }),
      SIZE,
    );
    await settle(flush, 120);
    expect(captureCharFrame()).toContain('Empty repository.');
    renderer.destroy();
  });

  test('a failed history load shows the error in the pane', async () => {
    const calls = fresh();
    const bad = loaders(calls, {
      history: async () => {
        throw new Error('boom');
      },
    });
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      element(calls, { loaders: bad }),
      SIZE,
    );
    await settle(flush, 120);
    await press(mockInput, flush, 'h');
    const frame = captureCharFrame();
    expect(frame).toContain('history · src');
    expect(frame).toContain('boom');
    renderer.destroy();
  });

  test('o opens the web app and o is not eaten by the tree', async () => {
    const calls = fresh();
    let opened = 0;
    const { flush, mockInput, renderer } = await testRender(
      element(calls, { onOpenWeb: () => (opened += 1) }),
      SIZE,
    );
    await settle(flush, 120);
    await press(mockInput, flush, 'o');
    expect(opened).toBe(1);
    renderer.destroy();
  });
});
