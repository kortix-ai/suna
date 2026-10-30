import { describe, expect, test } from 'bun:test';
import { act } from 'react';

import { testRender } from '@opentui/react/test-utils';

import { type ArtifactRow } from './artifacts-model.ts';
import { ArtifactsView, type ArtifactsViewProps, artifactRowText } from './artifacts-view.tsx';
import { ARTIFACTS_KEYS } from './keys.ts';

// React 19 needs this before `act`; without it a key press is asserted against
// the frame React had not yet committed.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SIZE = { width: 100, height: 28 };
const NOW = new Date(2026, 9, 30, 12, 0, 0).getTime();
const HOUR = 3_600_000;

function rows(): ArtifactRow[] {
  const base = {
    description: '',
    visibility: 'project',
    pinned: false,
    canManage: true,
    sessionId: null,
    publicUrl: null,
    entry: 'x',
  };
  return [
    {
      ...base,
      id: 'a1',
      title: 'Q3 plan',
      kind: 'doc',
      path: '/workspace/plan.md',
      author: 'Ada',
      sessionId: 'sess-1',
      webUrl: 'https://app.example.test/a1',
      updatedMs: NOW - 2 * HOUR,
    },
    {
      ...base,
      id: 'a2',
      title: 'Launch deck',
      kind: 'html',
      path: '/workspace/deck',
      author: 'Lin',
      canManage: false,
      webUrl: 'https://app.example.test/a2',
      updatedMs: NOW - 30 * HOUR,
    },
  ];
}

function props(over: Partial<ArtifactsViewProps> = {}): ArtifactsViewProps {
  return {
    rows: rows(),
    focused: true,
    width: SIZE.width,
    height: SIZE.height,
    now: NOW,
    loading: false,
    errorMessage: null,
    detail: null,
    onOpenDetails: () => {},
    onOpenWeb: () => {},
    onCopyLink: () => {},
    onRefresh: () => {},
    onRename: () => {},
    onPin: () => {},
    onDelete: () => {},
    onOpenSession: () => {},
    onBack: () => {},
    ...over,
  };
}

