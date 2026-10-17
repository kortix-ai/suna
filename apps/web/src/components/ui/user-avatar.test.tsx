import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { AVATAR_INK, avatarFill } from '@kortix/shared';

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

// Avatar v2 (Paper "Avatar · v2"): a `rounded-sm` tile, never a circle, one solid fill from the email,
// white initials, no border.
describe('UserAvatar v2 look', () => {
  test('a rounded-sm tile with a solid fill and white initials, no border', () => {
    const html = renderToStaticMarkup(<UserAvatar size="md" name="Dana Gray" email="dana@example.com" />);
    expect(html).toContain('rounded-sm');
    expect(html).not.toContain('rounded-full');
    expect(html).not.toContain('border');
    expect(html).toContain(`color:${AVATAR_INK}`);
    expect(html).toContain(`background-color:${avatarFill('dana@example.com')}`);
  });

  test('a rename keeps the colour: the fill follows the email', () => {
    const a = renderToStaticMarkup(<UserAvatar name="Dana Gray" email="dana@example.com" />);
    const b = renderToStaticMarkup(<UserAvatar name="Dana Smith" email="dana@example.com" />);
    const fill = (html: string) => /background-color:([^;"]+)/.exec(html)?.[1];
    expect(fill(a)).toBe(fill(b));
  });
});
