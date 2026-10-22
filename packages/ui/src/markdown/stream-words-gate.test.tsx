/**
 * The stream fade gate (KRTX-2932): a message that mounts mid-stream shows the
 * words it already holds without the per-word fade, and fades only the words
 * that arrive after. Runs against `happy-dom`.
 */
import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
const win = new Window();
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;

const { StreamFadeGateContext, StreamWord, STREAM_WORD_CLASS, createStreamFadeGate } = await import('./stream-words');
type StreamFadeGate = import('./stream-words').StreamFadeGate;

function Message({ words, gate }: { words: string[]; gate: StreamFadeGate }) {
  return (
    <StreamFadeGateContext.Provider value={gate}>
      <div className="kortix-markdown">
        <ul>
          <li>
            {words.map((w) => (
              <StreamWord key={w}>{w}</StreamWord>
            ))}
          </li>
        </ul>
      </div>
    </StreamFadeGateContext.Provider>
  );
}

async function render(gate: StreamFadeGate) {
  const host = document.createElement('div');
  const root = createRoot(host as unknown as HTMLElement);
  const show = async (words: string[]) => {
    await act(async () => root.render(<Message words={words} gate={gate} />));
  };
  const animation = (word: string) =>
    [...host.querySelectorAll<HTMLElement>(`.${STREAM_WORD_CLASS}`)].find((n) => n.textContent === word)!.style.animation;
  return { host, root, show, animation };
}

describe('StreamFadeGate', () => {
  test('a message that mounts mid-stream shows its words and chrome at once, then fades only new words', async () => {
    const m = await render(createStreamFadeGate(false));
    await m.show(['already', 'here']);
    expect(m.animation('already')).toBe('none');
    expect(m.animation('here')).toBe('none');
    expect((m.host.querySelector('li') as unknown as HTMLElement).style.animation).toBe('none');

    await m.show(['already', 'here', 'new']);
    expect(m.animation('new')).toBe('');
    act(() => m.root.unmount());
  });

  test('a message that mounts settled fades every word it streams later', async () => {
    const m = await render(createStreamFadeGate(true));
    await m.show(['first']);
    expect(m.animation('first')).toBe('');
    act(() => m.root.unmount());
  });
});
