import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Source-text contract for the `?q=` prefill wiring in page.tsx — same
 * approach as `project-loading-contract.test.ts` and
 * `project-layout-auth-contract.test.ts`: this page pulls in the whole
 * ProjectHome/composer/billing stack, so rendering it in `bun:test` would
 * need a full router + query-client + auth harness for no extra signal.
 * `promptFromSearchParams` (the actual parsing logic) already has full
 * render-free unit coverage in `prompt-from-search-params.test.ts`; this test
 * only pins that page.tsx wires it up: seed once, strip `q`, don't re-verify
 * auth.
 */
const WEB_ROOT = resolve(import.meta.dir, '../../../../..');
const PAGE = resolve(WEB_ROOT, 'src/app/(app)/projects/[id]/page.tsx');

describe('project page ?q= prefill wiring', () => {
  const source = readFileSync(PAGE, 'utf8');

  test('imports the pure promptFromSearchParams helper', () => {
    expect(source).toContain("import { promptFromSearchParams } from './prompt-from-search-params'");
  });

  test('seeds the composer prefill store rather than duplicating consumption', () => {
    expect(source).toContain('useComposerPrefillStore.getState().setPrefill(projectId, prompt)');
    // ProjectHome (project-home.tsx) already calls `consume()` on mount — this
    // page must never also call it, or the prompt could be cleared before
    // ProjectHome reads it.
    expect(source).not.toContain('.consume(');
  });

  test('strips q from the URL via router.replace without scrolling', () => {
    expect(source).toContain("nextParams.delete('q')");
    expect(source).toContain('router.replace(');
    expect(source).toContain('{ scroll: false }');
  });

  test('guards against re-seeding on every render', () => {
    expect(source).toContain('seededRef');
  });
});
