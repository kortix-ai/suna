import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const onboardingDir = import.meta.dir;
const slackStep = readFileSync(join(onboardingDir, 'steps/slack-step.tsx'), 'utf8');
const connectorsView = readFileSync(
  join(onboardingDir, '../../../features/workspace/customize/sections/connectors-view.tsx'),
  'utf8',
);

describe('Slack onboarding context', () => {
  test('opens the reusable Slack form directly in custom-only mode', () => {
    expect(slackStep).toContain('customOnly');
    expect(connectorsView).toContain('customOnly?: boolean');
  });

  test('keeps the custom-only form flat and stacked inside the context rail', () => {
    expect(connectorsView).toContain("!customOnly && 'border-border/60 bg-card rounded-2xl border p-4'");
    expect(connectorsView).toContain("!customOnly && 'sm:flex-row sm:items-end sm:justify-between'");
    expect(connectorsView).toContain("!customOnly && 'sm:grid-cols-2'");
  });

  test('announces OAuth progress and connection results from the context rail', () => {
    expect(slackStep).toContain('aria-live="polite"');
    expect(slackStep).toContain('Waiting for approval in Slack');
    expect(slackStep).toContain('Connected to Slack');
    expect(slackStep).toContain("skipLabel={connected ? undefined : 'Not now'}");
  });
});