async function settle(flush: () => Promise<void>, ms = 40): Promise<void> {
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

async function enter(input: { pressEnter: () => void }, flush: () => Promise<void>): Promise<void> {
  await act(async () => {
    input.pressEnter();
  });
  await settle(flush);
}

describe('ARTIFACTS_KEYS', () => {
  test('every binding is scoped artifacts and ids are unique', () => {
    expect(ARTIFACTS_KEYS.every((b) => b.scope === 'artifacts')).toBe(true);
    expect(new Set(ARTIFACTS_KEYS.map((b) => b.id)).size).toBe(ARTIFACTS_KEYS.length);
  });
});

describe('artifactRowText', () => {
  test('prints the title, then kind, author and age flush right', () => {
    const text = artifactRowText(rows()[0] as ArtifactRow, NOW, 82);
    expect(text.startsWith('Q3 plan')).toBe(true);
    expect(text.trimEnd().endsWith('doc · Ada · 2h')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(81);
  });

  test('a pinned row says so', () => {
    expect(artifactRowText({ ...(rows()[0] as ArtifactRow), pinned: true }, NOW, 82)).toContain(
      '(pinned)',
    );
  });
});

describe('<ArtifactsView/>', () => {
  test('renders one row per artifact with the hint line', async () => {
    const { captureCharFrame, flush, renderer } = await testRender(<ArtifactsView {...props()} />, SIZE);
    await settle(flush);
    const frame = captureCharFrame();
    expect(frame).toContain('Q3 plan');
    expect(frame).toContain('Launch deck');
    expect(frame).toContain('html · Lin · 1d');
    expect(frame).toContain('e rename · p pin · d stop sharing');
    renderer.destroy();
  });

  test('j moves the cursor; the hint drops the write keys on a row the user cannot manage', async () => {
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <ArtifactsView {...props()} />,
      SIZE,
    );
    await settle(flush);
    await press(mockInput, flush, 'j');
    expect(captureCharFrame()).not.toContain('e rename');
    renderer.destroy();
  });

  test('Enter opens details and asks the caller for that artifact', async () => {
    const opened: Array<string | null> = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <ArtifactsView
        {...props({
          onOpenDetails: (id) => opened.push(id),
          detail: {
            loading: false,
            errorMessage: null,
            files: [],
            text: '# Plan\n\nShip it.',
            textLoading: false,
            textError: null,
          },
        })}
      />,
      SIZE,
    );
    await settle(flush);
    await enter(mockInput, flush);
    await settle(flush, 400); // the markdown part paints after an async parse
    expect(opened).toEqual(['a1']);
    const frame = captureCharFrame();
    expect(frame).toContain('/workspace/plan.md');
    expect(frame).toContain('Whole team');
    expect(frame).toContain('Ship it.');
    renderer.destroy();
  });

  test('an HTML artifact lists its files with sizes', async () => {
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <ArtifactsView
        {...props({
          detail: {
            loading: false,
            errorMessage: null,
            files: [{ path: 'index.html', size: 2048 }],
            text: null,
            textLoading: false,
            textError: null,
          },
        })}
      />,
      SIZE,
    );
    await settle(flush);
    await press(mockInput, flush, 'j');
    await enter(mockInput, flush);
    const frame = captureCharFrame();
    expect(frame).toContain('index.html');
    expect(frame).toContain('2.0 KiB');
    renderer.destroy();
  });

  test('o, y and s call back with the selected row', async () => {
    const calls: string[] = [];
    const { flush, mockInput, renderer } = await testRender(
      <ArtifactsView
        {...props({
          onOpenWeb: (r) => calls.push(`web:${r.id}`),
          onCopyLink: (r) => calls.push(`copy:${r.id}`),
          onOpenSession: (id) => calls.push(`session:${id}`),
        })}
      />,
      SIZE,
    );
    await settle(flush);
    await press(mockInput, flush, 'o');
    await press(mockInput, flush, 'y');
    await press(mockInput, flush, 's');
    expect(calls).toEqual(['web:a1', 'copy:a1', 'session:sess-1']);
    renderer.destroy();
  });

  test('d asks first: n cancels, y deletes', async () => {
    const deleted: string[] = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <ArtifactsView {...props({ onDelete: (r) => deleted.push(r.id) })} />,
      SIZE,
    );
    await settle(flush);
    await press(mockInput, flush, 'd');
    expect(captureCharFrame()).toContain('Stop sharing this artifact');
    await press(mockInput, flush, 'n');
    expect(deleted).toEqual([]);
    await press(mockInput, flush, 'd');
    await press(mockInput, flush, 'y');
    expect(deleted).toEqual(['a1']);
    renderer.destroy();
  });

  test('d does nothing on an artifact the user cannot manage', async () => {
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <ArtifactsView {...props()} />,
      SIZE,
    );
    await settle(flush);
    await press(mockInput, flush, 'j');
    await press(mockInput, flush, 'd');
    expect(captureCharFrame()).not.toContain('Stop sharing this artifact');
    renderer.destroy();
  });

  test('p pins through the callback', async () => {
    const pinned: string[] = [];
    const { flush, mockInput, renderer } = await testRender(
      <ArtifactsView {...props({ onPin: (r) => pinned.push(r.id) })} />,
      SIZE,
    );
    await settle(flush);
    await press(mockInput, flush, 'p');
    expect(pinned).toEqual(['a1']);
    renderer.destroy();
  });

  test('e opens the title prompt; typing and Enter rename', async () => {
    const renamed: Array<[string, string]> = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <ArtifactsView {...props({ onRename: (r, title) => renamed.push([r.id, title]) })} />,
      SIZE,
    );
    await settle(flush);
    await press(mockInput, flush, 'e');
    expect(captureCharFrame()).toContain('rename Q3 plan');
    await act(async () => {
      mockInput.typeText('!');
    });
    await settle(flush);
    await enter(mockInput, flush);
    expect(renamed).toEqual([['a1', 'Q3 plan!']]);
    renderer.destroy();
  });

  test('/ filters the list by what is typed', async () => {
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <ArtifactsView {...props()} />,
      SIZE,
    );
    await settle(flush);
    await press(mockInput, flush, '/');
    await act(async () => {
      mockInput.typeText('deck');
    });
    await settle(flush);
    const frame = captureCharFrame();
    expect(frame).toContain('Launch deck');
    expect(frame).not.toContain('Q3 plan');
    renderer.destroy();
  });

  test('empty, loading, error and unavailable states each say what they are', async () => {
    const cases: Array<[Partial<ArtifactsViewProps>, string]> = [
      [{ rows: [] }, 'No artifacts yet'],
      [{ rows: [], loading: true }, 'loading artifacts'],
      [{ rows: [], errorMessage: '403 Forbidden' }, '403 Forbidden'],
      [{ unavailable: 'Artifacts are off for this project. Turn on the `artifacts` flag.' }, 'Artifacts are off'],
      [{ unavailable: 'No project selected. Pick a project to see its artifacts.' }, 'No project selected'],
    ];
    for (const [over, expected] of cases) {
      const { captureCharFrame, flush, renderer } = await testRender(
        <ArtifactsView {...props(over)} />,
        SIZE,
      );
      await settle(flush);
      expect(captureCharFrame()).toContain(expected);
      renderer.destroy();
    }
  });

  test('Esc with nothing open leaves the screen', async () => {
    let left = 0;
    const { flush, mockInput, renderer } = await testRender(
      <ArtifactsView {...props({ onBack: () => (left += 1) })} />,
      SIZE,
    );
    await settle(flush);
    await act(async () => {
      mockInput.pressEscape();
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(left).toBe(1);
    renderer.destroy();
  });
});
