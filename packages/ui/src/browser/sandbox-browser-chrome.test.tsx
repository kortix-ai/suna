import { describe, expect, test } from 'bun:test';
import { IntlTestProvider } from '../test-utils/intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { defaultUiMessages as enMessages } from '../i18n';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ArrowLeftIcon as ArrowLeft,
  ArrowRightIcon as ArrowRight,
  ArrowClockwiseIcon as GrRefresh,
} from '@phosphor-icons/react';
import { Home } from '../internal/icons/home';
import {
  parseAddressInput,
  SandboxAddressBar,
  splitUrlForDisplay,
} from './sandbox-browser-chrome';

const intlErrors: string[] = [];

const render = (node: ReactNode) =>
  renderToStaticMarkup(
    <IntlTestProvider
      locale="en"
      messages={enMessages}
      timeZone="UTC"
      onError={(error) => intlErrors.push(error.code)}
    >
      {node}
    </IntlTestProvider>,
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
      onHome={noop}
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

  test('a Kortix App URL is kept, and gets its scheme when typed bare', () => {
    expect(parseAddressInput('https://dev-crm-0123456789abcdef.apps.kortix.com/deals')).toBe(
      'https://dev-crm-0123456789abcdef.apps.kortix.com/deals',
    );
    expect(parseAddressInput('dev-crm-0123456789abcdef.apps.kortix.com')).toBe(
      'https://dev-crm-0123456789abcdef.apps.kortix.com',
    );
    expect(parseAddressInput('0123456789abcdef.apps.localhost:14008/x')).toBe(
      'http://0123456789abcdef.apps.localhost:14008/x',
    );
    expect(parseAddressInput('github.com')).toBeNull();
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
  test('renders back / forward, then home / address / reload as one group, in order', () => {
    intlErrors.length = 0;
    const html = render(bar());
    expect(intlErrors).toEqual([]);
    const back = icon(<ArrowLeft className="size-4" />);
    const forward = icon(<ArrowRight className="size-4" />);
    const home = icon(<Home className="size-3.5" />);
    const reload = icon(<GrRefresh className="size-4" />);
    expect(html).toContain(back);
    expect(html).toContain(forward);
    expect(html).toContain(home);
    expect(html).toContain(reload);
    expect(html.indexOf(back)).toBeLessThan(html.indexOf(forward));
    expect(html.indexOf(forward)).toBeLessThan(html.indexOf(home));
    expect(html.indexOf(home)).toBeLessThan(html.indexOf('<input'));
    expect(html.indexOf('<input')).toBeLessThan(html.indexOf(reload));
  });

  test('without a live preview every control is disabled', () => {
    const html = render(bar({ hasPreview: false }));
    // Back, forward, home, reload. Home is disabled because the landing IS home.
    expect(html.match(/<button/g)?.length).toBe(4);
    expect(html.match(/disabled=""/g)?.length).toBe(4);
  });

  test('Home is a labelled button, not a decorative globe', () => {
    const html = render(bar({ hasPreview: true }));
    expect(html).toContain('aria-label="Home"');
  });

  test('with a live preview reload stays enabled; back/forward follow history', () => {
    const html = render(bar({ hasPreview: true, canGoBack: true, canGoForward: true }));
    expect(html.match(/disabled=""/g)?.length ?? 0).toBe(0);

    const atStart = render(bar({ hasPreview: true }));
    // Home and reload are enabled at the start of history: back and forward disabled.
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

