import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from '@/i18n/use-translations';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import enMessages from '../../../../../translations/en.json';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ArrowLeftIcon as ArrowLeft,
  ArrowRightIcon as ArrowRight,
  ArrowClockwiseIcon as GrRefresh,
} from '@phosphor-icons/react';
import {
  parseAddressInput,
  PreviewRecentsLanding,
  SandboxAddressBar,
  splitUrlForDisplay,
} from './sandbox-browser-chrome';

const intlErrors: string[] = [];

const render = (node: ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider
      locale="en"
      messages={enMessages}
      timeZone="UTC"
      onError={(error) => intlErrors.push(error.code)}
    >
      {node}
    </NextIntlClientProvider>,
  );

const noop = () => {};

/** The bar's props minus the parts a render assertion doesn't care about. */
function bar(over: Partial<Parameters<typeof SandboxAddressBar>[0]> = {}) {
  return (
    <SandboxAddressBar
      displayValue="http://localhost:3000/app"
      hasPreview
      isLoading={false}
      canGoBack={false}
      canGoForward={false}
      onBack={noop}
      onForward={noop}
      onReload={noop}
      onNavigate={noop}
      placeholder="Type a port, e.g. 3000"
      inputRef={{ current: null }}
      {...over}
    />
  );
}

const icon = (iconNode: ReactNode) => renderToStaticMarkup(iconNode);

/**
 * The sandbox browser chrome two surfaces used to keep as drifting copies:
 * `BrowserPanel` (apps/web/src/features/session/action-panel/browser-panel.tsx)
 * and the detail layer's `AppPreview`
 * (apps/web/src/features/session/action-panel/easy/app-preview.tsx) rendered
 * the same toolbar and address bar with different i18n accessors and handler
 * names, so a fix to one silently missed the other. These tests pin the
 * behavior the shared module owns now.
 *
 * The draft state machine (typing, Escape, submit) cannot be driven under
 * `renderToStaticMarkup` — apps/web has no DOM testing library and none may be
 * added (see `provider-connect.test.tsx`) — so the wiring inside
 * `SandboxAddressBar` is pinned by scanning its source, the same idiom
 * `general-tab.rename.test.tsx` uses for un-drivable wiring, while everything
 * pure is asserted for real.
 */
describe('parseAddressInput — the sandbox-port address grammar', () => {
  test('a bare port becomes the internal localhost URL', () => {
    expect(parseAddressInput('3001')).toBe('http://localhost:3001/');
  });

  test('a colon-prefixed port', () => {
    expect(parseAddressInput(':3002')).toBe('http://localhost:3002/');
  });

  test('localhost and 127.0.0.1 prefixes', () => {
    expect(parseAddressInput('localhost:3003')).toBe('http://localhost:3003/');
    expect(parseAddressInput('127.0.0.1:3004')).toBe('http://localhost:3004/');
  });

  test('a full localhost URL is kept, with its path', () => {
    expect(parseAddressInput('http://localhost:3000/docs')).toBe('http://localhost:3000/docs');
    expect(parseAddressInput('localhost:3005/app?q=1')).toBe('http://localhost:3005/app?q=1');
    expect(parseAddressInput('3000/docs')).toBe('http://localhost:3000/docs');
  });

  test('an empty or blank draft parses to nothing', () => {
    expect(parseAddressInput('')).toBeNull();
    expect(parseAddressInput('   ')).toBeNull();
  });

  test('anything that is not a sandbox port is rejected', () => {
    expect(parseAddressInput('google.com')).toBeNull();
    expect(parseAddressInput('localhost')).toBeNull();
  });

  test('a port outside 1-65535 is rejected even though the draft looks numeric', () => {
    expect(parseAddressInput('0')).toBeNull();
    expect(parseAddressInput('65536')).toBeNull();
    expect(parseAddressInput('99999')).toBeNull();
    expect(parseAddressInput('65535')).toBe('http://localhost:65535/');
  });
});

describe('splitUrlForDisplay — the hostname highlight split', () => {
  test('splits prefix / host / rest', () => {
    expect(splitUrlForDisplay('http://localhost:3000/app')).toEqual({
      prefix: 'http://',
      host: 'localhost:3000',
      rest: '/app',
    });
  });

  test('a non-URL splits to nothing', () => {
    expect(splitUrlForDisplay('not a url')).toBeNull();
  });
});

