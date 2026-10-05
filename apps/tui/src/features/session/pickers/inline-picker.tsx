/**
 * A filterable list that opens ABOVE the composer, inside the session column.
 *
 * WHY NOT `ui/Picker`: that primitive wraps `ui/Modal`, which is
 * `position="absolute"` at `top=0 left=0` with the FULL terminal size and
 * `zIndex: 100`. Absolute placement resolves against the containing block, so
 * mounted from inside the composer it anchors at the composer's own origin and
 * is then clipped by the session panel's `overflow="hidden"`. Verified in the
 * test renderer: a `<Picker>` mounted inside a 4-row bordered box rendered ZERO
 * of its rows and displaced the composer's own text. `ui/Picker` is a
 * root-level overlay; the composer needs an in-flow one.
 *
 * So this is the in-flow equivalent, built from the same parts the modal picker
 * uses — `ui/List` for navigation and windowing, `filterItems` for the query —
 * and it reads like opencode's own slash menu: a bordered block that grows
 * upward out of the input.
 *
 * `headerIds` marks rows that are section titles (the model picker's provider
 * groups). They render dim, `j`/`k` skip over them, and Enter on one does
 * nothing — a group name is a label, never a choice.
 */

import { useKeyboard } from '@opentui/react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { matchesBinding } from '../../../keymap.ts';
import { theme } from '../../../theme.ts';
import { type ListItem, filterItems } from '../../../ui/index.ts';

export interface InlinePickerProps {
  title: string;
  items: ListItem[];
  /** Ids that are section headings, not choices. */
  headerIds?: ReadonlySet<string>;
  /** The row to start on. Falls back to the first choice. */
  initialId?: string | null;
  /** Enter on a choice. The picker does not close itself — the caller decides. */
  onPick: (item: ListItem) => void;
  onClose: () => void;
  /** Total columns the block may use. */
  width: number;
  /** Visible rows, excluding the border, the filter line and the rule. */
  maxRows?: number;
  hint?: string;
}

/** The nearest selectable row at or after `from`, searching in `step`. */
export function nextSelectable(
  items: ListItem[],
  from: number,
  step: 1 | -1,
  headerIds: ReadonlySet<string>,
): number {
  for (let index = from; index >= 0 && index < items.length; index += step) {
    const item = items[index];
    if (item && !headerIds.has(item.id)) return index;
  }
  // Nothing in that direction: fall back to the first selectable row overall.
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item && !headerIds.has(item.id)) return index;
  }
  return -1;
}

const EMPTY_HEADERS: ReadonlySet<string> = new Set<string>();

export function InlinePicker({
  title,
  items,
  headerIds = EMPTY_HEADERS,
  initialId = null,
  onPick,
  onClose,
  width,
  maxRows = 8,
  hint = 'Enter pick · Esc close',
}: InlinePickerProps) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const matched = filterItems(items, query);
    if (!query.trim()) return matched;
    // A heading whose whole group filtered out is noise; drop the orphans.
    return matched.filter((item, index) => {
      if (!headerIds.has(item.id)) return true;
      const next = matched[index + 1];
      return Boolean(next && !headerIds.has(next.id));
    });
  }, [items, query, headerIds]);

  const [index, setIndex] = useState(() => {
    const start = initialId ? items.findIndex((item) => item.id === initialId) : -1;
    return nextSelectable(items, start >= 0 ? start : 0, 1, headerIds);
  });

  // A filter keystroke can drop the selected row. Land on a real choice again.
  useEffect(() => {
    setIndex((current) => {
      const item = filtered[current];
      if (item && !headerIds.has(item.id)) return current;
      return nextSelectable(filtered, Math.min(current, filtered.length - 1), 1, headerIds);
    });
  }, [filtered, headerIds]);

  const move = useCallback(
    (step: 1 | -1) => {
      setIndex((current) => {
        const candidate = nextSelectable(filtered, current + step, step, headerIds);
        return candidate < 0 ? current : candidate;
      });
    },
    [filtered, headerIds],
  );

  useKeyboard((key) => {
    if (matchesBinding(key, 'back')) {
      key.preventDefault();
      onClose();
      return;
    }
    if (key.name === 'up' || (key.name === 'p' && key.ctrl)) {
      key.preventDefault();
      return move(-1);
    }
    if (key.name === 'down' || (key.name === 'n' && key.ctrl)) {
      key.preventDefault();
      return move(1);
    }
    if (key.name === 'return') {
      key.preventDefault();
      const item = filtered[index];
      if (item && !headerIds.has(item.id)) onPick(item);
      return;
    }
    if (key.name === 'backspace') {
      key.preventDefault();
      setQuery((value) => value.slice(0, -1));
      return;
    }
    // A printable character with no Ctrl/Alt extends the filter. `j`/`k` are
    // NOT navigation here: the query is the point, and the arrows move.
    if (!key.ctrl && !key.option && !key.meta && key.sequence && key.sequence.length === 1) {
      const code = key.sequence.charCodeAt(0);
      if (code >= 0x20 && code !== 0x7f) {
        key.preventDefault();
        setQuery((value) => value + key.sequence);
      }
    }
  });

  const inner = Math.max(width - 4, 10);
  const rows = Math.max(Math.min(maxRows, filtered.length || 1), 1);
  const start = Math.max(Math.min(index - Math.floor(rows / 2), filtered.length - rows), 0);
  const visible = filtered.slice(start, start + rows);

  return (
    <box
      border
      borderStyle="single"
      borderColor={theme.borderFocus}
      title={title}
      titleColor={theme.fg}
      bottomTitle={hint}
      bottomTitleAlignment="right"
      backgroundColor={theme.surface}
      flexDirection="column"
      width={width}
      paddingLeft={1}
      paddingRight={1}
      overflow="hidden"
    >
      <text fg={query ? theme.fg : theme.faint}>{query ? `/ ${query}` : 'Type to filter'}</text>
      <text fg={theme.border}>{'─'.repeat(inner)}</text>
      {visible.length === 0 ? (
        <text fg={theme.faint}>No match.</text>
      ) : (
        visible.map((item, offset) => {
          const isHeader = headerIds.has(item.id);
          const isSelected = start + offset === index && !isHeader;
          const label = isHeader ? item.label : `  ${item.label}`;
          const right = item.right ?? '';
          const room = Math.max(inner - 1 - (right ? right.length + 1 : 0), 0);
          const clipped = label.length > room ? `${label.slice(0, Math.max(room - 1, 0))}…` : label;
          const padded = right
            ? `${clipped}${' '.repeat(Math.max(room - clipped.length, 0))} ${right}`
            : clipped;
          const fg = isHeader ? theme.faint : isSelected ? theme.fg : theme.dim;
          return (
            <text key={item.id} fg={fg} bg={isSelected ? theme.bg : undefined}>
              <span fg={theme.accent}>{isSelected ? '▌' : ' '}</span>
              {padded}
            </text>
          );
        })
      )}
    </box>
  );
}
