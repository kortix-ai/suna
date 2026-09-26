import { describe, expect, test } from 'bun:test';
import { act } from 'react';

import { testRender } from '@opentui/react/test-utils';

import type { TreeNode } from './file-tree.ts';
import type { ReadResult } from './file-viewer.tsx';
import { type FileLoaders, FilesScreen, FilesView, type SessionState } from './files-screen.tsx';

// React 19 needs this before `act`; without it a key press is asserted against
// the frame React had not yet committed. See docs/opentui-notes.md.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SIZE = { width: 90, height: 24 };

const ROOT_NODES: TreeNode[] = [
  { name: 'README.md', path: '/workspace/README.md', type: 'file', ignored: false },
  { name: 'src', path: '/workspace/src', type: 'directory', ignored: false },
  { name: 'logo.png', path: '/workspace/logo.png', type: 'file', ignored: false },
  { name: '.git', path: '/workspace/.git', type: 'directory', ignored: false },
];

const SRC_NODES: TreeNode[] = [
  { name: 'index.ts', path: '/workspace/src/index.ts', type: 'file', ignored: false },
];

const FILES: Record<string, ReadResult> = {
  '/workspace/README.md': { type: 'text', content: '# Kortix\n\nA terminal client.\n' },
  '/workspace/src/index.ts': { type: 'text', content: "export const boot = 'yes';\n" },
  '/workspace/logo.png': { type: 'binary', content: 'AAAA'.repeat(64), encoding: 'base64' },
};

interface Calls {
  listed: string[];
  read: string[];
}

function loaders(calls: Calls, overrides: Partial<FileLoaders> = {}): FileLoaders {
  return {
    listDirectory: async (path: string) => {
      calls.listed.push(path);
      if (path === '/workspace') return ROOT_NODES;
      if (path === '/workspace/src') return SRC_NODES;
      throw new Error(`no such directory ${path}`);
    },
    readFile: async (path: string) => {
      calls.read.push(path);
      const result = FILES[path];
      if (!result) throw new Error(`no such file ${path}`);
      return result;
    },
    ...overrides,
  };
}

/** Let React commit and the renderer paint; the loaders are microtask-async. */
async function settle(flush: () => Promise<void>, ms = 60): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
  await flush();
}

async function press(
  mockInput: { pressKey: (key: string) => void },
  flush: () => Promise<void>,
  key: string,
): Promise<void> {
  await act(async () => {
    mockInput.pressKey(key);
  });
  await settle(flush);
}

async function pressEnter(
  mockInput: { pressEnter: () => void },
  flush: () => Promise<void>,
): Promise<void> {
  await act(async () => {
    mockInput.pressEnter();
  });
  await settle(flush);
}

function view(props: Partial<React.ComponentProps<typeof FilesView>> = {}) {
  const calls: Calls = { listed: [], read: [] };
  const element = (
    <FilesView
      loaders={props.loaders ?? loaders(calls)}
      focused
      width={SIZE.width}
      height={SIZE.height}
      onBack={props.onBack ?? (() => {})}
      onToast={props.onToast}
    />
  );
  return { element, calls };
}

