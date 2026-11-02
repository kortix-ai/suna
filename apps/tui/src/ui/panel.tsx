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
  /**
   * No frame. The session goes full-screen while the sidebar is hidden, the
   * way a shell fills its window; a frame there is chrome with nothing to
   * separate.
   */
  borderless?: boolean;
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
  borderless = false,
  children,
}: PanelProps) {
  // `border={false}` alone still draws a frame in OpenTUI 0.5.11 while a
  // `borderStyle` / `borderColor` is set (measured: the full-screen draft kept
  // its box and lost its last two rows). A borderless panel sets none of them.
  const frame = borderless
    ? {}
    : {
        border: true,
        borderStyle: 'single' as const,
        borderColor: focused ? theme.borderFocus : theme.border,
        title,
        titleColor: focused ? theme.fg : theme.dim,
        bottomTitle: footer,
        bottomTitleAlignment: 'right' as const,
      };
  return (
    <box
      {...frame}
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
