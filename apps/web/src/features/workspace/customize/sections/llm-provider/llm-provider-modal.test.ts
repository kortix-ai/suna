import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  LLM_TABS,
  MODELS_PAGE_DESCRIPTION,
  MODELS_PAGE_TITLE,
  QUICK_LLM_TABS,
} from '../gateway-view';

/**
 * Comments stripped first — a `toContain` over a whole file otherwise matches
 * the file's own doc comment rather than its code.
 */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '');
}

const modalSource = code(join(import.meta.dir, 'llm-provider-modal.tsx'));

/**
 * `ProjectProviderModal` is the QUICK version of the Models page — the same
 * components in a dialog, not a second implementation of them.
 *
 * It used to be the second implementation, and every difference between the
 * two screens was a bug someone had to notice: an underline strip at `text-xs`
 * against the page's pills, "API keys" against the page's "Providers", no
 * project-default control, and a scroll body with no horizontal padding, so
 * the search field and every model row ran into the modal's clipped edge under
 * a heading indented 20px.
 *
 * What is pinned below is that the dialog OWNS none of that any more.
 */
describe('LLM provider modal shell', () => {
  test('renders the page’s components — it declares no chrome of its own', () => {
    expect(modalSource).toContain(
      "from '@/features/workspace/customize/sections/gateway-view'",
    );
    for (const shared of [
      '<LlmTabStrip',
      '<LlmSections',
      '<ProjectDefaultPicker',
      'MODELS_PAGE_TITLE',
      'MODELS_PAGE_DESCRIPTION',
    ]) {
      expect(modalSource).toContain(shared);
    }
    // Not one tab, section or label built here. Each of these coming back is a
    // second implementation coming back with it.
    for (const forbidden of [
      '<TabsTrigger',
      '<TabsList',
      '<TabsContent',
      '<Tabs ',
      '<ProviderConnect',
      '<ModelsTab',
      '<CustomProviderPanel',
      '<ModelSelector',
      'API keys',
      'InputGroupSearch',
      'underline',
    ]) {
      expect(modalSource).not.toContain(forbidden);
    }
  });

  /**
   * The dialog's tabs come from `QUICK_LLM_TABS` — a slice of the page's seven,
   * shipped by the page's own module. It cannot name a tab the page does not
   * have, and it cannot relabel one.
   */
  test('its tabs are the page’s first three, by reference not by copy', () => {
    expect(modalSource).toContain('tabs={QUICK_LLM_TABS}');
    expect(QUICK_LLM_TABS).toEqual(LLM_TABS.slice(0, 3));
    expect(QUICK_LLM_TABS.map((t) => t.id)).toEqual(['providers', 'models', 'custom']);
    expect(QUICK_LLM_TABS.map((t) => t.label)).toEqual(['Providers', 'Models', 'Custom']);
    // Gateway / Routing / Costs / Logs are project administration and stay on
    // the page, which has the width and height for a log table.
    for (const pageOnly of LLM_TABS.slice(3)) {
      expect(QUICK_LLM_TABS).not.toContainEqual(pageOnly);
    }
  });

  test('it shows the page’s heading, not a second wording of it', () => {
    expect(MODELS_PAGE_TITLE).toBe('Models');
    expect(MODELS_PAGE_DESCRIPTION).toBe('Which providers and models this project can use.');
    expect(modalSource).toContain('<ModalTitle className="text-base font-medium">{MODELS_PAGE_TITLE}</ModalTitle>');
    expect(modalSource).toContain('<ModalDescription>{MODELS_PAGE_DESCRIPTION}</ModalDescription>');
    expect(modalSource).not.toContain('Connect your own AI accounts');
  });

  /**
   * THE bug in the screenshot. `LlmSections` carries no horizontal padding —
   * on the page `CapabilityPageShell` supplies the column — so the dialog has
   * to, or the model rows run edge to edge and the row card's rounded border
   * is clipped away by `ModalContent`'s `overflow-hidden`.
   */
  test('the scroll column is padded, so the rows line up under the heading', () => {
    const column = modalSource.slice(modalSource.indexOf('overflow-y-auto'));
    expect(column).toContain('px-5');
    expect(column.indexOf('<LlmSections')).toBeGreaterThan(-1);
    // One scroller, and it is this one.
    expect(modalSource.match(/overflow-y-auto/g)).toHaveLength(1);
  });

  /**
   * The picker is the header's right-hand control, like the page's. The modal's
   * close button is `absolute top-3 right-3` at `size-8`, so 44px of the right
   * edge is spoken for and the header has to stop short of it.
   */
  test('the project-default picker sits in the header and clears the close button', () => {
    const header = modalSource.slice(
      modalSource.indexOf('<ModalHeader'),
      modalSource.indexOf('</ModalHeader>'),
    );
    expect(header).toContain('<ProjectDefaultPicker projectId={projectId} />');
    // Write-gated: a read-only member sees the list, not the one control that
    // POSTs from this bar.
    expect(header).toContain('canWrite ? <ProjectDefaultPicker');
    expect(modalSource).toContain('sm:pr-11');
  });

  /**
   * The width moved from `600px` to a named `lg:max-w-*` step when the
   * providers tab became a two-column grid: at 600px the 13rem identity column
   * left the key field under ~28ch, narrower than every key it has to hold.
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
    expect(modalSource).toMatch(/lg:max-w-\d?xl/);
    expect(modalSource).not.toMatch(/max-w-\[\d+px\]/);
  });

  /**
   * Reopening still lands on the requested tab: the shell's
   * `key={`${open}-${defaultTab}`}` remounts the body, whose `useState`
   * initializer runs once per mount — no `setState` in an effect body
   * (`react-hooks/set-state-in-effect`).
   */
  test('reopening re-seeds the tab by remount, not by an effect', () => {
    expect(modalSource).toContain("key={`${open}-${defaultTab ?? ''}`}");
    expect(modalSource).toContain('useState<ActiveTab>(() => pickInitialTab(defaultTab))');
    expect(modalSource).not.toContain('useEffect');
  });
});
