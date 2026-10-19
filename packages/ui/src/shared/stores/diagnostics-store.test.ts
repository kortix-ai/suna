import { beforeEach, expect, test } from 'bun:test';

import * as sdk from '@kortix/sdk/internal/diagnostics-store'; // eslint-disable-line no-restricted-imports
import { resetIdentityState } from '@kortix/sdk/react';

import { isAppOwnedStorageKey, isKeptStorageKey } from '@/lib/utils/clear-local-storage';

import * as web from './diagnostics-store';

// The SDK event stream writes LSP diagnostics into the SDK store. The file
// viewer reads `@/stores/diagnostics-store`. Both names must reach one store,
// or the viewer never sees a live `lsp.client.diagnostics` event.
beforeEach(() => sdk.useDiagnosticsStore.getState().clearAll());

test('the web import is the SDK store, not a copy', () => {
  expect(web.useDiagnosticsStore).toBe(sdk.useDiagnosticsStore);
  expect(web.findDiagnosticsForFile).toBe(sdk.findDiagnosticsForFile);
  expect(web.parseDiagnosticsFromToolOutput).toBe(sdk.parseDiagnosticsFromToolOutput);
});

test('an SDK setFromLspEvent write is readable through the web import', () => {
  sdk.useDiagnosticsStore.getState().setFromLspEvent({
    '/workspace/a.ts': [
      { range: { start: { line: 4, character: 2 } }, severity: 1, message: 'boom' },
    ],
  });

  const found = web.findDiagnosticsForFile(web.useDiagnosticsStore.getState().byFile, 'a.ts');
  expect(found).toMatchObject([{ file: '/workspace/a.ts', line: 4, column: 2, message: 'boom' }]);
});

test('the SDK persist name is swept at sign-out and not kept', () => {
  const name = sdk.useDiagnosticsStore.persist.getOptions().name;
  expect(name).toBe('kortix-diagnostics');
  expect(isAppOwnedStorageKey(name!)).toBe(true);
  expect(isKeptStorageKey(name!)).toBe(false);
});

// The web app calls `resetIdentityState()` on every identity change
// (`reset-client-state.ts`). The SDK registers the diagnostics reset there, so
// it runs even when no web module imported this shim.
test('an SDK setFromLspEvent write is empty after resetIdentityState()', () => {
  sdk.useDiagnosticsStore.getState().setFromLspEvent({
    '/workspace/a.ts': [
      { range: { start: { line: 1, character: 0 } }, severity: 1, message: 'boom' },
    ],
  });
  expect(Object.keys(sdk.useDiagnosticsStore.getState().byFile)).toEqual(['/workspace/a.ts']);

  resetIdentityState();

  expect(sdk.useDiagnosticsStore.getState().byFile).toEqual({});
});
