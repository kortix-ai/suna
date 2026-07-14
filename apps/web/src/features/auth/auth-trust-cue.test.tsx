import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { AuthTrustCue } from './auth-primitives';

describe('AuthTrustCue', () => {
  test('renders a compact security reassurance for the auth surface', () => {
    const html = renderToStaticMarkup(<AuthTrustCue />);

    expect(html).toContain('Secure access to your Kortix workspace');
    expect(html).toContain('data-slot="badge"');
    expect(html).toContain('text-muted-foreground');
    expect(html).toContain('aria-hidden="true"');
  });
});
