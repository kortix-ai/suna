import type { ReactNode } from 'react';

import { theme } from '../theme.ts';

export interface PanelProps {
  /** Drawn into the top border. Omit for a borderless region. */
  title?: string;
  /** Drawn into the bottom border, right side. */
  footer?: string;
  /** Focus owns the brighter border. Nothing else changes. */
  focused?: boolean;
  /** Column width. Omit to let flex decide. */
  width?: number | `${number}%`;
  height?: number | `${number}%`;
  flexGrow?: number;
  flexShrink?: number;
  minWidth?: number;
  padding?: number;
  children?: ReactNode;
}

/**
 * A bordered region with a title. The frame of every screen area — sidebar,
 * transcript, terminal — so the border/title/focus rules live in one file.
 */
export function Panel({
  title,
  footer,
  focused = false,
  width,
  height,
  flexGrow,
  flexShrink,
  minWidth,
  padding = 0,
  children,
}: PanelProps) {
  return (
    <box
      border
      borderStyle="single"
      borderColor={focused ? theme.borderFocus : theme.border}
      title={title}
      titleColor={focused ? theme.fg : theme.dim}
      bottomTitle={footer}
      bottomTitleAlignment="right"
      backgroundColor={theme.bg}
      flexDirection="column"
      width={width}
      height={height}
      flexGrow={flexGrow}
      flexShrink={flexShrink}
      minWidth={minWidth}
      padding={padding}
      overflow="hidden"
    >
      {children}
    </box>
  );
}
