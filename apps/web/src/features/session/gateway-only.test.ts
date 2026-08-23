import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Gateway mode is the only mode — the web has no native-provider branch.
 *
 * The retired `llm_gateway` feature flag used to fork a dozen surfaces into a
 * "native OpenCode provider" branch: the session picker filtered `kortix`
 * out, the connection gate skipped the secrets read, the Models pane rendered
 * `null`, the Secrets page opened a modal instead of navigating, and the
 * provider list hid the managed row. None of that branch had a working UI
 * behind it (there is no way to connect an OpenCode-native provider from the
 * web), so it was a dead picker masquerading as a mode.
 *
 * These are source-level tripwires, the repo's idiom for hook-heavy files
 * that cannot render without a provider tree: the branch must not come back
 * under any of its old names.
 */
const SRC = join(import.meta.dir, '..', '..');

function source(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

const FORMERLY_FORKED = [
  'features/session/model-selector.tsx',
  'features/session/use-model-connection-gate.tsx',
  'features/session/model-flatten.ts',
  'features/workspace/settings/tabs/models-tab.tsx',
  'features/workspace/capabilities/models/models-page.tsx',
  'features/workspace/customize/sections/view/secrets-view.tsx',
  'features/workspace/customize/sections/llm-provider/use-connected-providers.ts',
  'features/workspace/customize/sections/llm-provider/use-live-catalog.ts',
  'features/workspace/settings/tabs/experimental-tab.tsx',
  'features/workspace/command-palette.tsx',
  'lib/use-project-feature-flags.ts',
];

describe('gateway mode is the only mode (web)', () => {
  test('no surface reads the retired llm_gateway flag or branches on gateway mode', () => {
    for (const rel of FORMERLY_FORKED) {
      const src = source(rel);
      expect(src, rel).not.toContain('isLlmGatewayEnabled');
      expect(src, rel).not.toContain('llmGatewayEnabled');
      expect(src, rel).not.toContain("'llm_gateway'");
      expect(src, rel).not.toContain('@/lib/llm-gateway');
    }
  });

  test('the flag helper module is gone', () => {
    expect(existsSync(join(SRC, 'lib/llm-gateway.ts'))).toBe(false);
  });

  test('the session picker never filters the kortix provider out', () => {
    expect(source('features/session/model-selector.tsx')).not.toContain(
      "m.providerID !== 'kortix'",
    );
    expect(source('features/session/use-model-connection-gate.tsx')).not.toContain(
      "m.providerID !== 'kortix'",
    );
  });

  test('the OpenCode-config custom-provider tab is gone', () => {
    // It generated a `provider:{...}` block for `.opencode/opencode.jsonc` and
    // claimed the key "will be injected into sessions as an env var" — false
    // under the gateway (consumer `llm_gateway` + the daemon deny list).
    const dir = join(SRC, 'features/workspace/customize/sections/llm-provider');
    expect(existsSync(join(dir, 'custom-provider-form.tsx'))).toBe(false);
    expect(existsSync(join(dir, 'custom-provider-panel.tsx'))).toBe(false);
    expect(source('features/workspace/customize/sections/llm-provider/utils.ts')).not.toContain(
      'buildCustomProviderSnippet',
    );
    // #6771 made the dialog's tab set an alias of the page's QUICK slice — the
    // two-tab truth now lives in gateway-view.tsx, and types.ts points at it.
    expect(source('features/workspace/customize/sections/llm-provider/types.ts')).toContain(
      'export type ActiveTab = QuickLlmTab;',
    );
    expect(source('features/workspace/customize/sections/gateway-view.tsx')).toContain(
      "export type QuickLlmTab = 'providers' | 'models';",
    );
  });
});
