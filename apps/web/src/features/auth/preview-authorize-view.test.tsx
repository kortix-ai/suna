import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { PreviewAuthorizeView, previewAddress } from './preview-authorize-view';

const PREVIEW = 'https://dev-p3000-a1b2c3.p.kortix.com/pricing?x=1';

function render(state: 'opening' | 'not-served' | 'expired', to = PREVIEW) {
  return renderToStaticMarkup(
    <PreviewAuthorizeView
      state={state}
      to={to}
      email="alex@example.com"
      onSignInAgain={() => undefined}
    />,
  );
}

describe('previewAddress', () => {
  test('a preview is named by its host', () => {
    expect(previewAddress(PREVIEW, false)).toBe('dev-p3000-a1b2c3.p.kortix.com');
  });

  test('an address that is not a preview keeps its path: it says where the link pointed', () => {
    expect(previewAddress('https://example.test/login?next=1', true)).toBe('example.test/login');
    expect(previewAddress('https://example.test/', true)).toBe('example.test');
  });

  test('text that is not a URL is shown as written', () => {
    expect(previewAddress('  not a url ', true)).toBe('not a url');
    expect(previewAddress('', true)).toBe('');
  });
});

describe('PreviewAuthorizeView', () => {
  test('opening: which preview, for which account, and that it opens by itself', () => {
    const html = render('opening');
    expect(html).toContain('Opening preview');
    expect(html).toContain('dev-p3000-a1b2c3.p.kortix.com');
    expect(html).not.toContain('/pricing');
    expect(html).toContain('alex@example.com');
    expect(html).toContain('The preview opens by itself.');
    expect(html).not.toContain('<button');
  });

  test('address not served: the address that was refused, and no way to proceed to it', () => {
    const html = render('not-served', 'https://example.test/login');
    expect(html).toContain('Cannot open that preview');
    expect(html).toContain('not a preview this deployment serves');
    expect(html).toContain('example.test/login');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<a ');
  });

  test('address not served with no address at all shows no empty row', () => {
    const html = render('not-served', '');
    expect(html).toContain('Cannot open that preview');
    expect(html).not.toContain('<dl');
  });

  test('session expired: the preview it was for, and one way forward', () => {
    const html = render('expired');
    expect(html).toContain('Cannot open that preview');
    expect(html).toContain('Your session expired.');
    expect(html).toContain('dev-p3000-a1b2c3.p.kortix.com');
    expect(html).toContain('Sign in again');
  });
});
