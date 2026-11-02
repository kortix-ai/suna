import { describe, expect, test } from 'bun:test';
import { act } from 'react';

import { testRender } from '@opentui/react/test-utils';

import { useCopyOnSelect } from './copy-on-select.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SIZE = { width: 50, height: 6 };

function Screen({ onCopied }: { onCopied: (text: string) => void }) {
  useCopyOnSelect(onCopied);
  return (
    <box flexDirection="column">
      <text>alpha beta gamma</text>
    </box>
  );
}

describe('useCopyOnSelect', () => {
  test('releasing a drag copies the selected text to the clipboard (OSC 52) and says so', async () => {
    const copied: string[] = [];
    const written: string[] = [];
    const { flush, mockMouse, renderer } = await testRender(
      <Screen onCopied={(text) => copied.push(text)} />,
      SIZE,
    );
    renderer.copyToClipboardOSC52 = (text: string) => {
      written.push(text);
      return true;
    };
    await flush();
    await act(async () => mockMouse.drag(0, 0, 9, 0));
    await flush();
    expect(written).toEqual(['alpha beta']);
    expect(copied).toEqual(['alpha beta']);
    renderer.destroy();
  });

  test('a plain click (no drag) copies nothing', async () => {
    const copied: string[] = [];
    const { flush, mockMouse, renderer } = await testRender(
      <Screen onCopied={(text) => copied.push(text)} />,
      SIZE,
    );
    renderer.copyToClipboardOSC52 = () => true;
    await flush();
    await act(async () => mockMouse.click(3, 0));
    await flush();
    expect(copied).toEqual([]);
    renderer.destroy();
  });
});
