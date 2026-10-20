import { describe, expect, test } from 'bun:test';
import { MENU_INSET, MENU_INSET_END, MENU_LABEL, menuRow, type MenuRowSize } from './menu-recipe';

const SIZES: MenuRowSize[] = ['sm', 'md', 'lg'];

describe('menu row geometry', () => {
  test('sizes step up in height only: sm < md < lg', () => {
    expect(menuRow('sm', 'default')).toContain('min-h-8');
    expect(menuRow('md', 'default')).toContain('min-h-9');
    expect(menuRow('lg', 'default')).toContain('min-h-10');
  });

  test('padding, type and radius are the same at every size', () => {
    for (const size of SIZES) {
      const cls = menuRow(size, 'default');
      expect(cls).toContain('px-2');
      expect(cls).toContain('text-sm');
      expect(cls).toContain('rounded-sm');
      expect(cls).not.toMatch(/\[\d+px\]/);
    }
  });

  test('labels share the row edge; the inset lands after the icon slot', () => {
    expect(MENU_LABEL).toContain('px-2');
    // px-2 + size-4 slot + gap-2 = 8
    expect(MENU_INSET).toBe('pl-8');
    expect(MENU_INSET_END).toBe('pr-8');
  });

  test('an explicit icon size is no longer overridden by the row', () => {
    const cls = menuRow('sm', 'default');
    expect(cls).toContain("[&_svg:not([class*='size-'])]:size-4");
    expect(cls).not.toContain('[&_svg]:size-4');
  });
});
