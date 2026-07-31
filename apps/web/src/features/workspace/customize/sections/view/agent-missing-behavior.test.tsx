import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildBehaviorRepairScaffold } from './agent-missing-behavior';

const editorSource = readFileSync(
  fileURLToPath(new URL('./agent-editor.tsx', import.meta.url)),
  'utf8',
);
const repairSource = readFileSync(
  fileURLToPath(new URL('./agent-missing-behavior.tsx', import.meta.url)),
  'utf8',
);

describe('missing behavior scaffold', () => {
  test('uses the declared OpenCode fields and body prompt', () => {
    const markdown = buildBehaviorRepairScaffold('reliance-cto', {
      opencode: {
        description: 'Reliance CTO',
        mode: 'subagent',
        model: 'openai/gpt-5',
        temperature: 0.2,
        prompt: 'Review release risk.',
      },
    });

    expect(markdown).toContain('---\ndescription: "Reliance CTO"');
    expect(markdown).toContain('mode: subagent');
    expect(markdown).toContain('model: "openai/gpt-5"');
    expect(markdown).toContain('temperature: 0.2');
    expect(markdown).toContain('Review release risk.');
  });

  test('falls back to a reviewed scaffold when the prompt is absent', () => {
    const markdown = buildBehaviorRepairScaffold('support', {});

    expect(markdown).toContain('description: "support agent"');
    expect(markdown).toContain('mode: primary');
    expect(markdown).toContain('You are support.');
  });
});

describe('missing behavior UI source contract', () => {
  test('renders repair only for missing behavior files and retry for read errors', () => {
    expect(editorSource).toContain("behavior_file_state ?? 'exists'");
    expect(editorSource).toContain("behaviorState === 'missing'");
    expect(editorSource).toContain("behaviorState === 'read_error'");
    expect(editorSource).toContain('editBlockedByBehaviorState');
    expect(editorSource).toContain('Repair behavior file first');
    expect(editorSource).toContain('configQuery.refetch()');
  });

  test('repair opens a reviewed behavior-markdown change request and invalidates source', () => {
    expect(repairSource).toContain('repairBehavior.mutateAsync');
    expect(repairSource).toContain('behavior_markdown: draft');
    expect(repairSource).toContain("['project-file-source', projectId, sourcePath]");
    expect(repairSource).toContain('Create behavior file');
    expect(repairSource).toContain('Open change request');
  });
});
