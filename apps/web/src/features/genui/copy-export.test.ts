import { describe, expect, test } from 'bun:test';
import { DEFAULT_TRANSCRIPT_OPTIONS, formatTranscript } from '@kortix/sdk';
// eslint-disable-next-line no-restricted-imports -- pins the SDK composition the export modal uses
import { genuiToMarkdown } from '@kortix/sdk/genui';

import { genuiCopyText, mayHoldGenui } from './to-markdown';

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
