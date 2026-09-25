import { beforeEach, expect, test } from 'bun:test';

import * as sdk from '@kortix/sdk/internal/diagnostics-store'; // eslint-disable-line no-restricted-imports

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
