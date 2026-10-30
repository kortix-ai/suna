/**
 * The slash menu: the command list that opens ABOVE the input while the draft
 * is one `/word`.
 *
 * It owns no keys. The input keeps the keyboard — you keep typing to filter,
 * and `prompt-input.tsx` moves the selection with ↑/↓ and runs it on Enter —
 * so this file is pixels only, and the same rows render in a test.
 *
 * In-flow on purpose, like `pickers/inline-picker.tsx`: an absolutely placed
 * modal mounted inside the session panel is clipped to the panel rectangle.
 */

import { hintFor } from '../../../keymap.ts';
import { glyph, theme } from '../../../theme.ts';
import { windowStart } from '../../../ui/index.ts';
import type { MenuEntry } from '../../../commands/registry.ts';

/** Rows the menu lists before it scrolls. */
export const SLASH_MENU_ROWS = 8;
/** Rows the menu's chrome costs: two borders. */
export const SLASH_MENU_CHROME_ROWS = 2;

export interface SlashMenuProps {
  entries: readonly MenuEntry[];
  selected: number;
  width: number;
  /** The word typed after the slash, echoed in the title. */
  query: string;
}

/** Rows the menu draws for `count` entries, chrome included. */
export function slashMenuHeight(count: number): number {
  return Math.max(Math.min(count, SLASH_MENU_ROWS), 1) + SLASH_MENU_CHROME_ROWS;
}

/** `/rename <title>` — the name column of one row. */
export function entryLabel(entry: MenuEntry): string {
  return entry.args ? `/${entry.name} ${entry.args}` : `/${entry.name}`;
}

export function SlashMenu({ entries, selected, width, query }: SlashMenuProps) {
  const inner = Math.max(width - 4, 16);
  const rows = Math.max(Math.min(entries.length, SLASH_MENU_ROWS), 1);
  const start = windowStart(selected, entries.length, rows);
  const visible = entries.slice(start, start + rows);
  // The name column fits the longest visible label, capped so a long arg hint
  // never squeezes the description out.
  const nameWidth = Math.min(
    Math.max(...visible.map((entry) => entryLabel(entry).length), 8) + 2,
    Math.floor(inner * 0.45),
  );

  return (
    <box
      border
      borderStyle="rounded"
      borderColor={theme.border}
      title={query ? ` / ${query} ` : ' commands '}
      titleColor={theme.dim}
      bottomTitle=" ↑↓ select · Tab complete · Enter run · Esc close "
      bottomTitleAlignment="right"
      backgroundColor={theme.bg}
      flexDirection="column"
      width={width}
      paddingLeft={1}
      paddingRight={1}
      overflow="hidden"
    >
      {visible.length === 0 ? (
        <text fg={theme.faint} wrapMode="none">
          No command matches. Enter sends the text as a prompt.
        </text>
      ) : (
        visible.map((entry, offset) => {
          const isSelected = start + offset === selected;
          const unavailable = entry.unavailable !== null;
          const label = entryLabel(entry).padEnd(nameWidth).slice(0, nameWidth);
          const chord = entry.binding ? hintFor(entry.binding) : '';
          const detail = unavailable ? (entry.unavailable ?? '') : entry.description;
          const room = Math.max(inner - 1 - nameWidth - (chord ? chord.length + 2 : 0), 4);
          const description = detail.length > room ? `${detail.slice(0, room - 1)}…` : detail;
          const nameColor = unavailable ? theme.faint : isSelected ? theme.accent : theme.fg;
          return (
            <box key={`${entry.source}:${entry.name}`} flexDirection="row" height={1}>
              <text fg={theme.accent} wrapMode="none">
                {isSelected ? glyph.selected : ' '}
              </text>
              <text fg={nameColor} wrapMode="none">
                {label}
              </text>
              <text fg={unavailable ? theme.faint : theme.dim} wrapMode="none" flexGrow={1}>
                {description}
              </text>
              {chord ? (
                <text fg={theme.faint} wrapMode="none">
                  {`  ${chord}`}
                </text>
              ) : null}
            </box>
          );
        })
      )}
    </box>
  );
}
