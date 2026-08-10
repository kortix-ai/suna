import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('./session-config-indicator.tsx', import.meta.url)),
  'utf8',
);

describe('SessionConfigIndicator notification level', () => {
  test('keeps stale config in the header instead of opening a persistent toast', () => {
    expect(source).toContain('<Popover');
    expect(source).not.toContain("warningToast('Agent config is out of date'");
    expect(source).not.toContain('duration: Number.POSITIVE_INFINITY');
  });

  test('offers agent-driven reconciliation without changing Git in the browser', () => {
    expect(source).toContain('Ask agent to sync');
    expect(source).toContain('buildAgentGitReconciliationPrompt');
    expect(source).toContain('sendToSession(');
    expect(source).toContain('chatSessionId,');
    expect(source).not.toContain("systemReload('full')");
  });
});

describe('SessionConfigIndicator live reload status', () => {
  test('stays visible while a reload is running even after staleness clears', () => {
    expect(source).toContain("if (notice.kind === 'hidden' && !isPending) return null");
  });

  test('announces the server-confirmed phase and renders the ordered progress list', () => {
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain('<SessionReloadProgressView phase={phase} />');
    expect(source).toContain('reloadProgressText(phase)');
  });
});
