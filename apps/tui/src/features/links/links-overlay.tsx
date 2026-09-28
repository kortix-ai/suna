/**
 * `Alt+L`'s overlay: every URL the session produced — assistant text, tool
 * output, and whatever is on the terminal screen right now, wrapped rows
 * rejoined (`lib/links.ts`). Enter hands one to the browser; `y` copies it.
 *
 * A root-level overlay: `app.tsx` mounts it in the one overlay slot, like the
 * Ports panel. It exists because the terminal panel cannot be clicked: the
 * host terminal sees a wrapped URL as several unrelated rows.
 */

import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { useCallback, useState } from 'react';

import { matchesBinding } from '../../keymap.ts';
import { copyToClipboard } from '../../lib/clipboard.ts';
import { openUrl } from '../../lib/open-url.ts';
import { theme } from '../../theme.ts';
import { Modal, clampIndex, modalBox } from '../../ui/index.ts';
import type { ToastKind } from '../../ui/toast.tsx';
import { matchesLinksBinding } from './keys.ts';
import type { LinkRow } from './links-state.ts';

export interface LinksOverlayProps {
  rows: readonly LinkRow[];
  onClose(): void;
  onToast?: (message: string, kind?: ToastKind) => void;
  /** Test seams. Production launches the real browser / clipboard tool. */
  openUrlImpl?: typeof openUrl;
  copyImpl?: typeof copyToClipboard;
}

const SOURCE_GLYPH: Record<LinkRow['source'], string> = {
  transcript: '¶',
  terminal: '>',
};

/** One printed row: a source glyph and the URL, middle-elided to `width`. */
export function formatLinkRow(row: LinkRow, width: number): string {
  const prefix = `${SOURCE_GLYPH[row.source]} `;
  const room = Math.max(width - prefix.length, 8);
  if (row.url.length <= room) return `${prefix}${row.url}`;
  const head = Math.ceil((room - 1) * 0.6);
  const tail = room - 1 - head;
  return `${prefix}${row.url.slice(0, head)}…${row.url.slice(row.url.length - tail)}`;
}

export function LinksOverlay({
  rows,
  onClose,
  onToast,
  openUrlImpl = openUrl,
  copyImpl = copyToClipboard,
}: LinksOverlayProps) {
  const dimensions = useTerminalDimensions();
  const [selected, setSelected] = useState(0);

  const requestedWidth = Math.min(96, Math.max(dimensions.width - 4, 40));
  const requestedHeight = Math.min(rows.length + 4, 20);
  const { innerWidth, innerHeight } = modalBox(dimensions, requestedWidth, requestedHeight);
  const index = clampIndex(selected, rows.length);
  const current = index >= 0 ? rows[index] : undefined;
  const listRows = Math.max(innerHeight, 1);
  const windowStart =
    rows.length <= listRows
      ? 0
      : Math.min(Math.max(index - Math.floor(listRows / 2), 0), rows.length - listRows);
  const visible = rows.slice(windowStart, windowStart + listRows);

  const moveTo = useCallback(
    (next: number) => setSelected(clampIndex(next, rows.length)),
    [rows.length],
  );

  useKeyboard((key) => {
    if (matchesLinksBinding(key, 'links.close')) {
      key.preventDefault();
      onClose();
      return;
    }
    if (matchesBinding(key, 'list.down')) return moveTo(index + 1);
    if (matchesBinding(key, 'list.up')) return moveTo(index - 1);
    if (matchesBinding(key, 'list.first')) return moveTo(0);
    if (matchesBinding(key, 'list.last')) return moveTo(rows.length - 1);
    if (!current) return;
    if (matchesLinksBinding(key, 'links.open')) {
      key.preventDefault();
      const url = current.url;
      void openUrlImpl(url)
        .then(() => onToast?.(`Opened ${url}`))
        .catch((error: unknown) =>
          onToast?.(error instanceof Error ? error.message : String(error), 'error'),
        );
      return;
    }
    if (matchesLinksBinding(key, 'links.copy')) {
      key.preventDefault();
      const url = current.url;
      void copyImpl(url).then((result) => {
        onToast?.(
          result.ok ? `Copied ${url}` : `Copy failed: ${result.error}`,
          result.ok ? 'info' : 'error',
        );
      });
    }
  });

  return (
    <Modal
      title="Links"
      hint="Enter open · y copy · Esc close"
      onClose={onClose}
      width={requestedWidth}
      height={requestedHeight}
    >
      {rows.length === 0 ? (
        <text fg={theme.faint}>
          No links yet. URLs in the transcript and on the terminal screen show up here.
        </text>
      ) : null}
      {visible.map((row) => {
        const rowIndex = rows.indexOf(row);
        return (
          <text
            key={`${row.source}:${row.url}`}
            fg={rowIndex === index ? theme.fg : theme.dim}
            wrapMode="none"
          >
            {formatLinkRow(row, innerWidth)}
          </text>
        );
      })}
    </Modal>
  );
}
