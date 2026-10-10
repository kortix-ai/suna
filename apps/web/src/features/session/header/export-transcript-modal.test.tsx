import { describe, expect, test } from 'bun:test';
import { readFileSync } from '@/i18n/test-source';
import { DEFAULT_TRANSCRIPT_OPTIONS, formatTranscript, type MessageWithParts } from '@kortix/sdk';
import { fileURLToPath } from 'node:url';
import { act, create } from 'react-test-renderer';

import { useGenuiCopyMessages } from '@/features/genui/to-markdown';

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
    // The modal formats the transcript from the converted messages; both actions read it.
    expect(source).toContain('const exportMessages = useGenuiCopyMessages(messages, onConvertError);');
    expect(source).toContain('if (!session || !exportMessages || exportMessages.length === 0) return');
    expect(source.split('disabled={!transcript || isLoadingMessages}')).toHaveLength(3);
    expect(source).toContain('await navigator.clipboard.writeText(transcript);');
    expect(source).toContain("new Blob([transcript], { type: 'text/markdown;charset=utf-8' })");

    const messages = [
      {
        info: { id: 'm1', role: 'assistant', time: { created: 0 } },
        parts: [{ id: 'p1', type: 'text', text: 'Done.\n\n```openui\nroot = Stack([b])\nb = Badge("shipped")\n```' }],
      },
    ] as never as MessageWithParts[];
    const seen: (MessageWithParts[] | null | 'error')[] = [];
    function Probe() {
      seen.push(useGenuiCopyMessages(messages, () => seen.push('error')));
      return null;
    }
    await act(async () => void create(<Probe />));
    // The converter is a dynamic import of the SDK barrel: give it a few turns of the event loop.
    for (let i = 0; i < 20 && !seen.at(-1); i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(seen[0]).toBeNull();
    const exported = formatTranscript({ id: 's', title: 'T', time: { created: 0, updated: 0 } }, seen.at(-1) as MessageWithParts[], DEFAULT_TRANSCRIPT_OPTIONS);
    expect(exported).toContain('[shipped]');
    expect(exported).not.toContain('root =');
    expect(seen).not.toContain('error');
  });
});
