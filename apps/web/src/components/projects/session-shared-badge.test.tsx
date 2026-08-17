import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { SessionSharedBadge } from './session-shared-badge';

describe('SessionSharedBadge', () => {
  test('renders no ownership decoration for the viewer own session', () => {
    expect(renderToStaticMarkup(<SessionSharedBadge session={{ is_owner: true }} />)).toBe('');
  });

  test('renders a clear Shared label for a session owned by another principal', () => {
    const html = renderToStaticMarkup(
      <SessionSharedBadge
        session={{ is_owner: false, owner_name: 'Nightly reviewer', owner_email: null }}
      />,
    );

    expect(html).toContain('>Shared</span>');
    expect(html).toContain('aria-label="Shared by Nightly reviewer"');
    expect(html).toContain('data-session-shared="true"');
  });

  test('does not guess that an older payload with unknown ownership is shared', () => {
    expect(renderToStaticMarkup(<SessionSharedBadge session={{}} />)).toBe('');
  });
});
