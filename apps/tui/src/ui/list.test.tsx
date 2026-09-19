import { describe, expect, test } from 'bun:test';
import { act } from 'react';

import { testRender } from '@opentui/react/test-utils';

import { List, type ListItem, clampIndex, layoutRow, windowStart } from './list.tsx';

// React 19 needs this before `act`. Without `act` a key press updates state
// but the next frame is captured before React commits, so the assertion reads
// the previous frame. See docs/opentui-notes.md.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ITEMS: ListItem[] = [
  { id: 'a', label: 'Alpha', right: '1m' },
  { id: 'b', label: 'Bravo', right: '2m' },
  { id: 'c', label: 'Charlie', right: '3m' },
];

describe('list geometry helpers', () => {
  test('clampIndex bounds the selection', () => {
    expect(clampIndex(-4, 3)).toBe(0);
    expect(clampIndex(9, 3)).toBe(2);
    expect(clampIndex(1, 3)).toBe(1);
    expect(clampIndex(0, 0)).toBe(-1);
  });

  test('windowStart keeps the selection inside the window', () => {
    expect(windowStart(0, 10, 4)).toBe(0);
    expect(windowStart(5, 10, 4)).toBe(3);
    expect(windowStart(9, 10, 4)).toBe(6);
    expect(windowStart(2, 3, 10)).toBe(0);
  });

  test('layoutRow fills the width and right-aligns the second column', () => {
    expect(layoutRow('Alpha', '1m', 20)).toBe('Alpha             1m');
    expect(layoutRow('Alpha', '1m', 20)).toHaveLength(20);
  });

  test('layoutRow truncates a label that would collide with the right column', () => {
    expect(layoutRow('a-very-long-session-name', '9m', 12)).toBe('a-very-l… 9m');
  });

  test('layoutRow with no right column does not pad', () => {
    expect(layoutRow('Alpha', '', 20)).toBe('Alpha');
  });
});

describe('<List/> through the OpenTUI test renderer', () => {
  test('renders every row with its right column', async () => {
    const { captureCharFrame, flush, renderer } = await testRender(
      <List items={ITEMS} focused width={24} />,
      { width: 30, height: 6 },
    );
    await flush();
    const rows = captureCharFrame().split('\n');
    expect(rows[0]).toContain('Alpha');
    expect(rows[0]).toContain('1m');
    expect(rows[1]).toContain('Bravo');
    expect(rows[2]).toContain('Charlie');
    renderer.destroy();
  });

  test('j / k / G move the selection marker and report it', async () => {
    const picked: string[] = [];
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <List items={ITEMS} focused width={24} onSelectedChange={(id) => picked.push(id)} />,
      { width: 30, height: 6 },
    );
    await flush();
    expect(captureCharFrame().split('\n')[0]?.startsWith('▌')).toBe(true);

    await act(async () => mockInput.pressKey('j'));
    await flush();
    expect(picked).toEqual(['b']);
    const afterDown = captureCharFrame().split('\n');
    expect(afterDown[0]?.startsWith(' ')).toBe(true);
    expect(afterDown[1]?.startsWith('▌')).toBe(true);

    await act(async () => mockInput.pressKey('k'));
    await flush();
    expect(picked).toEqual(['b', 'a']);
    expect(captureCharFrame().split('\n')[0]?.startsWith('▌')).toBe(true);

    await act(async () => mockInput.pressKey('G'));
    await flush();
    expect(picked.at(-1)).toBe('c');
    expect(captureCharFrame().split('\n')[2]?.startsWith('▌')).toBe(true);

    await act(async () => mockInput.pressKey('g'));
    await flush();
    expect(picked.at(-1)).toBe('a');
    renderer.destroy();
  });

  test('arrow keys move the selection too', async () => {
    const picked: string[] = [];
    const { flush, mockInput, renderer } = await testRender(
      <List items={ITEMS} focused width={24} onSelectedChange={(id) => picked.push(id)} />,
      { width: 30, height: 6 },
    );
    await flush();
    await act(async () => mockInput.pressArrow('down'));
    await flush();
    expect(picked).toEqual(['b']);
    renderer.destroy();
  });

  test('Enter opens the selected row', async () => {
    const opened: string[] = [];
    const { flush, mockInput, renderer } = await testRender(
      <List items={ITEMS} focused width={24} onOpen={(item) => opened.push(item.id)} />,
      { width: 30, height: 6 },
    );
    await flush();
    await act(async () => mockInput.pressKey('j'));
    await flush();
    await act(async () => mockInput.pressEnter());
    await flush();
    expect(opened).toEqual(['b']);
    renderer.destroy();
  });

  test('an unfocused list ignores keys', async () => {
    const picked: string[] = [];
    const { flush, mockInput, renderer } = await testRender(
      <List items={ITEMS} focused={false} width={24} onSelectedChange={(id) => picked.push(id)} />,
      { width: 30, height: 6 },
    );
    await flush();
    await act(async () => mockInput.pressKey('j'));
    await flush();
    expect(picked).toEqual([]);
    renderer.destroy();
  });

  test('a windowed list renders only maxRows rows and scrolls to the selection', async () => {
    const many: ListItem[] = Array.from({ length: 10 }, (_, index) => ({
      id: `s${index}`,
      label: `Session ${index}`,
    }));
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <List items={many} focused width={24} maxRows={3} />,
      { width: 30, height: 6 },
    );
    await flush();
    const first = captureCharFrame().split('\n');
    expect(first[0]).toContain('Session 0');
    expect(first[3]?.trim()).toBe('');

    await act(async () => mockInput.pressKey('G'));
    await flush();
    const last = captureCharFrame().split('\n');
    expect(last.slice(0, 3).join('\n')).toContain('Session 9');
    expect(last.slice(0, 3).join('\n')).not.toContain('Session 0');
    renderer.destroy();
  });

  test('an empty list prints its empty text', async () => {
    const { captureCharFrame, flush, renderer } = await testRender(
      <List items={[]} focused emptyText="No sessions yet." width={24} />,
      { width: 30, height: 4 },
    );
    await flush();
    expect(captureCharFrame()).toContain('No sessions yet.');
    renderer.destroy();
  });
});
