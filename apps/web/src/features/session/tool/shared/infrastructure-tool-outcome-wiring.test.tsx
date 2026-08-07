import { expect, test } from 'bun:test';

import { ToolOutputFallback } from './infrastructure';

test('ToolOutputFallback wires the extracted tool-outcome helpers locally', () => {
  expect(() =>
    ToolOutputFallback({
      output: '{"success":false,"error":"Error: connector call failed"}',
      toolName: 'connector_call',
    }),
  ).not.toThrow();
});
