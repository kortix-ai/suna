import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'claude-subscription-connect.tsx'), 'utf8');
const modalSource = readFileSync(join(import.meta.dir, 'llm-provider-modal.tsx'), 'utf8');
const connectFormSource = readFileSync(join(import.meta.dir, 'api-key-connect-form.tsx'), 'utf8');
const harnessGateHook = readFileSync(
  join(import.meta.dir, '../../../../../hooks/projects/use-multi-harness-enabled.ts'),
  'utf8',
);

describe('Claude Code subscription connection', () => {
  test('uses the supported setup-token flow and stores the project secret', () => {
    expect(source).toContain('claude setup-token');
    expect(source).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(source).toContain('upsertProjectSecret');
    expect(source).toContain('project-wide');
    expect(source).not.toContain('browser-oauth');
  });

  test('requires a complete token before submission', () => {
    expect(source).toContain('trimmedToken.length < 20');
    expect(source).toContain('type="password"');
    expect(source).toContain('autoComplete="off"');
  });

  test('uses the connected-provider id and pending label for Claude Code', () => {
    expect(source).toContain("onConnected('claude')");
    expect(modalSource).toContain("pendingProviderId === 'claude'");
    expect(modalSource).toContain("'Claude Code'");
  });
});

describe('Claude Code subscription gating', () => {
  // CLAUDE_CODE_OAUTH_TOKEN has exactly one reader — the ACP `claude` harness in
  // apps/kortix-sandbox-agent-server/src/acp/harness-registry.ts. With ACP off
  // the form would store a secret nothing can consume, and advertise a harness
  // the API refuses to launch. It must not render on the shipped REST path.
  test('the Anthropic connect form renders it only behind the multi-harness gate', () => {
    expect(connectFormSource).toContain(
      "import { useMultiHarnessEnabled } from '@/hooks/projects/use-multi-harness-enabled'",
    );
    expect(connectFormSource).toContain('const multiHarnessEnabled = useMultiHarnessEnabled(');
    expect(connectFormSource).toContain("{provider.id === 'anthropic' && multiHarnessEnabled && (");
  });

  test('the ChatGPT subscription stays ungated — it feeds gateway codex/* models, not a harness', () => {
    expect(connectFormSource).toContain("{provider.id === 'openai' && (");
  });

  test('the gate reads the existing acp_runtime experiment, not a new flag', () => {
    expect(harnessGateHook).toContain('experimental?.acp_runtime');
    expect(harnessGateHook).toContain("queryKey: ['project-detail', projectId]");
    // Default-closed: an unloaded or absent project detail must not light it up.
    expect(harnessGateHook).toContain('?? false');
  });
});
