import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Comments stripped first — a `toContain` over a whole file otherwise matches
 * the file's own doc comment rather than its code.
 */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const modalSource = code(join(import.meta.dir, 'llm-provider-modal.tsx'));

describe('LLM provider modal shell', () => {
  /**
   * JAY-510 replaced the old three tabs (Add provider / Connected / Models)
   * with `ProviderConnect`'s four sections plus the model-visibility list. The
   * predecessor test pinned `catalog` before `connected` before `models`; that
   * ordering is exactly what the ticket inverted (Connected is now section 1
   * INSIDE Providers), so it is replaced, not deleted — the fact worth pinning
   * is that Providers comes before Models and that nothing else remains.
   */
  test('has exactly two tabs, Providers before Models', () => {
    const providers = modalSource.indexOf('<TabsTrigger value="providers"');
    const models = modalSource.indexOf('<TabsTrigger value="models"');

    expect(providers).toBeGreaterThan(-1);
    expect(models).toBeGreaterThan(providers);
    expect(modalSource.match(/<TabsTrigger/g)).toHaveLength(2);
    expect(modalSource).not.toContain('value="catalog"');
    expect(modalSource).not.toContain('value="connected"');
  });

  test('owns no connect UI of its own — it delegates to the one shared component', () => {
    expect(modalSource).toContain("import { ProviderConnect } from '@/features/providers/provider-connect'");
    expect(modalSource).toContain('<ProviderConnect projectId={projectId}');
    // The always-on search bar above the tabs is gone; search now lives inside
    // the More-providers disclosure in `provider-connect.tsx`.
    expect(modalSource).not.toContain('InputGroupSearch');
    expect(modalSource).not.toContain('Search providers');
  });

  test('keeps the 600 by 680 modal dimensions', () => {
    expect(modalSource).toContain('h-[min(680px,calc(100dvh-2rem))]');
    expect(modalSource).toContain('max-w-[600px]');
    expect(modalSource).toContain('lg:max-w-[600px]');
    expect(modalSource).not.toContain('max-w-[520px]');
  });
});
