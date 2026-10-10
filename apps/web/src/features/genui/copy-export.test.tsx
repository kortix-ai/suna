import { afterEach, describe, expect, test } from 'bun:test';
import { DEFAULT_TRANSCRIPT_OPTIONS, formatTranscript } from '@kortix/sdk';
// eslint-disable-next-line no-restricted-imports -- pins the SDK composition the export modal uses
import { genuiToMarkdown } from '@kortix/sdk/genui';

import { act, create } from 'react-test-renderer';

import { copyGenuiText, genuiCopyText, mayHoldGenui, useGenuiCopyMessages } from './to-markdown';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const REPLY = 'Done.\n\n```openui\nroot = Stack([b])\nb = Badge("shipped")\n```';

describe('export and copy', () => {
  test('an exported transcript carries markdown, not OpenUI source', () => {
    const messages = [
      {
        info: { id: 'm1', role: 'assistant', time: { created: 0 } },
        parts: [{ id: 'p1', type: 'text', text: REPLY }],
      },
    ] as never;
    const session = { id: 's', title: 'T', time: { created: 0, updated: 0 } };
    const out = genuiToMarkdown(formatTranscript(session, messages, DEFAULT_TRANSCRIPT_OPTIONS));
    expect(out).toContain('[shipped]');
    expect(out).not.toContain('root = Stack');
    expect(out).not.toContain('```openui');
  });
});

describe('genuiCopyText', () => {
  test('text without a generative UI block comes back as the same string', async () => {
    const text = 'Plain **markdown** reply.\n\n```ts\nconst a = 1;\n```';
    expect(await genuiCopyText(text)).toBe(text);
  });

  test('a reply that only mentions OpenUI, with no block, comes back unchanged', async () => {
    const text = 'OpenUI blocks render as components.';
    expect(await genuiCopyText(text)).toBe(text);
  });

  test('a generative UI block becomes its markdown', async () => {
    expect(await genuiCopyText(REPLY)).toBe('Done.\n\n[shipped]');
  });

  test('only text that names OpenUI may hold a block', () => {
    expect(mayHoldGenui('Plain reply.')).toBe(false);
    expect(mayHoldGenui(REPLY)).toBe(true);
  });
});

type Write = { kind: 'write'; items: unknown[] } | { kind: 'writeText'; text: string };

/** Stubs the async clipboard and records each call in order. */
function stubClipboard(withClipboardItem: boolean): Write[] {
  const calls: Write[] = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      write: async (items: unknown[]) => void calls.push({ kind: 'write', items }),
      writeText: async (text: string) => void calls.push({ kind: 'writeText', text }),
    },
  });
  if (withClipboardItem) {
    Object.defineProperty(globalThis, 'ClipboardItem', {
      configurable: true,
      value: class {
        constructor(readonly data: Record<string, Promise<Blob>>) {}
      },
    });
  }
  return calls;
}

describe('copyGenuiText', () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard');
    Reflect.deleteProperty(globalThis, 'ClipboardItem');
  });

  test('plain text is written inside the click, before any await', async () => {
    const calls = stubClipboard(true);
    const done = copyGenuiText('Plain reply.');
    expect(calls).toEqual([{ kind: 'writeText', text: 'Plain reply.' }]);
    await done;
  });

  test('a reply with a block starts the write inside the click and resolves to markdown', async () => {
    const calls = stubClipboard(true);
    const done = copyGenuiText(REPLY);
    expect(calls.map((call) => call.kind)).toEqual(['write']);
    await done;
    const item = (calls[0] as { items: Array<{ data: Record<string, Promise<Blob>> }> }).items[0];
    expect(await (await item.data['text/plain']).text()).toBe('Done.\n\n[shipped]');
  });

  test('without ClipboardItem a reply with a block falls back to writeText with markdown', async () => {
    const calls = stubClipboard(false);
    await copyGenuiText(REPLY);
    expect(calls).toEqual([{ kind: 'writeText', text: 'Done.\n\n[shipped]' }]);
  });
});

describe('useGenuiCopyMessages', () => {
  type Message = { info: { id: string }; parts: { type: string; text?: string }[] };
  const text = (id: string, value: string): Message => ({ info: { id }, parts: [{ type: 'text', text: value }] });
  function harness(messages: Message[]) {
    const seen: (Message[] | null | 'error')[] = [];
    function Probe() {
      seen.push(useGenuiCopyMessages(messages, () => seen.push('error')));
      return null;
    }
    return { seen, Probe };
  }
  const settle = async (seen: unknown[]) => {
    for (let i = 0; i < 20 && !seen.at(-1); i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  };

  test('messages without a block are ready on the first render, unchanged', async () => {
    const messages = [text('m1', 'Plain transcript.')];
    const { seen, Probe } = harness(messages);
    await act(async () => void create(<Probe />));
    expect(seen[0]).toBe(messages);
  });

  test('messages with a block are null until conversion completes, then markdown', async () => {
    const { seen, Probe } = harness([text('m1', REPLY)]);
    await act(async () => void create(<Probe />));
    expect(seen[0]).toBeNull();
    await settle(seen);
    expect((seen.at(-1) as Message[])[0]!.parts[0]!.text).toBe('Done.\n\n[shipped]');
  });

  test('a fence the model never closed stays inside its own message', async () => {
    // Converted as one transcript string, the open fence ran on into the next turn and took it.
    const messages = [
      text('m1', 'Here:\n\n```openui\nroot = Stack([a])\na = Badge("first")'),
      text('m2', 'Second question'),
      text('m3', REPLY),
    ];
    const { seen, Probe } = harness(messages);
    await act(async () => void create(<Probe />));
    await settle(seen);
    const parts = (seen.at(-1) as Message[]).map((message) => message.parts[0]!.text!);
    expect(parts[1]).toBe('Second question');
    expect(parts[2]).toBe('Done.\n\n[shipped]');
    expect(parts.some((part) => part.includes('root ='))).toBe(false);
  });
});
