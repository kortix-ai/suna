import { describe, expect, test } from 'bun:test';

import type { ClassifiedPart } from '../../core/turns';
import { type PartRenderers, renderParts } from './render-parts';

const renderers: PartRenderers<string> = {
  text: (p) => `text:${p.text}`,
  reasoning: (p) => `reasoning:${p.text}`,
  tool: (p) => `tool:${p.tool.name}`,
  file: (p) => `file:${p.filename ?? p.url}`,
  subtask: (p) => `subtask:${p.agent}`,
  patch: (p) => `patch:${p.fileCount}`,
  snapshot: (p) => `snapshot:${p.snapshot}`,
  agent: (p) => `agent:${p.name}`,
  retry: (p) => `retry:${p.attempt}`,
  compaction: (p) => `compaction:${p.auto}`,
  step: (p) => `step:${p.phase}`,
  unknown: () => 'unknown',
};

describe('renderParts', () => {
  test('dispatches every kind to its matching renderer, in order', () => {
    const parts: ClassifiedPart[] = [
      { kind: 'text', id: '1', text: 'hi', synthetic: false },
      { kind: 'reasoning', id: '2', text: 'thinking' },
      { kind: 'agent', id: '3', name: 'kortix-worker' },
    ];
    expect(renderParts(parts, renderers)).toEqual([
      'text:hi',
      'reasoning:thinking',
      'agent:kortix-worker',
    ]);
  });

  test('unknown parts route through the "unknown" renderer, not a thrown error', () => {
    const parts: ClassifiedPart[] = [{ kind: 'unknown', raw: { type: 'future-thing' } }];
    expect(renderParts(parts, renderers)).toEqual(['unknown']);
  });

  test('falls back to `fallback` when a kind has no renderer (unsafe construction)', () => {
    const partial = {
      text: (p: Extract<ClassifiedPart, { kind: 'text' }>) => p.text,
    } as PartRenderers<string>;
    const withFallback: PartRenderers<string> = { ...partial, fallback: () => 'fallback' };
    const parts: ClassifiedPart[] = [{ kind: 'snapshot', id: 's1', snapshot: 'snap' }];
    expect(renderParts(parts, withFallback)).toEqual(['fallback']);
  });

  test('throws when a kind has no renderer and no fallback is given', () => {
    const partial = {
      text: (p: Extract<ClassifiedPart, { kind: 'text' }>) => p.text,
    } as PartRenderers<string>;
    const parts: ClassifiedPart[] = [{ kind: 'snapshot', id: 's1', snapshot: 'snap' }];
    expect(() => renderParts(parts, partial)).toThrow(
      /no renderer registered for part kind "snapshot"/,
    );
  });
});
