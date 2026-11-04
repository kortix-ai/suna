import { describe, expect, test } from 'bun:test';
import { act } from 'react';

import { testRender } from '@opentui/react/test-utils';

import type { CommandContext } from '../../../commands/registry.ts';
import { PromptInput } from './prompt-input.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SIZE = { width: 60, height: 12 };
const CONTEXT: CommandContext = {
  hasProject: true,
  hasSession: true,
  hasAccount: true,
  capabilities: null,
};

/** A transcript above the input: a focusable scroll box, as the session view draws it. */
function Screen({ focused = true, onActivate }: { focused?: boolean; onActivate?: () => void }) {
  return (
    <box flexDirection="column" width={SIZE.width} height={SIZE.height}>
      <scrollbox focusable flexGrow={1}>
        <text>an earlier reply the reader clicks on</text>
      </scrollbox>
      <PromptInput
        focused={focused}
        width={SIZE.width}
        placeholder="Type a prompt"
        context={CONTEXT}
        busy={false}
        onSubmit={() => {}}
        onCommand={() => {}}
        onActivate={onActivate}
      />
    </box>
  );
}

describe('<PromptInput/> keeps the keyboard', () => {
  test('a click on the transcript does not take the keyboard from the input: the next keys still type', async () => {
    const { captureCharFrame, flush, mockInput, mockMouse, renderer } = await testRender(
      <Screen />,
      SIZE,
    );
    await flush();
    // OpenTUI focuses the nearest focusable ancestor of a click (`autoFocus`).
    await act(async () => mockMouse.click(5, 1));
    await flush();
    await act(async () => mockInput.typeText('still here'));
    await flush();
    expect(captureCharFrame()).toContain('still here');
    renderer.destroy();
  });

  test('an input that does not own the keyboard (a picker is open) does not take it back', async () => {
    const { captureCharFrame, flush, mockInput, renderer } = await testRender(
      <Screen focused={false} />,
      SIZE,
    );
    await flush();
    await act(async () => mockInput.typeText('nope'));
    await flush();
    expect(captureCharFrame()).not.toContain('nope');
    renderer.destroy();
  });

  test('a click on the input asks the host for the keyboard (from the sidebar, say)', async () => {
    let asked = 0;
    const { flush, mockMouse, renderer } = await testRender(
      <Screen focused={false} onActivate={() => asked++} />,
      SIZE,
    );
    await flush();
    await act(async () => mockMouse.click(10, SIZE.height - 2));
    await flush();
    expect(asked).toBe(1);
    renderer.destroy();
  });
});
