import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const sourcePath = join(import.meta.dir, 'connectors-view.tsx');
const source = readFileSync(sourcePath, 'utf8');

describe('Slack channel connector catalogue', () => {
  test('uses the built-in Slack install flow instead of creating the reserved slug', () => {
    expect(source).toContain('<AddSlackProfileCard projectId={projectId} onAdded={onAdded} />');
    expect(source).not.toMatch(/<ChannelProfileCard[\s\S]*slug="kortix_slack"/);
  });
});