describe('<FilesView/> through the OpenTUI test renderer', () => {
  test('lists /workspace on mount, directories first, files after', async () => {
    const { element, calls } = view();
    const { captureCharFrame, flush, renderer } = await testRender(element, SIZE);
    await settle(flush, 120);

    const frame = captureCharFrame();
    expect(calls.listed).toEqual(['/workspace']);
    expect(frame).toContain('/workspace');
    const lines = frame.split('\n');
    const rowOf = (name: string) => lines.findIndex((line) => line.includes(name));
    // Directory first, then the two files in case-insensitive name order.
    expect(rowOf(' src')).toBeLessThan(rowOf('logo.png'));
    expect(rowOf('logo.png')).toBeLessThan(rowOf('README.md'));
    // A directory carries the collapsed marker; a file does not.
    expect(lines[rowOf(' src')]).toContain('▸');
    renderer.destroy();
  });

  test('Enter on a directory expands it and lists its children indented', async () => {
    const { element, calls } = view();
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(element, SIZE);
    await settle(flush, 120);

    // The cursor starts on the first row, which is `src`.
    await pressEnter(mockInput, flush);
    await settle(flush, 120);

    expect(calls.listed).toEqual(['/workspace', '/workspace/src']);
    const childRow = captureCharFrame()
      .split('\n')
      .find((line) => line.includes('index.ts'));
    expect(childRow).toBeDefined();
    // Depth 1 renders two leading spaces before the glyph column.
    expect(childRow).toMatch(/^\s{3,}index\.ts/);
    renderer.destroy();
  });

  test('Enter on a file calls the loader and the viewer shows its content', async () => {
    const { element, calls } = view();
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(element, SIZE);
    await settle(flush, 120);

    // src, logo.png, README.md — two moves down reaches README.md.
    await press(mockInput, flush, 'j');
    await press(mockInput, flush, 'j');
    await pressEnter(mockInput, flush);
    await settle(flush, 150);

    expect(calls.read).toEqual(['/workspace/README.md']);
    const frame = captureCharFrame();
    expect(frame).toContain('/workspace/README.md');
    expect(frame).toContain('# Kortix');
    expect(frame).toContain('A terminal client.');
    // The gutter numbers the lines it shows.
    expect(frame).toMatch(/1\s+# Kortix/);
    renderer.destroy();
  });

  test('an image renders as one placeholder line with its size', async () => {
    const { element } = view();
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(element, SIZE);
    await settle(flush, 120);

    await press(mockInput, flush, 'j');
    await pressEnter(mockInput, flush);
    await settle(flush, 150);

    const frame = captureCharFrame();
    expect(frame).toContain('/workspace/logo.png');
    expect(frame).toContain('image · 192 B');
    expect(frame).toContain('not rendered in a terminal');
    renderer.destroy();
  });

  test('/ filters the loaded rows by name and Esc clears it', async () => {
    const { element } = view();
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(element, SIZE);
    await settle(flush, 120);

    await press(mockInput, flush, '/');
    await act(async () => {
      mockInput.typeText('log', 8);
    });
    await settle(flush, 200);

    const filtered = captureCharFrame();
    expect(filtered).toContain('logo.png');
    expect(filtered).not.toContain('README.md');

    await act(async () => {
      mockInput.pressEscape();
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    await flush();
    expect(captureCharFrame()).toContain('README.md');
    renderer.destroy();
  });

  test('a directory that fails to list marks the row instead of throwing', async () => {
    const calls: Calls = { listed: [], read: [] };
    const failing = loaders(calls, {
      listDirectory: async (path: string) => {
        calls.listed.push(path);
        if (path === '/workspace') return ROOT_NODES;
        throw new Error('daemon unreachable');
      },
    });
    const { flush, mockInput, captureCharFrame, renderer } = await testRender(
      <FilesView
        loaders={failing}
        focused
        width={SIZE.width}
        height={SIZE.height}
        onBack={() => {}}
      />,
      SIZE,
    );
    await settle(flush, 120);
    await pressEnter(mockInput, flush);
    await settle(flush, 150);

    const srcRow = captureCharFrame()
      .split('\n')
      .find((line) => line.includes(' src'));
    expect(srcRow).toContain('!');
    renderer.destroy();
  });

  test('dot entries are hidden until . turns them on', async () => {
    const { element } = view();
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(element, SIZE);
    await settle(flush, 120);
    expect(captureCharFrame()).not.toContain('.git');

    await press(mockInput, flush, '.');
    expect(captureCharFrame()).toContain('.git');
    expect(captureCharFrame()).toContain('. hide dotfiles');

    await press(mockInput, flush, '.');
    expect(captureCharFrame()).not.toContain('.git');
    renderer.destroy();
  });

  test('J never scrolls a short file past its last full page', async () => {
    const { element } = view();
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(element, SIZE);
    await settle(flush, 120);

    // src, logo.png, README.md — README.md is a 3-line file.
    await press(mockInput, flush, 'j');
    await press(mockInput, flush, 'j');
    await pressEnter(mockInput, flush);
    await settle(flush, 150);
    expect(captureCharFrame()).toContain('1-3/3');

    await press(mockInput, flush, 'J');
    expect(captureCharFrame()).toContain('1-3/3');
    expect(captureCharFrame()).toContain('# Kortix');
    renderer.destroy();
  });

  test('Esc with no filter leaves the screen', async () => {
    let backs = 0;
    const calls: Calls = { listed: [], read: [] };
    const { flush, mockInput, renderer } = await testRender(
      <FilesView
        loaders={loaders(calls)}
        focused
        width={SIZE.width}
        height={SIZE.height}
        onBack={() => {
          backs += 1;
        }}
      />,
      SIZE,
    );
    await settle(flush, 120);
    await act(async () => {
      mockInput.pressEscape();
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    await flush();
    expect(backs).toBe(1);
    renderer.destroy();
  });
});

/** Only the `useSession` fields the readiness gate reads. */
function sessionStub(overrides: Partial<SessionState>): SessionState {
  return {
    phase: 'starting',
    stage: 'provisioning',
    reason: null,
    startError: null,
    activelyStarting: false,
    ...overrides,
  } as unknown as SessionState;
}

describe('<FilesScreen/> readiness gate', () => {
  test('a session that is not ready renders its phase instead of spinning', async () => {
    const { captureCharFrame, flush, renderer } = await testRender(
      <FilesScreen
        projectId="p1"
        sessionId="s1"
        focused
        width={SIZE.width}
        height={SIZE.height}
        onBack={() => {}}
        session={sessionStub({ reason: 'runtime_waking', activelyStarting: true })}
      />,
      SIZE,
    );
    await settle(flush);
    const frame = captureCharFrame();
    expect(frame).toContain('runtime provisioning · runtime_waking');
    expect(frame).toContain('Open the session to start it');
    expect(frame).toContain('Esc back');
    renderer.destroy();
  });

  test('a failed runtime says so and Esc still leaves', async () => {
    let backs = 0;
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <FilesScreen
        projectId="p1"
        sessionId="s1"
        focused
        width={SIZE.width}
        height={SIZE.height}
        onBack={() => {
          backs += 1;
        }}
        session={sessionStub({
          phase: 'error',
          stage: 'failed',
          // `SessionStartError` carries a `terminal` flag on top of Error; the
          // gate only reads `.message`.
          startError: Object.assign(new Error('no capacity'), {
            terminal: true,
          }) as SessionState['startError'],
        })}
      />,
      SIZE,
    );
    await settle(flush);
    expect(captureCharFrame()).toContain('runtime failed · no capacity');
    await act(async () => {
      mockInput.pressEscape();
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    await flush();
    expect(backs).toBe(1);
    renderer.destroy();
  });
});
