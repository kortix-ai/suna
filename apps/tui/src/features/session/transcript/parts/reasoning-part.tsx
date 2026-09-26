/**
 * A reasoning part: collapsed to one dim line by default, expanded to its full
 * text on `Enter`/`Space` while the cursor is on it.
 */

import { clip } from '../../../../lib/turn-layout.ts';
import { glyph, theme } from '../../../../theme.ts';

export interface ReasoningPartProps {
  text: string;
  expanded: boolean;
  /** Draw the cursor marker — the transcript is focused and this is the row. */
  cursor: boolean;
  width: number;
}

export function ReasoningPart({ text, expanded, cursor, width }: ReasoningPartProps) {
  const marker = cursor ? glyph.selected : ' ';
  const arrow = expanded ? glyph.expanded : glyph.collapsed;
  const firstLine = text.trim().split('\n')[0] ?? '';
  return (
    <box flexDirection="column">
      <text fg={theme.faint}>
        <span fg={theme.accent}>{marker}</span>
        {`${arrow} Thinking`}
        {expanded ? '' : ` · ${clip(firstLine, Math.max(width - 14, 4))}`}
      </text>
      {expanded ? (
        <text fg={theme.faint} wrapMode="word" width={Math.max(width - 2, 1)}>
          {text.trim()}
        </text>
      ) : null}
    </box>
  );
}
