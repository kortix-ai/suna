import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { SessionSharedIcon } from './session-shared-icon';

describe('SessionSharedIcon', () => {
  test('renders no ownership decoration for the viewer own session', () => {
    expect(renderToStaticMarkup(<SessionSharedIcon session={{ is_owner: true }} />)).toBe('');
  });

  test('renders one minimal sharing icon for a session owned by another principal', () => {
    const html = renderToStaticMarkup(
      <SessionSharedIcon
        session={{ is_owner: false, owner_name: 'Nightly reviewer', owner_email: null }}
      />,
    );

    expect(html).toContain('<svg');
    expect(html).not.toContain('>Shared<');
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Shared by Nightly reviewer"');
    expect(html).toContain('data-session-shared="true"');
  });

  test('does not guess that an older payload with unknown ownership is shared', () => {
    expect(renderToStaticMarkup(<SessionSharedIcon session={{}} />)).toBe('');
  });
});
