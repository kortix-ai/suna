import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { InstallButton } from './install-menu';

describe('InstallButton', () => {
  test('is one button with no audience menu', () => {
    const markup = renderToStaticMarkup(
      <InstallButton label="Install" aria-label="Install Miro" onInstall={() => undefined} />,
    );
    expect(markup).toContain('Install');
    expect(markup).not.toContain('Only you');
    expect(markup).not.toContain('aria-haspopup');
  });
});
