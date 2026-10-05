/**
 * A picker that lives INSIDE the sidebar column.
 *
 * `ui/picker.tsx` is a centered `Modal`, and a modal cannot be used from here:
 * `ui/panel.tsx` sets `overflow: 'hidden'`, so every overlay a panel's subtree
 * draws is scissored to that panel's rectangle. Verified with
 * `scripts/dev-sidebar.tsx`: inside the panel the account picker rendered as a
 * 10-column sliver (`┌─Switch a`), and with `SIDEBAR_NO_PANEL=1` the same code
 * drew the full 60-column dialog. Hoisting overlays to the app root is the
 * integrator's call (`app.tsx` owns the layout frame); until then the sidebar
 * picks in its own column, which also reads better at 28 columns.
 *
 * Behaviour matches `ui/picker.tsx`: typing filters, Backspace deletes, the
 * list below answers `j/k`/arrows and Enter.
 */

import { useKeyboard } from '@opentui/react';
import { useMemo, useState } from 'react';

import { theme } from '../../theme.ts';
import { List, type ListItem, filterItems } from '../../ui/index.ts';
import { matchesSidebarBinding } from './keys.ts';

export interface ColumnPickerProps {
  title: string;
  items: ListItem[];
  width: number;
  height: number;
  /** Enter on a row. The picker does not close itself — the caller decides. */
  onPick: (item: ListItem) => void;
  onClose: () => void;
}

export function ColumnPicker({ title, items, width, height, onPick, onClose }: ColumnPickerProps) {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(items[0]?.id ?? null);
  const filtered = useMemo(() => filterItems(items, query), [items, query]);

  useKeyboard((key) => {
    if (matchesSidebarBinding(key, 'sidebar.cancel')) {
      onClose();
      return;
    }
    if (key.name === 'backspace') {
      setQuery((value) => value.slice(0, -1));
      return;
    }
    // A printable character with no modifier extends the filter. Navigation
    // keys fall through to the List, which ignores anything it does not bind.
    if (!key.ctrl && !key.option && key.sequence && key.sequence.length === 1) {
      const code = key.sequence.charCodeAt(0);
      if (code >= 0x20 && code !== 0x7f) setQuery((value) => value + key.sequence);
    }
  });

  const visibleId = filtered.some((item) => item.id === selectedId)
    ? selectedId
    : (filtered[0]?.id ?? null);

  return (
    <box flexDirection="column" width={width}>
      <text fg={theme.fg}>{title}</text>
      <text fg={query ? theme.fg : theme.faint}>{query ? `/ ${query}` : 'Type to filter'}</text>
      <text fg={theme.border}>{'─'.repeat(Math.max(width - 1, 0))}</text>
      <List
        items={filtered}
        focused
        selectedId={visibleId}
        onSelectedChange={setSelectedId}
        onOpen={onPick}
        maxRows={Math.max(height - 4, 1)}
        width={width}
        emptyText="No match."
      />
      <text fg={theme.faint}>Enter pick · Esc close</text>
    </box>
  );
}
