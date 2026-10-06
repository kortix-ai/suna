import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { UserAvatar, type UserAvatarSize } from './user-avatar';

/** The fallback tile: its classes and its text. */
function fallback(size: UserAvatarSize) {
  const html = renderToStaticMarkup(<UserAvatar size={size} name="Dana Gray" email="dana@example.com" />);
  const m = /<span[^>]*data-slot="avatar-fallback"[^>]*class="([^"]*)"[^>]*>([^<]*)<\/span>/.exec(html);
  if (!m) throw new Error(`no fallback in ${html}`);
  return { classes: m[1].split(/\s+/), text: m[2] };
}

// Two initials at 14px semibold filled the 22px message-sender tile edge to
// edge and overflowed the 18px sidebar tile: the fallback's own `text-sm` beat
// the size's `text-xs`. A small tile now holds one initial, as EntityAvatar
// does, at the size's own type rung.
describe('UserAvatar initials', () => {
  test('a small tile holds one initial at text-xs', () => {
    for (const size of ['xs', 'sm'] as const) {
      const { classes, text } = fallback(size);
      expect(text).toBe('D');
      expect(classes).toContain('text-xs');
      expect(classes).not.toContain('text-sm');
    }
  });

  test('a larger tile holds two initials at its own rung', () => {
    expect(fallback('md')).toMatchObject({ text: 'DG' });
    expect(fallback('md').classes).toContain('text-xs');
    expect(fallback('lg').classes).toContain('text-sm');
    expect(fallback('xl').classes).toContain('text-base');
  });
});
