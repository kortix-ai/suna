import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const provider = readFileSync('apps/mobile/components/session/ConnectProviderSheet.tsx', 'utf8');
const connector = readFileSync('apps/mobile/components/session/ConnectorAuthSheet.tsx', 'utf8');

// Characterize each caller's distinct copy, dismissal and tile before extracting the shared shell.
describe('connector handoff sheets', () => {
  test('provider retains its copy, secondary dismiss and close-then-open callback', () => {
    expect(provider).toContain('Connect a model provider');
    expect(provider).toContain("Add a provider on kortix.com. You come back here when you're done.");
    expect(provider).toContain('secondary');
    expect(provider).toContain('requestContinue(sheetRef)');
  });

  test('connector retains its fallback copy, ghost dismiss and optional logo', () => {
    expect(connector).toContain("Sign in on kortix.com. You come back to this chat when it's done.");
    expect(connector).toContain('ghost');
    expect(connector).toContain('logoFailed');
    expect(connector).toContain('requestContinue(sheetRef)');
  });
});
