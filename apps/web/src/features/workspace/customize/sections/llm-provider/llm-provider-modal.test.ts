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
  /**
   * Three tabs now. `custom` is third and last because it is the rarest job
   * on this modal — it was a fourth SECTION stacked under the provider list,
   * where everyone who was not connecting a self-hosted endpoint had to scroll
   * past a form they would never fill.
   */
  test('has exactly three tabs: API keys, then Models, then Custom', () => {
    const providers = modalSource.indexOf('<TabsTrigger value="providers"');
    const models = modalSource.indexOf('<TabsTrigger value="models"');
    const custom = modalSource.indexOf('<TabsTrigger value="custom"');

    expect(providers).toBeGreaterThan(-1);
    expect(models).toBeGreaterThan(providers);
    expect(custom).toBeGreaterThan(models);
    expect(modalSource.match(/<TabsTrigger/g)).toHaveLength(3);
    expect(modalSource).not.toContain('value="catalog"');
    expect(modalSource).not.toContain('value="connected"');
  });

  /**
   * The Custom tab has to be able to hand the reader back: a saved custom
   * provider now has a key like any other and a row on the API keys list, so
   * a "Done" that leaves you on the form you just submitted is not done.
   */
  test('finishing the custom form returns to the API keys tab', () => {
    expect(modalSource).toContain('<CustomProviderPanel');
    expect(modalSource).toContain("onDone={() => setTab('providers')}");
  });

  test('owns no connect UI of its own — it delegates to the one shared component', () => {
    expect(modalSource).toContain("import { ProviderConnect } from '@/features/providers/provider-connect'");
    expect(modalSource).toContain('<ProviderConnect projectId={projectId}');
    // The always-on search bar above the tabs is gone; search now lives inside
    // the More-providers disclosure in `provider-connect.tsx`.
    expect(modalSource).not.toContain('InputGroupSearch');
    expect(modalSource).not.toContain('Search providers');
  });

  /**
   * The width moved from `600px` to `lg:max-w-3xl` (768px) when the API-keys
   * tab became a two-column grid: at 600px the 13rem identity column left the
   * key field under ~28ch, which is narrower than every key it has to hold.
   * The height is unchanged.
   */
  test('keeps the 680px height and is wide enough for the two-column key grid', () => {
    // One var, referenced three times. The base ModalVariants carry `lg:h-auto`
    // for the bottom side, and twMerge keeps that alongside an unprefixed
    // `h-[…]` (different modifier group) — so without the `lg:min-h`/`lg:max-h`
    // clamps the desktop modal is content-sized and its height jumps on every
    // tab switch. If either clamp disappears, the fluctuation is back.
    expect(modalSource).toContain('[--provider-modal-h:min(680px,calc(100dvh-2rem))]');
    expect(modalSource).toContain('h-(--provider-modal-h)');
    expect(modalSource).toContain('lg:min-h-(--provider-modal-h)');
    expect(modalSource).toContain('lg:max-h-(--provider-modal-h)');
    // A named `lg:max-w-*` step, deliberately not pinned to which one — the
    // width is still being tuned. What must not come back is a fixed pixel
    // cap: at 600px the 13rem identity column left the key field under ~28ch,
    // narrower than every key it has to hold.
    expect(modalSource).toMatch(/lg:max-w-\d?xl/);
    expect(modalSource).not.toMatch(/max-w-\[\d+px\]/);
  });
});
