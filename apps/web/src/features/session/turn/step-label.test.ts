import type { Part, ToolPart } from '@/ui';
import { describe, expect, test } from 'bun:test';
import { stepLabel } from './step-label';

function tool(name: string, input: Record<string, unknown> = {}): ToolPart {
  return {
    id: 't1',
    type: 'tool',
    tool: name,
    callID: 'call_1',
    state: { status: 'completed', input },
  } as unknown as ToolPart;
}

describe('stepLabel', () => {
  test('read is primary, past tense Read, object is the basename', () => {
    expect(stepLabel(tool('read', { filePath: '/workspace/src/jobs-queue.ts' }))).toEqual({
      verb: 'Read',
      running: 'Reading',
      object: 'jobs-queue.ts',
      tier: 'primary',
    });
  });

  test('bash is primary and its object is the command', () => {
    const label = stepLabel(tool('bash', { command: 'bun test enrichment' }));
    expect(label.verb).toBe('Ran');
    expect(label.running).toBe('Running');
    expect(label.object).toBe('bun test enrichment');
    expect(label.tier).toBe('primary');
  });

  test('web_search is primary and its object is the query', () => {
    const label = stepLabel(tool('web_search', { query: 'postgres advisory lock' }));
    expect(label.verb).toBe('Searched');
    expect(label.object).toBe('postgres advisory lock');
    expect(label.tier).toBe('primary');
  });

  test('the oc- prefix and hyphens normalize', () => {
    expect(stepLabel(tool('oc-web-search', { query: 'x' })).verb).toBe('Searched');
  });

  test('a reasoning part is tier reasoning', () => {
    const part = { id: 'r1', type: 'reasoning', text: 'thinking' } as unknown as Part;
    expect(stepLabel(part)).toEqual({
      verb: 'Thought',
      running: 'Thinking',
      object: undefined,
      tier: 'reasoning',
    });
  });

  test('memory tools are tier plumbing', () => {
    expect(stepLabel(tool('memory')).tier).toBe('plumbing');
    expect(stepLabel(tool('get_mem')).tier).toBe('plumbing');
    expect(stepLabel(tool('memory_search')).tier).toBe('plumbing');
  });

  test('dcp and context tools are tier plumbing', () => {
    expect(stepLabel(tool('dcp_compress')).tier).toBe('plumbing');
    expect(stepLabel(tool('dcp_distill')).tier).toBe('plumbing');
    expect(stepLabel(tool('dcp_prune')).tier).toBe('plumbing');
    expect(stepLabel(tool('context_info')).tier).toBe('plumbing');
  });

  test('an unknown tool falls back to primary with a generic verb, never dropped', () => {
    const label = stepLabel(tool('some_future_tool'));
    expect(label.tier).toBe('primary');
    expect(label.verb).toBe('Used');
    expect(label.object).toBe('some_future_tool');
  });

  test('a missing input yields no object rather than throwing', () => {
    expect(stepLabel(tool('read')).object).toBeUndefined();
  });
});
