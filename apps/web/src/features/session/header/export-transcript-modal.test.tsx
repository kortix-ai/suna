import { describe, expect, test } from 'bun:test';
import { readFileSync } from '@/i18n/test-source';
import { DEFAULT_TRANSCRIPT_OPTIONS, formatTranscript } from '@kortix/sdk';
import { fileURLToPath } from 'node:url';
import { act, create } from 'react-test-renderer';

import { useGenuiCopyText } from '@/features/genui/to-markdown';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const source = readFileSync(fileURLToPath(new URL('./export-transcript-modal.tsx', import.meta.url)), 'utf8');

describe('transcript export options', () => {
  test('renders metadata, tool details, then thinking with their own labels and descriptions', () => {
    const ids = ['opt-metadata', 'opt-tools', 'opt-thinking'];
    const positions = ids.map((id) => source.indexOf(`id: '${id}'`));
    expect(positions[0]).toBeGreaterThan(-1);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(source).toContain('htmlFor={id}');
    expect(source).toContain('<Switch id={id} checked={checked} onCheckedChange={onToggle} />');
    for (const text of ['AssistantMetadata', 'ToolCallDetails', 'ThinkingReasoning']) {
      expect(source).toContain(`JsxText${text}'`);
      expect(source).toContain(`JsxText${text}Description'`);
    }
  });

  test('each switch toggles only its corresponding TranscriptOptions key', () => {
    for (const key of ['assistantMetadata', 'toolDetails', 'thinking']) {
      expect(source).toContain(`key: '${key}'`);
    }
    expect(source).toContain('checked={options[key]}');
    expect(source).toContain('onToggle={() => toggleOption(key)}');
    expect(source).toContain('setOptions((prev) => ({ ...prev, [key]: !prev[key] }))');
  });
});

describe('transcript export with generative UI', () => {
  test('a transcript with a block keeps both actions disabled until conversion completes, then exports markdown', async () => {
    // The modal's transcript is the hook's result; both actions read it.
    expect(source).toContain('const transcript = useGenuiCopyText(rawTranscript, onConvertError);');
    expect(source.split('disabled={!transcript || isLoadingMessages}')).toHaveLength(3);
    expect(source).toContain('await navigator.clipboard.writeText(transcript);');
    expect(source).toContain("new Blob([transcript], { type: 'text/markdown;charset=utf-8' })");

    const messages = [
      {
        info: { id: 'm1', role: 'assistant', time: { created: 0 } },
        parts: [{ id: 'p1', type: 'text', text: 'Done.\n\n```openui\nroot = Stack([b])\nb = Badge("shipped")\n```' }],
      },
    ] as never;
    const raw = formatTranscript({ id: 's', title: 'T', time: { created: 0, updated: 0 } }, messages, DEFAULT_TRANSCRIPT_OPTIONS);
    const seen: string[] = [];
    const onError = () => seen.push('error');
    function Probe() {
      seen.push(useGenuiCopyText(raw, onError));
      return null;
    }
    await act(async () => void create(<Probe />));
    // The converter is a dynamic import of the SDK barrel: give it a few turns of the event loop.
    for (let i = 0; i < 20 && !seen.at(-1); i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(seen[0]).toBe('');
    const exported = seen.at(-1)!;
    expect(exported).toContain('[shipped]');
    expect(seen.some((text) => text.includes('root ='))).toBe(false);
    expect(seen).not.toContain('error');
  });
});
