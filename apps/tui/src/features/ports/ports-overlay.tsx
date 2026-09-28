/**
 * `Alt+P`'s overlay: every sandbox port noticed so far (transcript, terminal,
 * or added by hand), whether it is forwarding, and the local address to reach
 * it at. A root-level overlay — `app.tsx` mounts it in the one overlay slot,
 * exactly like `HelpOverlay` and `Switcher` (see the note on `ui/Modal`).
 */

import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { useCallback, useState } from 'react';

import { matchesBinding } from '../../keymap.ts';
import { copyToClipboard } from '../../lib/clipboard.ts';
import { openUrl } from '../../lib/open-url.ts';
import { theme } from '../../theme.ts';
import { Modal, clampIndex, modalBox } from '../../ui/index.ts';
import type { ToastKind } from '../../ui/toast.tsx';
import { matchesPortsBinding } from './keys.ts';
import type { PortRow } from './ports-state.ts';

export interface PortsOverlayProps {
  rows: PortRow[];
  onToggle(port: number): void;
  onAdd(port: number): void;
  onClose(): void;
  onToast?: (message: string, kind?: ToastKind) => void;
  /** Test seams. Production launches the real browser / clipboard tool. */
  openUrlImpl?: typeof openUrl;
  copyImpl?: typeof copyToClipboard;
}

const STATE_GLYPH: Record<PortRow['state'], string> = {
  forwarding: '●',
  stopped: '○',
  error: '✗',
};

const STATE_COLOR: Record<PortRow['state'], string> = {
  forwarding: theme.accent,
  stopped: theme.faint,
  error: theme.danger,
};

/** `http://localhost:<localPort>` — what `o`/`y` act on. Null until forwarding. */
export function localUrlFor(row: PortRow): string | null {
  return row.localPort === null ? null : `http://localhost:${row.localPort}`;
}

/** One printed row: the glyph, the ports, the source, and the local URL if any. */
export function formatPortRow(row: PortRow, width: number): string {
  const left = `${STATE_GLYPH[row.state]} sandbox:${row.sandboxPort}`;
  const right =
    row.state === 'forwarding'
      ? (localUrlFor(row) ?? '')
      : row.state === 'error'
        ? (row.error ?? 'failed')
        : `(${row.source})`;
  const rightRoom = right ? right.length + 1 : 0;
  const labelRoom = Math.max(width - rightRoom, 0);
  const clipped = left.length > labelRoom ? `${left.slice(0, Math.max(labelRoom - 1, 0))}…` : left;
  if (!right) return clipped;
  return `${clipped}${' '.repeat(Math.max(labelRoom - clipped.length, 0))} ${right}`;
}

export function PortsOverlay({
  rows,
  onToggle,
  onAdd,
  onClose,
  onToast,
  openUrlImpl = openUrl,
  copyImpl = copyToClipboard,
}: PortsOverlayProps) {
  const dimensions = useTerminalDimensions();
  const [selected, setSelected] = useState(0);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');

  const { innerWidth, innerHeight } = modalBox(dimensions, 56, Math.min(rows.length + 4, 20));
  const index = clampIndex(selected, rows.length);
  const current = index >= 0 ? rows[index] : undefined;
  // One row goes to the inline "add a port" field when it's open.
  const listRows = Math.max(innerHeight - (adding ? 1 : 0), 1);
  const windowStart =
    rows.length <= listRows
      ? 0
      : Math.min(Math.max(index - Math.floor(listRows / 2), 0), rows.length - listRows);
  const visible = rows.slice(windowStart, windowStart + listRows);

  const moveTo = useCallback(
    (next: number) => setSelected(clampIndex(next, rows.length)),
    [rows.length],
  );

  const submitAdd = useCallback(() => {
    const port = Number(draft.trim());
    setAdding(false);
    setDraft('');
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      onToast?.(`Not a port: "${draft.trim()}"`, 'error');
      return;
    }
    onAdd(port);
  }, [draft, onAdd, onToast]);

  useKeyboard((key) => {
    if (adding) {
      if (matchesPortsBinding(key, 'ports.close')) {
        key.preventDefault();
        setAdding(false);
        setDraft('');
      }
      return;
    }

    if (matchesPortsBinding(key, 'ports.close')) {
      key.preventDefault();
      onClose();
      return;
    }
    if (matchesBinding(key, 'list.down')) return moveTo(index + 1);
    if (matchesBinding(key, 'list.up')) return moveTo(index - 1);
    if (matchesBinding(key, 'list.first')) return moveTo(0);
    if (matchesBinding(key, 'list.last')) return moveTo(rows.length - 1);
    if (matchesPortsBinding(key, 'ports.add')) {
      key.preventDefault();
      setAdding(true);
      return;
    }
    if (!current) return;
    if (matchesPortsBinding(key, 'ports.toggle')) {
      key.preventDefault();
      onToggle(current.sandboxPort);
      return;
    }
    if (matchesPortsBinding(key, 'ports.open')) {
      key.preventDefault();
      const url = localUrlFor(current);
      if (!url) {
        onToast?.(`sandbox:${current.sandboxPort} is not forwarding.`, 'error');
        return;
      }
      void openUrlImpl(url)
        .then(() => onToast?.(`Opened ${url}`))
        .catch((error: unknown) =>
          onToast?.(error instanceof Error ? error.message : String(error), 'error'),
        );
      return;
    }
    if (matchesPortsBinding(key, 'ports.copy')) {
      key.preventDefault();
      const url = localUrlFor(current);
      if (!url) {
        onToast?.(`sandbox:${current.sandboxPort} is not forwarding.`, 'error');
        return;
      }
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
      title="Ports"
      hint={
        adding ? 'Enter add · Esc cancel' : 'Enter toggle · o open · y copy · a add · Esc close'
      }
      onClose={onClose}
      width={56}
      height={Math.min(rows.length + 4, 20)}
    >
      {rows.length === 0 && !adding ? (
        <text fg={theme.faint}>No ports noticed yet. Press "a" to add one.</text>
      ) : null}
      {visible.map((row) => {
        const rowIndex = rows.indexOf(row);
        return (
          <text
            key={row.sandboxPort}
            fg={rowIndex === index ? theme.fg : STATE_COLOR[row.state]}
            wrapMode="none"
          >
            {formatPortRow(row, innerWidth)}
          </text>
        );
      })}
      {adding ? (
        <box flexDirection="row" width={innerWidth}>
          <text fg={theme.accent}>{'#'}</text>
          <input
            focused
            flexGrow={1}
            value={draft}
            placeholder="sandbox port"
            onInput={(value: string) => setDraft(value.replace(/[^0-9]/g, ''))}
            onSubmit={submitAdd}
          />
        </box>
      ) : null}
    </Modal>
  );
}
