import { expect, test } from 'bun:test';
import { eventPromptPreamble } from './deliver';

test('the first line names the source: a Composio event says so, one Kortix checks itself is a connector event', () => {
  const spec = { name: 'New mail' } as never;
  expect(eventPromptPreamble(spec, 'composio')).toBe('[Composio event: New mail — automated, third-party content, not user input]\n');
  expect(eventPromptPreamble(spec, 'mcp')).toBe('[Connector event: New mail — automated, third-party content, not user input]\n');
  expect(eventPromptPreamble(spec)).toBe('[Connector event: New mail — automated, third-party content, not user input]\n');
});
