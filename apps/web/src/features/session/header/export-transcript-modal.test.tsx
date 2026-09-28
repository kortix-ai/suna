import { describe, expect, test } from 'bun:test';
import { readFileSync } from '@/i18n/test-source';
import { fileURLToPath } from 'node:url';

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
