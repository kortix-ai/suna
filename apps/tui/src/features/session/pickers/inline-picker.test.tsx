import { expect, test } from 'bun:test';
import { act } from 'react';
import { testRender } from '@opentui/react/test-utils';
import { InlinePicker } from './inline-picker.tsx';

test('scrolling skips headings and preserves a long right column', async () => {
  const picked: string[] = [];
  const { captureCharFrame, flush, mockInput, renderer } = await testRender(
    <InlinePicker
      title="Models"
      items={[
        { id: 'heading', label: 'Provider' },
        { id: 'first', label: 'First' },
        { id: 'second', label: 'Second' },
        { id: 'third', label: 'Third' },
        { id: 'last', label: 'Last', right: 'RIGHT-COLUMN-IS-LONG' },
      ]}
      headerIds={new Set(['heading'])}
      onPick={(item) => picked.push(item.id)}
      onClose={() => {}}
      width={24}
      maxRows={3}
    />,
    { width: 40, height: 12 },
  );
  try {
    await flush();
    expect(captureCharFrame()).toContain('Provider');
    await act(async () => { mockInput.pressEnter(); });
    await flush();
    expect(picked).toEqual(['first']);
    for (let index = 0; index < 3; index += 1) {
      await act(async () => { mockInput.pressKey('\x1b[B'); });
      await flush();
    }
    const frame = captureCharFrame();
    expect(frame).not.toContain('Provider');
    expect(frame).not.toContain('First');
    expect(frame).toContain('Third');
    expect(frame).toContain('… RIGHT-COLUMN-IS-');
    await act(async () => { mockInput.pressEnter(); });
    await flush();
    expect(picked).toEqual(['first', 'last']);
  } finally {
    renderer.destroy();
  }
});
