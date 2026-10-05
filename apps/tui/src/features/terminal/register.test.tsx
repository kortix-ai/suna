/**
 * `<embedded-terminal>` is not a built-in tag in OpenTUI 0.5.11. This test is
 * the proof that `extend()` + the module augmentation actually produce a
 * renderable that paints: it feeds the tag the bytes a PTY would send and
 * asserts they appear in the captured frame.
 */

import { describe, expect, test } from 'bun:test';
import type { EmbeddedTerminalRenderable } from '@opentui/core';
import { testRender } from '@opentui/react/test-utils';
import { useEffect, useRef } from 'react';

import { isEmbeddedTerminalRegistered, registerEmbeddedTerminal } from './register.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

registerEmbeddedTerminal();

function Screen({ bytes }: { bytes: Uint8Array }) {
  const ref = useRef<EmbeddedTerminalRenderable | null>(null);
  useEffect(() => {
    ref.current?.write(bytes);
  }, [bytes]);
  return <embedded-terminal ref={ref} width={40} height={6} />;
}

describe('embedded-terminal registration', () => {
  test('registerEmbeddedTerminal is idempotent', () => {
    registerEmbeddedTerminal();
    registerEmbeddedTerminal();
    expect(isEmbeddedTerminalRegistered()).toBe(true);
  });

  test('renders the tag and paints bytes written into it', async () => {
    const setup = await testRender(
      <Screen bytes={new TextEncoder().encode('kortix@sandbox:/workspace$ hello\r\n')} />,
      { width: 40, height: 6 },
    );
    await setup.renderOnce();
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain('kortix@sandbox:/workspace$ hello');
    setup.renderer.destroy();
  });

  test('VT control bytes are interpreted, not printed', async () => {
    // ESC[2J clears; ESC[H homes. A tag that printed bytes verbatim would show
    // the escape text instead of the word.
    const setup = await testRender(
      <Screen bytes={new TextEncoder().encode('junk\x1b[2J\x1b[HTUI-PTY-OK')} />,
      { width: 40, height: 6 },
    );
    await setup.renderOnce();
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain('TUI-PTY-OK');
    expect(frame).not.toContain('junk');
    expect(frame).not.toContain('[2J');
    setup.renderer.destroy();
  });
});
