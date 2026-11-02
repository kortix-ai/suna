/**
 * A Kortix platform tool's answer (`send_message`, `list_agents`, `task_*`,
 * `task_stop`, the connectors…) as the card the tool wrote, not as JSON:
 *
 *   ✓ Sent to @reviewer · delivered
 *     reviewer      Code review              working
 *
 * The tool returns a `KortixToolResult` (`parseKortixToolResult`, SDK); its
 * `card` is written for people: a headline, a subtitle and a few rows.
 */

import type { KortixToolResult } from '@kortix/sdk';

import { printable } from '../../../lib/printable.ts';
import { clip } from '../../../lib/turn-layout.ts';
import { theme } from '../../../theme.ts';

const ROWS = 6;

const GLYPH: Record<KortixToolResult['card']['status'], string> = {
  done: '✓',
  running: '…',
  needs_you: '!',
  denied: '✗',
  error: '✗',
};

export function ResultCard({ result, width }: { result: KortixToolResult; width: number }) {
  const { card } = result;
  const bad = card.status === 'error' || card.status === 'denied';
  const inner = Math.max(width - 2, 12);
  const rows = card.rows ?? [];
  const shown = rows.slice(0, ROWS);
  const nameWidth = Math.min(Math.max(...shown.map((row) => row.title.length), 4), Math.floor(inner / 3));
  return (
    <box flexDirection="column">
      <text wrapMode="none">
        <span fg={bad ? theme.danger : card.status === 'needs_you' ? theme.brand : theme.dim}>{`${GLYPH[card.status]} `}</span>
        <span fg={theme.fg}>{clip(printable(card.title), inner - 2)}</span>
        <span fg={theme.dim}>{card.subtitle ? ` · ${clip(printable(card.subtitle), Math.max(inner - card.title.length - 6, 8))}` : ''}</span>
      </text>
      {result.error ? (
        <text fg={theme.danger} wrapMode="none">
          {`  ${clip(printable(result.error.message), inner - 2)}`}
        </text>
      ) : null}
      {shown.map((row, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: card rows have no id
        <text key={index} wrapMode="none">
          <span fg={theme.fg}>{`  ${printable(row.title).padEnd(nameWidth).slice(0, nameWidth)}`}</span>
          <span fg={theme.dim}>{row.detail ? `  ${clip(printable(row.detail), Math.max(inner - nameWidth - (row.badge?.length ?? 0) - 6, 6))}` : ''}</span>
          <span fg={theme.faint}>{row.badge ? `  ${printable(row.badge)}` : ''}</span>
        </text>
      ))}
      {rows.length > shown.length ? <text fg={theme.faint}>{`  … ${rows.length - shown.length} more`}</text> : null}
    </box>
  );
}
