import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  agentCreateFingerprint,
  initialCreateAgentBlock,
  isAgentPreviewStale,
  validateAgentCreateDraft,
} from './agent-create-modal';

const modalSource = readFileSync(
  fileURLToPath(new URL('./agent-create-modal.tsx', import.meta.url)),
  'utf8',
);
const agentsSource = readFileSync(
  fileURLToPath(new URL('./agents-view.tsx', import.meta.url)),
  'utf8',
);
const configEntitySource = readFileSync(
  fileURLToPath(new URL('../component/config-entity-view.tsx', import.meta.url)),
  'utf8',
);

describe('agent create validation', () => {
  test('requires a valid lowercase agent name and a prompt body', () => {
    expect(validateAgentCreateDraft('', initialCreateAgentBlock())).toEqual({
      agentName: 'Agent name is required.',
      prompt: 'System prompt is required.',
    });

    expect(
      validateAgentCreateDraft('Reliance CTO', {
        opencode: { mode: 'primary', prompt: 'You are the CTO.' },
      }),
    ).toEqual({
      agentName: 'Use lowercase letters, numbers, dashes, or underscores.',
    });

    expect(
      validateAgentCreateDraft('reliance-cto', {
        opencode: { mode: 'primary', prompt: 'You are the CTO.' },
      }),
    ).toEqual({});
  });

  test('marks a preview stale after the draft changes', () => {
    const ready = agentCreateFingerprint('reliance-cto', {
      opencode: { mode: 'primary', prompt: 'You are the CTO.' },
    });
    const changed = agentCreateFingerprint('reliance-cto', {
      opencode: { mode: 'primary', prompt: 'You are the CTO. Review releases.' },
    });

    expect(isAgentPreviewStale(null, ready)).toBe(false);
    expect(isAgentPreviewStale(ready, ready)).toBe(false);
    expect(isAgentPreviewStale(ready, changed)).toBe(true);
  });
});

describe('agent create modal source contract', () => {
  test('previews markdown before create and submits the reviewed preview revision', () => {
    expect(modalSource).toContain('previewMutation.mutateAsync');
    expect(modalSource).toContain('create.mutateAsync');
    expect(modalSource).toContain('preview_revision: preview.preview_revision');
    expect(modalSource).toContain('preview.behavior_markdown');
    expect(modalSource).toContain('previewStale');
    expect(modalSource).toContain('project.gitops.push');
  });

  test('Agents New uses the direct modal while generic sections keep configure-thread create', () => {
    expect(agentsSource).toContain('onCreate={() => setCreateOpen(true)}');
    expect(agentsSource).toContain('<AgentCreateModal');
    expect(agentsSource).not.toContain('configure.start(newConfigPrompt');
    expect(configEntitySource).toContain('onCreate?: () => void');
    expect(configEntitySource).toContain('configure.start(newConfigPrompt(kind))');
  });
});
