import { useKeyboard } from '@opentui/react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { matchesBinding } from '../keymap.ts';
import { glyph as GLYPH, theme } from '../theme.ts';

export interface ListItem {
  /** Stable identity. Selection follows the id, not the index. */
  id: string;
  label: string;
  /** Right-aligned column: relative age, a count, a status word. */
  right?: string;
  /** One-column status glyph drawn before the label. */
  glyph?: string;
  /** Indent level. A sub-session is depth 1 under its parent. */
  depth?: number;
  /** Dim the whole row (not selectable-looking, but still selectable). */
  dim?: boolean;
}

export interface ListProps {
  items: ListItem[];
  /** Only a focused list answers keys. */
  focused?: boolean;
  /** Controlled selection. Omit to let the list own it. */
  selectedId?: string | null;
  onSelectedChange?: (id: string) => void;
  /** Enter on the selected row. */
  onOpen?: (item: ListItem) => void;
  /** Visible rows. Selection scrolls the window; omit to render every row. */
  maxRows?: number;
  /** Printed when `items` is empty. */
  emptyText?: string;
  /** Total width in columns, used to right-align the `right` column. */
  width?: number;
}

/** Clamp an index into `[0, length)`; -1 when the list is empty. */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return -1;
  if (index < 0) return 0;
  if (index >= length) return length - 1;
  return index;
}

/**
 * The first visible row for a window of `maxRows` that must contain
 * `selected`. Keeps the selection in view with the fewest rows moved.
 */
export function windowStart(selected: number, length: number, maxRows: number): number {
  if (maxRows <= 0 || length <= maxRows) return 0;
  const half = Math.floor(maxRows / 2);
  const start = Math.min(Math.max(selected - half, 0), length - maxRows);
  return Math.max(start, 0);
}

/** Pad/truncate `label` so `right` lands flush against `width`. */
export function layoutRow(label: string, right: string, width: number): string {
  if (width <= 0) return label;
  const rightRoom = right ? right.length + 1 : 0;
  const labelRoom = Math.max(width - rightRoom, 0);
  const clipped =
    label.length > labelRoom ? `${label.slice(0, Math.max(labelRoom - 1, 0))}…` : label;
  if (!right) return clipped;
  return `${clipped}${' '.repeat(Math.max(labelRoom - clipped.length, 0))} ${right}`;
}

/**
 * A keyboard list. `j/k`, arrows, `g`/`G`, PgUp/PgDn move; Enter opens.
 * Rendering is one `<text>` per row — a terminal list is text, and text is
 * what the frame assertions in `test/` read back.
 */
export function List({
  items,
  focused = false,
  selectedId,
  onSelectedChange,
  onOpen,
  maxRows,
  emptyText = 'Nothing here yet.',
  width = 28,
}: ListProps) {
  const [ownIndex, setOwnIndex] = useState(0);
  const controlledIndex = useMemo(
    () => (selectedId == null ? -1 : items.findIndex((item) => item.id === selectedId)),
    [items, selectedId],
  );
  const index = clampIndex(controlledIndex >= 0 ? controlledIndex : ownIndex, items.length);

  useEffect(() => {
    if (index >= 0 && index !== ownIndex) setOwnIndex(index);
  }, [index, ownIndex]);

  const move = useCallback(
    (next: number) => {
      const target = clampIndex(next, items.length);
      if (target < 0) return;
      setOwnIndex(target);
      const item = items[target];
      if (item) onSelectedChange?.(item.id);
    },
    [items, onSelectedChange],
  );

  useKeyboard((key) => {
    if (!focused || items.length === 0) return;
    const page = Math.max((maxRows ?? items.length) - 1, 1);
    if (matchesBinding(key, 'list.down')) return move(index + 1);
    if (matchesBinding(key, 'list.up')) return move(index - 1);
    if (matchesBinding(key, 'list.last')) return move(items.length - 1);
    if (matchesBinding(key, 'list.first')) return move(0);
    if (matchesBinding(key, 'list.pageDown')) return move(index + page);
    if (matchesBinding(key, 'list.pageUp')) return move(index - page);
    if (matchesBinding(key, 'list.open')) {
      const item = items[index];
      if (item) onOpen?.(item);
    }
  });

  if (items.length === 0) {
    return <text fg={theme.faint}>{emptyText}</text>;
  }

  const rows = maxRows ?? items.length;
  const start = windowStart(index, items.length, rows);
  const visible = items.slice(start, start + rows);

  return (
    <box flexDirection="column">
      {visible.map((item, offset) => {
        const isSelected = start + offset === index;
        const indent = '  '.repeat(item.depth ?? 0);
        const mark = isSelected && focused ? GLYPH.selected : ' ';
        const lead = item.glyph ? `${item.glyph} ` : '';
        const body = layoutRow(
          `${indent}${lead}${item.label}`,
          item.right ?? '',
          Math.max(width - 1, 0),
        );
        const fg = item.dim && !isSelected ? theme.faint : isSelected ? theme.fg : theme.dim;
        return (
          <text key={item.id} fg={fg} bg={isSelected ? theme.surface : undefined}>
            <span fg={theme.accent}>{mark}</span>
            {body}
          </text>
        );
      })}
    </box>
  );
}