describe('SandboxAddressBar — the shared toolbar', () => {
  test('renders back / forward, then Reload inside the address pill, in order', () => {
    intlErrors.length = 0;
    const html = render(bar());
    expect(intlErrors).toEqual([]);
    const back = icon(<ArrowLeft className="size-4" />);
    const forward = icon(<ArrowRight className="size-4" />);
    const reload = icon(<GrRefresh className="size-3.5" />);
    expect(html).toContain(back);
    expect(html).toContain(forward);
    expect(html).toContain(reload);
    expect(html.indexOf(back)).toBeLessThan(html.indexOf(forward));
    expect(html.indexOf(forward)).toBeLessThan(html.indexOf(reload));
  });

  test('without a live preview every control is disabled', () => {
    const html = render(bar({ hasPreview: false }));
    expect(html.match(/<button/g)?.length).toBe(3);
    expect(html.match(/disabled=""/g)?.length).toBe(3);
  });

  test('with a live preview reload stays enabled; back/forward follow history', () => {
    const html = render(bar({ hasPreview: true, canGoBack: true, canGoForward: true }));
    expect(html.match(/disabled=""/g)?.length ?? 0).toBe(0);

    const atStart = render(bar({ hasPreview: true }));
    // Only reload is enabled at the start of history: back and forward disabled.
    expect(atStart.match(/disabled=""/g)?.length ?? 0).toBe(2);
  });

  test('at rest the input shows the full URL with the hostname highlighted', () => {
    const html = render(bar({ displayValue: 'http://localhost:3000/app' }));
    expect(html).toContain('http://localhost:3000/app');
    expect(html).toContain('<span class="text-foreground">localhost:3000</span>');
  });

  test('without a live preview there is no hostname overlay to highlight', () => {
    const html = render(bar({ hasPreview: false }));
    expect(html).not.toContain('pointer-events-none absolute inset-y-0');
  });

  test('the loading state spins the reload glyph', () => {
    expect(render(bar({ isLoading: true }))).toContain('animate-spinner-spin');
    expect(render(bar({ isLoading: false }))).not.toContain('animate-spinner-spin');
  });

  test('an editable draft and Escape reset are wired into the input', () => {
    // Un-drivable under renderToStaticMarkup; pinned by source scan (see the
    // file comment). The scan strips comments so a commented-out branch
    // cannot satisfy it.
    const source = readFileSync(join(import.meta.dir, 'sandbox-browser-chrome.tsx'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

    // Escape clears the error, restores the surface's address and blurs —
    // gated on `resetOnEscape` (BrowserPanel restores only with a live preview).
    expect(code).toContain("if (e.key === 'Escape')");
    expect(code).toContain('if (resetOnEscape) setAddressValue(displayValue);');
    expect(code).toContain('inputRef.current?.blur()');

    // Submit: a blank draft does nothing, an unparseable draft flags the error
    // inline, a parsed draft hands the internal URL to `onNavigate`.
    expect(code).toContain('if (!addressValue.trim()) return;');
    expect(code).toContain('setAddressError(true)');
    expect(code).toContain('onNavigate(internal)');
    expect(code).toContain('parseAddressInput(addressValue)');
  });
});

describe('PreviewRecentsLanding — the shared recents list', () => {
  test('renders one row per recent with its display label', () => {
    const html = render(
      <PreviewRecentsLanding
        recents={[{ url: 'http://localhost:3000' }, { url: 'http://localhost:8080/x' }]}
        onOpen={noop}
      />,
    );
    expect(html).toContain('>Recents</h3>');
    expect(html).toContain('localhost:3000');
    expect(html).toContain('localhost:8080/x');
    expect(html.match(/<button/g)?.length).toBe(2);
  });

  test('the default row icon is the Globe span; renderIcon overrides it', () => {
    const html = render(
      <PreviewRecentsLanding recents={[{ url: 'http://localhost:3000' }]} onOpen={noop} />,
    );
    expect(html).toContain('<svg');
    expect(html).toContain('class="text-muted-foreground/60 size-4"');

    const custom = render(
      <PreviewRecentsLanding
        recents={[{ url: 'http://localhost:3000' }]}
        onOpen={noop}
        renderIcon={() => <b data-testid="favicon" />}
      />,
    );
    expect(custom).toContain('data-testid="favicon"');
    expect(custom).not.toContain('class="text-muted-foreground/60 size-4"');
  });
});

/**
 * Both surfaces render the SAME toolbar: the control set lives in
 * `SandboxAddressBar`, so each adopter only wires its own model (history
 * source, navigation, placeholder) into it. If either surface ever grows a
 * second inline toolbar, this scan fails.
 */
describe('the two surfaces render the shared chrome', () => {
  const actionPanel = join(import.meta.dir, '..');
  const browserPanelSource = readFileSync(
    join(actionPanel, 'browser-panel.tsx'),
    'utf8',
  );
  const appPreviewSource = readFileSync(
    join(actionPanel, 'easy', 'app-preview.tsx'),
    'utf8',
  );

  test('BrowserPanel renders SandboxAddressBar with its tab-store model', () => {
    expect(browserPanelSource).toContain('<SandboxAddressBar');
    expect(browserPanelSource).toContain('displayValue={fullUrl}');
    expect(browserPanelSource).toContain('onNavigate={navigateTo}');
    expect(browserPanelSource).toContain('resetOnEscape={hasPreview}');
  });

  test('AppPreview renders SandboxAddressBar with its tab-store-free model', () => {
    expect(appPreviewSource).toContain('<SandboxAddressBar');
    expect(appPreviewSource).toContain('displayValue={current}');
    expect(appPreviewSource).toContain('onNavigate={navigateTo}');
  });

  test('the old inline toolbar and address cascade are gone from both', () => {
    for (const [name, source] of [
      ['browser-panel', browserPanelSource],
      ['app-preview', appPreviewSource],
    ] as const) {
      // Back, forward and reload live in `SandboxAddressBar` only. Other
      // controls (AppPreview's "Open in a new tab") may still carry a Hint.
      for (const navKey of ['text76900f1bfd16', 'textf1c65e14817e', 'text0e9161011702']) {
        expect(source, name).not.toContain(navKey);
      }
      expect(source, name).not.toContain('/^\\d{1,5}(?:[/?#]|$)/');
      expect(source, name).not.toContain('splitUrlForDisplay');
    }
  });

  test('both landings render the shared recents list', () => {
    expect(browserPanelSource).toContain('<PreviewRecentsLanding');
    expect(appPreviewSource).toContain('<PreviewRecentsLanding');
  });
});
