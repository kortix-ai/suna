import type { MenuController } from '../editor/suggestion';
import type { MenuNavState } from './menu-nav-state';

export function menuNavigation<TRow>(
  nav: MenuNavState<TRow>,
  updateSelection: () => void,
  select: (row: TRow) => void,
  teardown: () => void,
): Pick<MenuController<TRow>, 'onKeyDown' | 'onExit'> {
  return {
    onKeyDown({ event }) {
      if (!nav.getRows().length) return false;
      if (event.key === 'ArrowDown') {
        nav.move(1);
        updateSelection();
        return true;
      }
      if (event.key === 'ArrowUp') {
        nav.move(-1);
        updateSelection();
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const row = nav.getSelectedRow();
        if (row) select(row);
        return true;
      }
      return false;
    },
    onExit() {
      nav.close();
      teardown();
    },
  };
}
