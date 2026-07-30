import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const selectorSource = readFileSync(resolve(import.meta.dir, 'agent-selector.tsx'), 'utf8');
const iconSource = readFileSync(resolve(import.meta.dir, 'agent-harness-icon.tsx'), 'utf8');
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
  expect(selectorSource.slice(menuStart)).toContain(
    '<AgentHarnessIcon projectId={projectId} harness={agent.harness} />',
  );
  expect(selectorSource).not.toContain('<Badge');
});

test('shows harness favicons in the agent configuration list and detail metadata', () => {
  expect(
    agentsViewSource.match(
      /<AgentHarnessIcon projectId=\{projectId\} harness=\{agent\.harness\} \/>/g,
    ),
  ).toHaveLength(3);
});

// The badge exists only to tell two harnesses apart. `opencode` is the one
// harness the shipped REST path launches, so with `acp_runtime` off the badge
// labels nothing — and a v3 manifest declaring `harness: claude` would advertise
// a harness the API answers 409 HARNESS_NOT_ENABLED for. Default-closed, gated
// on the same flag as the rest of the ACP / multi-harness surface.
test('the harness badge is gated on the acp_runtime multi-harness experiment', () => {
  expect(iconSource).toContain(
    "import { useMultiHarnessEnabled } from '@/hooks/projects/use-multi-harness-enabled'",
  );
  expect(iconSource).toContain('const multiHarnessEnabled = useMultiHarnessEnabled(projectId)');
  expect(iconSource).toContain('if (!multiHarnessEnabled || !domain || !label) return null;');
});

test('every harness-badge call site passes a projectId so the gate cannot be bypassed', () => {
  // A required prop, never defaulted — an absent id must be a type error at the
  // call site rather than a silently always-hidden badge.
  expect(iconSource).toContain('projectId: string | undefined;');
  expect(iconSource).not.toContain('projectId = ');

  const iconUsages = [selectorSource, agentsViewSource].flatMap(
    (source) => source.match(/<AgentHarnessIcon\s[^>]*\/>/g) ?? [],
  );

  expect(iconUsages).toHaveLength(4);
  for (const usage of iconUsages) {
    expect(usage).toContain('projectId={projectId}');
  }
});

test('the agent selector takes the projectId the gate needs', () => {
  expect(selectorSource).toContain('projectId: string | undefined;');
});
