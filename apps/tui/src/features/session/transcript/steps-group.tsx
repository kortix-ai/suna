/**
 * A run of consecutive tool calls, collapsed to one row.
 *
 * Collapsed: `▸ Completed 7 steps`. Running: `⠋ Working · step 3: Shell`.
 * Expanded (`Enter`/`Space` on the cursor row): one `<ToolCard>` per call.
 */

import type { ClassifiedToolPart } from '@kortix/sdk';

import { stepsLabel, summarizeSteps } from '../../../lib/turn-layout.ts';
import { glyph, theme } from '../../../theme.ts';
import { Spinner } from '../../../ui/index.ts';
import { ToolCard } from './tool-card.tsx';

export interface StepsGroupProps {
  tools: ClassifiedToolPart[];
  expanded: boolean;
  /** Draw the cursor marker — the transcript is focused and this is the row. */
  cursor: boolean;
  width: number;
}

export function StepsGroup({ tools, expanded, cursor, width }: StepsGroupProps) {
  const summary = summarizeSteps(tools);
  const label = stepsLabel(summary);
  const marker = cursor ? glyph.selected : ' ';
  const arrow = expanded ? glyph.expanded : glyph.collapsed;
  const failed = !summary.running && summary.failed > 0;

  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <text fg={theme.accent}>{marker}</text>
        {summary.running ? (
          <Spinner label={label} />
        ) : (
          <text fg={failed ? theme.danger : theme.dim}>{`${arrow} ${label}`}</text>
        )}
      </box>
      {expanded ? (
        <box flexDirection="column" paddingLeft={2}>
          {tools.map((tool) => (
            <ToolCard key={tool.id} tool={tool.tool} width={Math.max(width - 2, 10)} />
          ))}
        </box>
      ) : null}
    </box>
  );
}
