import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'claude-subscription-connect.tsx'), 'utf8');
const modalSource = readFileSync(join(import.meta.dir, 'llm-provider-modal.tsx'), 'utf8');

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
