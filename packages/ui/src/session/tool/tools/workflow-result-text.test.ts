import { describe, expect, test } from 'bun:test';

import { unwrapWorkflowResultBlocks, workflowResultMarkdown } from './workflow-result-text';

// Synthetic values: the shape a workflow script returns, `{ strategy: '# …' }`.
const doc = '# Growth plan\n\nOne pack. Ten pilots.\n\n## Priorities\n\n1. **Prove it.**';

describe('workflowResultMarkdown', () => {
  test('a bare JSON document (a finish notice body) reads as the document', () => {
    expect(workflowResultMarkdown(JSON.stringify({ strategy: doc }))).toBe(doc);
  });

  test('data reads as a json block, plain prose as itself', () => {
    expect(workflowResultMarkdown('{"count":3}')).toBe('```json\n{\n  "count": 3\n}\n```');
    expect(workflowResultMarkdown('All 38 doc links resolve.')).toBe('All 38 doc links resolve.');
  });
});

describe('unwrapWorkflowResultBlocks', () => {
  test('a runner reply shows the result, never the tag or the JSON', () => {
    const reply = `Here is the plan.\n\n<workflow_result>\n${JSON.stringify({ strategy: doc })}\n</workflow_result>`;
    expect(unwrapWorkflowResultBlocks(reply)).toBe(`Here is the plan.\n\n${doc}`);
  });

  test('an unclosed block (still streaming) runs to the end and still reads as the document', () => {
    const full = JSON.stringify({ strategy: doc });
    expect(unwrapWorkflowResultBlocks(`<workflow_result>${full.slice(0, full.indexOf('## Priorities'))}`)).toBe('# Growth plan\n\nOne pack. Ten pilots.');
  });

  test('text without a block is untouched', () => {
    expect(unwrapWorkflowResultBlocks('No result here.')).toBe('No result here.');
  });
});
