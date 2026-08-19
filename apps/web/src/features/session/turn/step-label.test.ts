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

function toolWithInput(name: string, input: unknown): ToolPart {
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

  test('memory LOOKUPS are tier plumbing (W8)', () => {
    // The agent consulting itself. Nothing changed, so nothing is owed a row.
    expect(stepLabel(tool('get_mem')).tier).toBe('plumbing');
    expect(stepLabel(tool('memory_search')).tier).toBe('plumbing');
    // Every spelling of the lookup, or the policy contradicts itself: the same
    // read renders as a chat step or not depending on which name the model
    // emitted. `narration.ts` puts all four in the one `memory` family.
    expect(stepLabel(tool('mem_search')).tier).toBe('plumbing');
    expect(stepLabel(tool('ltm_search')).tier).toBe('plumbing');
    // …and they read as recalls, not as a raw tool name under "Used".
    expect(stepLabel(tool('mem_search')).verb).toBe('Recalled');
    expect(stepLabel(tool('ltm_search', { query: 'deploy checklist' })).object).toBe(
      'deploy checklist',
    );
  });

  test('the memory EDITOR is primary — an update the reader must be able to see', () => {
    // `memory` create/insert/str_replace/rename/delete change what the agent
    // remembers in every later turn. It was plumbing, which made the most
    // consequential thing a session can do invisible in chat.
    expect(stepLabel(tool('memory')).tier).toBe('primary');
    // Tool granularity: `view` rides along rather than adding a second copy of
    // the command table to this pipeline. The row names which it was.
    expect(stepLabel(tool('memory', { command: 'view' })).tier).toBe('primary');
  });

  test('dcp and context tools are tier plumbing', () => {
    expect(stepLabel(tool('dcp_compress')).tier).toBe('plumbing');
    expect(stepLabel(tool('dcp_distill')).tier).toBe('plumbing');
    expect(stepLabel(tool('dcp_prune')).tier).toBe('plumbing');
    expect(stepLabel(tool('context_info')).tier).toBe('plumbing');
  });

  test('the context engine tools are plumbing under the names it registers', () => {
    // `ToolRegistry.register('prune'|'distill'|'compress', …)` — the `dcp_`
    // spellings above never match a real part.
    expect(stepLabel(tool('prune')).tier).toBe('plumbing');
    expect(stepLabel(tool('distill')).tier).toBe('plumbing');
    expect(stepLabel(tool('compress')).tier).toBe('plumbing');
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

  test('when input is undefined, object is undefined and does not throw', () => {
    expect(stepLabel(toolWithInput('read', undefined)).object).toBeUndefined();
  });

  test('when input is null, object is undefined and does not throw', () => {
    expect(stepLabel(toolWithInput('read', null)).object).toBeUndefined();
  });

  test('when input is a string, object is undefined and does not throw', () => {
    expect(stepLabel(toolWithInput('read', 'some raw string')).object).toBeUndefined();
  });

  test('when input is an array, object is undefined and does not throw', () => {
    expect(stepLabel(toolWithInput('read', ['a', 'b'])).object).toBeUndefined();
  });
});

/**
 * The row said `Searched site:daytona.io Daytona sandboxes` — the model's
 * engine syntax, shown verbatim to a reader who never typed it. `shorten`
 * treats a query the way it treats a path: the row names what was worked ON,
 * not the argument the tool was handed. Rules live in `search-query.ts`.
 */
describe('stepLabel drops search operators', () => {
  test('a site: scope becomes English', () => {
    expect(stepLabel(tool('web_search', { query: 'site:daytona.io Daytona sandboxes' })).object).toBe(
      'Daytona sandboxes on daytona.io',
    );
  });

  test('engine-only operators are dropped', () => {
    expect(stepLabel(tool('web_search', { query: 'filetype:pdf annual report' })).object).toBe(
      'annual report',
    );
  });

  test('a plain query is untouched', () => {
    expect(stepLabel(tool('web_search', { query: 'Daytona developer infrastructure' })).object).toBe(
      'Daytona developer infrastructure',
    );
  });

  test('memory_search reads its query the same way', () => {
    expect(stepLabel(tool('memory_search', { query: 'deploy checklist' })).object).toBe(
      'deploy checklist',
    );
  });

  test('a query of nothing but operators never blanks the row', () => {
    expect(stepLabel(tool('web_search', { query: 'filetype:pdf' })).object).toBe('filetype:pdf');
  });
});
