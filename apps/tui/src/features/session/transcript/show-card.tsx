/**
 * A `show` call: the agent handing something over. The web draws the thing
 * itself (an artifact beside the chat, a carousel of files); a terminal draws
 * one line per item, the link or path under it, and the key that reaches it:
 *
 *   ▣ Q3 churn report                                    Doc
 *     https://kortix.com/workspaces/…/artifacts/…
 *     Alt+O open · reference · copy
 *
 * Items come from `shownItems` (the SDK's `showGroupItems`), so the card,
 * the tray and `/shown` agree on what was shown.
 */

import type { ToolView } from '@kortix/sdk';
import { useArtifact } from '@kortix/sdk/react';

import { clip, isShowTool } from '../../../lib/turn-layout.ts';
import { theme } from '../../../theme.ts';
import { Spinner, layoutRow } from '../../../ui/index.ts';
import { type SessionOutput, outputKindLabel, shownItems } from '../../artifacts/session-outputs.ts';
import { useTranscriptSession } from './session-context.tsx';

const GLYPH = { artifact: '▣', page: '◎', image: '▨', video: '▶', deck: '▤', file: '▢' } as const;

export const SHOW_HINT = 'Alt+O open · reference · copy';

export { isShowTool };

export function ShowCard({ tool, width }: { tool: ToolView; width: number }) {
  if (tool.status === 'running' || tool.status === 'pending') {
    return <Spinner label={clip('Showing…', Math.max(width - 2, 4))} />;
  }
  const items = shownItems(tool, 'card', 0);
  if (tool.status === 'error' || items.length === 0) {
    const title = typeof tool.input?.title === 'string' && tool.input.title ? tool.input.title : tool.title;
    return (
      <box flexDirection="column">
        <text fg={theme.dim}>
          <span fg={tool.status === 'error' ? theme.danger : theme.ok}>{tool.status === 'error' ? '✗' : '✓'}</span>
          {` ${clip(title, Math.max(width - 2, 4))}`}
        </text>
        {tool.status === 'error' && tool.error ? (
          <text fg={theme.danger}>{`  ${clip(tool.error, Math.max(width - 2, 8))}`}</text>
        ) : null}
      </box>
    );
  }
  const inner = Math.max(width - 2, 8);
  return (
    <box flexDirection="column">
      {items.map((item) => (
        <ShownRow key={item.key} item={item} width={inner} />
      ))}
      <text fg={theme.faint}>{`  ${SHOW_HINT}`}</text>
    </box>
  );
}

/**
 * One shown item. An artifact reads its record, as the web's show card does:
 * an agent often names it in `content` or not at all, and the record holds
 * its real title and kind.
 */
function ShownRow({ item, width }: { item: SessionOutput; width: number }) {
  const { projectId } = useTranscriptSession();
  const record = useArtifact(item.artifactId ? projectId : null, item.artifactId);
  const shown: SessionOutput = record.data
    ? { ...item, title: record.data.title || item.title, artifactType: record.data.type }
    : item;
  return (
    <box flexDirection="column">
      <text fg={theme.fg}>
        <span fg={theme.fg}>{`${GLYPH[shown.kind]} `}</span>
        {layoutRow(shown.title, outputKindLabel(shown), width)}
      </text>
      <text fg={theme.faint}>{`  ${clip(shown.url ?? shown.path ?? '', width)}`}</text>
    </box>
  );
}
