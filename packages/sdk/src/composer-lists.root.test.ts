import { expect, test } from 'bun:test';

import * as root from './index';
import * as react from './react/index';

/**
 * Web and mobile must build the composer's agent and model lists with the SAME
 * functions. Mobile (React Native) imports only the framework-free root entry,
 * so every pure list builder is reachable from `@kortix/sdk` — and the names
 * web already imports from `@kortix/sdk/react` are the same bindings, not
 * copies that can drift.
 */
const ROOT_COMPOSER_FUNCTIONS = [
  'projectConfigAgentsToRuntimeAgents',
  'composerSelectableAgents',
  'resolveComposerAgent',
  'flattenModels',
  'isOfferedModel',
  'pickerProviderList',
  'createModelVisibility',
  'modelInDefaultView',
  'resolveModelDefault',
  'resolveComposerModel',
] as const;

test('the composer list builders are functions on the root entry', () => {
  for (const name of ROOT_COMPOSER_FUNCTIONS) {
    expect({ name, type: typeof (root as Record<string, unknown>)[name] }).toEqual({
      name,
      type: 'function',
    });
  }
});

test('names that ./react already exported are the same bindings as the root ones', () => {
  for (const name of [
    'projectConfigAgentsToRuntimeAgents',
    'flattenModels',
    'isOfferedModel',
    'resolveModelDefault',
  ] as const) {
    expect({ name, same: (react as Record<string, unknown>)[name] === root[name] }).toEqual({
      name,
      same: true,
    });
  }
});

/**
 * `@kortix/llm-catalog`'s main entry re-exports the ~7.6 MB models.dev snapshot
 * (`CATALOG`). Webpack/Turbopack drop it when unused; Metro (React Native) does
 * not tree-shake, so one runtime import of the main entry from the root barrel
 * put ~3.5 MB of catalog JSON into the mobile bundle (measured with
 * `expo export`). The framework-free core reads the catalog helpers from
 * `@kortix/llm-catalog/lite`, which never reaches the snapshot.
 */
test('the framework-free core never imports the full @kortix/llm-catalog entry at runtime', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const coreDir = join(import.meta.dir, 'core');
  const offenders = (readdirSync(coreDir, { recursive: true }) as string[])
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .filter((file) =>
      /(?:import|export)\s+(?!type\b)[^;]*?from\s+['"]@kortix\/llm-catalog['"]/s.test(
        readFileSync(join(coreDir, file), 'utf8'),
      ),
    );
  expect(offenders).toEqual([]);
});
