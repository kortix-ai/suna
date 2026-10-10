import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { InstallMenu } from './install-menu';

const copy = {
  label: 'Install',
  onlyYou: 'Only you',
  everyone: 'Everyone in Acme',
  onInstall: () => {},
};

describe('InstallMenu', () => {
  test('a member who cannot share gets one plain button, no menu', () => {
    const markup = renderToStaticMarkup(<InstallMenu {...copy} canShare={false} />);
    expect(markup).toContain('>Install<');
    expect(markup).not.toContain('aria-haspopup');
  });

  test('a member who can share gets a menu trigger', () => {
    const markup = renderToStaticMarkup(<InstallMenu {...copy} canShare />);
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain('>Install<');
  });

  test('pending disables the control', () => {
    const markup = renderToStaticMarkup(<InstallMenu {...copy} canShare={false} pending />);
    expect(markup).toContain('disabled=""');
  });

  test('the test id lands on the trigger', () => {
    const markup = renderToStaticMarkup(
      <InstallMenu {...copy} canShare data-testid="catalog-add" />,
    );
    expect(markup).toContain('data-testid="catalog-add"');
  });

  test('the aria-label lands on the trigger in both branches', () => {
    for (const canShare of [false, true]) {
      const markup = renderToStaticMarkup(
        <InstallMenu {...copy} canShare={canShare} aria-label="Install Resend" />,
      );
      expect(markup).toMatch(/<button[^>]*aria-label="Install Resend"/);
      expect(markup).toContain('>Install<');
    }
  });
});
