import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const selectorSource = readFileSync(resolve(import.meta.dir, 'agent-selector.tsx'), 'utf8');
const agentsViewSource = readFileSync(
  resolve(import.meta.dir, '../../workspace/customize/sections/view/agents-view.tsx'),
  'utf8',
);

test('shows harness favicons inside the agent menu but not in the selected-agent trigger', () => {
  const triggerStart = selectorSource.indexOf('<CommandPopoverTrigger>');
  const menuStart = selectorSource.indexOf('<CommandPopoverContent');

  expect(triggerStart).toBeGreaterThan(-1);
  expect(menuStart).toBeGreaterThan(triggerStart);
  expect(selectorSource.slice(triggerStart, menuStart)).not.toContain('AgentHarnessIcon');
  expect(selectorSource.slice(menuStart)).toContain('<AgentHarnessIcon harness={agent.harness} />');
  expect(selectorSource).not.toContain('<Badge');
});

test('shows harness favicons in the agent configuration list and detail metadata', () => {
  expect(agentsViewSource.match(/<AgentHarnessIcon harness=\{agent\.harness\} \/>/g)).toHaveLength(
    3,
  );
});
