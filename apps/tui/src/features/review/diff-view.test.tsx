import { describe, expect, test } from 'bun:test';
import { act } from 'react';

import { testRender } from '@opentui/react/test-utils';

import { type DiffState, DiffView, pathOfChunk, splitUnifiedPatch } from './diff-view.tsx';
import { TWO_FILE_PATCH } from './test-patch.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SIZE = { width: 84, height: 20 };

describe('splitUnifiedPatch', () => {
  test('splits one combined patch into one chunk per file, in order', () => {
    const files = splitUnifiedPatch(TWO_FILE_PATCH);
    expect(files.map((file) => file.path)).toEqual(['src/app.ts', 'README.md']);
    expect(files[0]?.patch.startsWith('diff --git a/src/app.ts')).toBe(true);
    expect(files[1]?.patch.startsWith('diff --git a/README.md')).toBe(true);
  });

  test('counts body additions and deletions, not the +++/--- headers', () => {
    const files = splitUnifiedPatch(TWO_FILE_PATCH);
    expect(files[0]).toMatchObject({ additions: 2, deletions: 1 });
    expect(files[1]).toMatchObject({ additions: 1, deletions: 0 });
  });

  test('an empty patch is no files', () => {
    expect(splitUnifiedPatch('')).toEqual([]);
    expect(splitUnifiedPatch('   \n ')).toEqual([]);
  });

  test('a header-less patch is kept as one file rather than dropped', () => {
    const bare = ['--- a/x.txt', '+++ b/x.txt', '@@ -1 +1 @@', '-a', '+b'].join('\n');
    const files = splitUnifiedPatch(bare);
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe('x.txt');
  });
});

describe('pathOfChunk', () => {
  test('prefers the `diff --git` post-image path', () => {
    expect(pathOfChunk('diff --git a/old.ts b/new.ts\n--- a/old.ts\n+++ b/new.ts')).toBe('new.ts');
  });

  test('falls back to `---` when the file was deleted', () => {
    expect(pathOfChunk('--- a/gone.ts\n+++ b/dev/null')).toBe('gone.ts');
  });

  test('never returns an empty label', () => {
    expect(pathOfChunk('@@ -1 +1 @@')).toBe('(unknown file)');
  });
});

function readyState(): DiffState {
  const files = splitUnifiedPatch(TWO_FILE_PATCH);
  return {
    kind: 'ready',
    crId: 'cr-1',
    title: '#12 Tighten the boot path',
    baseRef: 'main',
    headRef: 'session/abc',
    files,
    additions: 3,
    deletions: 1,
  };
}

describe('<DiffView/> through the OpenTUI test renderer', () => {
  test('renders the change request header, the file counter and the patch body', async () => {
    const { captureCharFrame, flush, renderer } = await testRender(
      <DiffView
        state={readyState()}
        fileIndex={0}
        mode="unified"
        offset={0}
        width={SIZE.width}
        height={SIZE.height}
      />,
      SIZE,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    await flush();

    const frame = captureCharFrame();
    expect(frame).toContain('#12 Tighten the boot path');
    expect(frame).toContain('+3 -1');
    expect(frame).toContain('1/2 src/app.ts');
    expect(frame).toContain('const extra = 4;');
    renderer.destroy();
  });

  test('a different fileIndex renders the other file', async () => {
    const { captureCharFrame, flush, renderer } = await testRender(
      <DiffView
        state={readyState()}
        fileIndex={1}
        mode="unified"
        offset={0}
        width={SIZE.width}
        height={SIZE.height}
      />,
      SIZE,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    await flush();

    const frame = captureCharFrame();
    expect(frame).toContain('2/2 README.md');
    expect(frame).toContain('A new line.');
    renderer.destroy();
  });

  test('split mode labels itself and still renders the patch', async () => {
    const { captureCharFrame, flush, renderer } = await testRender(
      <DiffView
        state={readyState()}
        fileIndex={0}
        mode="split"
        offset={0}
        width={SIZE.width}
        height={SIZE.height}
      />,
      SIZE,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    await flush();

    const frame = captureCharFrame();
    expect(frame).toContain('split');
    expect(frame).toContain('const extra = 4;');
    renderer.destroy();
  });

  test('a failed diff read renders its message', async () => {
    const { captureCharFrame, flush, renderer } = await testRender(
      <DiffView
        state={{ kind: 'error', crId: 'cr-1', message: 'merge base not found' }}
        fileIndex={0}
        mode="unified"
        offset={0}
        width={SIZE.width}
        height={SIZE.height}
      />,
      SIZE,
    );
    await flush();
    expect(captureCharFrame()).toContain('merge base not found');
    renderer.destroy();
  });

  test('a change request with no file changes says so', async () => {
    const { captureCharFrame, flush, renderer } = await testRender(
      <DiffView
        state={{
          kind: 'ready',
          crId: 'cr-2',
          title: '#13 Empty',
          baseRef: 'main',
          headRef: 'session/x',
          files: [],
          additions: 0,
          deletions: 0,
        }}
        fileIndex={0}
        mode="unified"
        offset={0}
        width={SIZE.width}
        height={SIZE.height}
      />,
      SIZE,
    );
    await flush();
    expect(captureCharFrame()).toContain('no file changes');
    renderer.destroy();
  });
});
