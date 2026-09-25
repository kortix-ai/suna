import { beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as sdk from '@kortix/sdk/internal/diagnostics-store'; // eslint-disable-line no-restricted-imports

import { isAppOwnedStorageKey, isKeptStorageKey } from '@/lib/utils/clear-local-storage';
import { resetAllRegisteredPersistedStores } from '@/stores/persisted-store-registry';

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

// `persisted-store-coverage.test.ts` finds stores by their `persist(` call.
// This file is a shim with no `persist(` call, so the walker skips it. The
// three tests below keep the same sign-out guarantees for the SDK store.

test('the SDK persist name is swept at sign-out and not kept', () => {
  const name = sdk.useDiagnosticsStore.persist.getOptions().name;
  expect(name).toBe('kortix-diagnostics');
  expect(isAppOwnedStorageKey(name!)).toBe(true);
  expect(isKeptStorageKey(name!)).toBe(false);
});

test('the web shim registers the SDK store under its real persist name', () => {
  const source = readFileSync(resolve(import.meta.dir, 'diagnostics-store.ts'), 'utf8');
  const registered = [...source.matchAll(/\bregisterPersistedStore\(\s*(['"])([^'"]+)\1/g)].map(
    (match) => match[2],
  );
  expect(registered).toEqual([sdk.useDiagnosticsStore.persist.getOptions().name!]);
});

test('the sign-out reset empties diagnostics written by the SDK', () => {
  sdk.useDiagnosticsStore.getState().setFromLspEvent({
    '/workspace/a.ts': [
      { range: { start: { line: 1, character: 0 } }, severity: 1, message: 'boom' },
    ],
  });
  expect(Object.keys(sdk.useDiagnosticsStore.getState().byFile)).toEqual(['/workspace/a.ts']);

  resetAllRegisteredPersistedStores();

  expect(sdk.useDiagnosticsStore.getState().byFile).toEqual({});
});
