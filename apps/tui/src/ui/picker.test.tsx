/**
 * The picker's regression: at a terminal narrower than the requested width the
 * modal clamps but the picker's own rule and list did not, so a 60-column
 * separator was drawn inside a 26-column box. Reproduced at 34 columns.
 */

import { describe, expect, test } from 'bun:test';

import { testRender } from '@opentui/react/test-utils';

import { MODAL_CHROME_COLUMNS, MODAL_CHROME_ROWS, modalBox } from './modal.tsx';
import { Picker, filterItems } from './picker.tsx';

const ITEMS = [
  { id: 'a', label: 'Casual greeting' },
  { id: 'b', label: 'Fix claims lifecycle' },
  { id: 'c', label: 'Deal sourcing' },
];

describe('modalBox', () => {
  test('a request that fits is honored', () => {
    expect(modalBox({ width: 120, height: 40 }, 60, 18)).toEqual({
      boxWidth: 60,
      boxHeight: 18,
      innerWidth: 60 - MODAL_CHROME_COLUMNS,
      innerHeight: 18 - MODAL_CHROME_ROWS,
    });
  });

  test('a narrow terminal clamps the box and the inner width with it', () => {
    const box = modalBox({ width: 34, height: 12 }, 72, 20);
    expect(box.boxWidth).toBe(30);
    expect(box.innerWidth).toBe(26);
    expect(box.boxHeight).toBe(8);
  });

  test('the box never collapses below a usable floor', () => {
    const box = modalBox({ width: 10, height: 4 }, 72, 20);
    expect(box.boxWidth).toBe(20);
    expect(box.innerWidth).toBeGreaterThan(0);
    expect(box.innerHeight).toBeGreaterThan(0);
  });
});

describe('filterItems', () => {
  test('is a case-insensitive substring match', () => {
    expect(filterItems(ITEMS, 'CLAIM').map((item) => item.id)).toEqual(['b']);
    expect(filterItems(ITEMS, '   ').map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('<Picker/> at 34 columns', () => {
  test('nothing it draws is wider than the clamped box', async () => {
    const { captureCharFrame, flush, renderer } = await testRender(
      <Picker title="Go to" items={ITEMS} onPick={() => {}} onClose={() => {}} width={72} />,
      { width: 34, height: 12 },
    );
    await flush();
    const lines = captureCharFrame().split('\n').filter(Boolean);
    // Every row is exactly the terminal width, padded — nothing wrapped onto a
    // row of its own, which is what an unclamped 68-column rule did.
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(34);
    const frame = lines.join('\n');
    expect(frame).toContain('Go to');
    expect(frame).toContain('Casual greeting');
    // The rule is drawn from the clamped inner width (26), never the request.
    expect(frame).toContain('─'.repeat(26));
    expect(frame).not.toContain('─'.repeat(40));
    renderer.destroy();
  });

  test('at a wide terminal it uses the requested width', async () => {
    const { captureCharFrame, flush, renderer } = await testRender(
      <Picker title="Go to" items={ITEMS} onPick={() => {}} onClose={() => {}} width={60} />,
      { width: 120, height: 30 },
    );
    await flush();
    expect(captureCharFrame()).toContain('─'.repeat(56));
    renderer.destroy();
  });
});
