/**
 * The `?` overlay (SPEC §5.10): every binding in the app, grouped by scope.
 *
 * It renders `allBindings()` — this file holds no key table of its own, so a
 * binding added to any feature's `keys.ts` appears here on the next render and
 * a binding removed there disappears. `help-overlay.test.tsx` asserts exactly
 * that: no duplicate ids, and every feature table represented.
 *
 * It is a root-level overlay. `app.tsx` mounts it in its one overlay slot; it
 * must never be rendered inside a `<Panel>` (see the note on `ui/Modal`).
 */

import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { useMemo, useState } from 'react';

import {
  type Binding,
  type KeyScope,
  SCOPE_ORDER,
  SCOPE_TITLE,
  allBindings,
  formatBinding,
  matchesBinding,
} from '../../keymap.ts';
import { theme } from '../../theme.ts';
import { Modal, modalBox } from '../../ui/index.ts';

/** One printed line of the overlay: a section title or a binding row. */
export type HelpLine =
  | { kind: 'section'; scope: KeyScope; title: string }
  | { kind: 'binding'; binding: Binding; keys: string };

/** Columns reserved for the chord column, so the descriptions line up. */
export const KEYS_COLUMN = 24;

/**
 * Every binding as printable lines, grouped by scope in `SCOPE_ORDER`.
 *
 * A scope with no bindings prints no heading. A scope that is not in
 * `SCOPE_ORDER` still prints, appended at the end — a new scope must never be
 * silently dropped from the help.
 */
export function helpLines(bindings: readonly Binding[] = allBindings()): HelpLine[] {
  const seen = new Set<KeyScope>();
  const order: KeyScope[] = [...SCOPE_ORDER];
  for (const binding of bindings) if (!order.includes(binding.scope)) order.push(binding.scope);

  const lines: HelpLine[] = [];
  for (const scope of order) {
    if (seen.has(scope)) continue;
    seen.add(scope);
    const rows = bindings.filter((binding) => binding.scope === scope);
    if (rows.length === 0) continue;
    lines.push({ kind: 'section', scope, title: SCOPE_TITLE[scope] ?? scope });
    for (const binding of rows) {
      // A row with no chords is a rule, not a key: `terminal.passthrough`
      // documents that everything unlisted reaches the remote shell. It still
      // has to be printed, so it gets a printed stand-in rather than a blank.
      lines.push({ kind: 'binding', binding, keys: formatBinding(binding) || 'any other key' });
    }
  }
  return lines;
}

/** `── Composer ───────────…` — a section heading that fills the row. */
export function sectionRule(title: string, width: number): string {
  const head = `── ${title} `;
  return head.length >= width ? head.slice(0, Math.max(width, 0)) : head.padEnd(width, '─');
}

export interface HelpOverlayProps {
  onClose: () => void;
}

/**
 * The overlay. It scrolls with `j`/`k`/arrows and PgUp/PgDn when the table is
 * taller than the terminal — at 24 rows it is, by a lot (the table is ~120
 * lines), so a non-scrolling overlay would hide most of the app's keys.
 */
export function HelpOverlay({ onClose }: HelpOverlayProps) {
  const dimensions = useTerminalDimensions();
  const lines = useMemo(() => helpLines(), []);
  const [top, setTop] = useState(0);

  const { innerWidth, innerHeight } = modalBox(
    dimensions,
    Math.max(dimensions.width - 8, 40),
    Math.max(dimensions.height - 2, 8),
  );
  // One row goes to the scroll position line at the bottom.
  const rows = Math.max(innerHeight - 1, 1);
  const maxTop = Math.max(lines.length - rows, 0);
  const clampedTop = Math.min(top, maxTop);

  useKeyboard((key) => {
    if (matchesBinding(key, 'help') || matchesBinding(key, 'back')) {
      key.preventDefault();
      onClose();
      return;
    }
    if (matchesBinding(key, 'list.down')) return setTop((value) => Math.min(value + 1, maxTop));
    if (matchesBinding(key, 'list.up')) return setTop((value) => Math.max(value - 1, 0));
    if (matchesBinding(key, 'list.pageDown'))
      return setTop((value) => Math.min(value + rows, maxTop));
    if (matchesBinding(key, 'list.pageUp')) return setTop((value) => Math.max(value - rows, 0));
    if (matchesBinding(key, 'list.first')) return setTop(0);
    if (matchesBinding(key, 'list.last')) return setTop(maxTop);
  });

  const visible = lines.slice(clampedTop, clampedTop + rows);
  const position =
    maxTop === 0
      ? 'all keys'
      : `${clampedTop + 1}–${clampedTop + visible.length} of ${lines.length}`;

  return (
    <Modal
      title="Keys"
      hint="j/k scroll · Esc close"
      onClose={onClose}
      width={Math.max(dimensions.width - 8, 40)}
      height={Math.max(dimensions.height - 2, 8)}
    >
      {visible.map((line) =>
        line.kind === 'section' ? (
          // One row, never a leading blank: the row budget above is exact, and
          // a `\n` inside a <text> silently costs a second row.
          <text key={`s:${line.scope}`} fg={theme.fg} wrapMode="none" height={1}>
            {sectionRule(line.title, innerWidth)}
          </text>
        ) : (
          <box key={line.binding.id} flexDirection="row" height={1}>
            <box width={KEYS_COLUMN} flexShrink={0}>
              <text fg={theme.accent} wrapMode="none">
                {line.keys}
              </text>
            </box>
            <text fg={theme.dim} wrapMode="none">
              {line.binding.description.slice(0, Math.max(innerWidth - KEYS_COLUMN, 8))}
            </text>
          </box>
        ),
      )}
      <text fg={theme.faint} wrapMode="none">
        {position}
      </text>
    </Modal>
  );
}
