import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import type { ReactNode } from 'react';

import { matchesBinding } from '../keymap.ts';
import { theme } from '../theme.ts';

export interface ModalProps {
  title: string;
  /** Printed in the bottom border: the keys this modal answers to. */
  hint?: string;
  /** Esc, and anything else the modal decides to treat as dismiss. */
  onClose?: () => void;
  /** Columns. Clamped to the terminal width minus a 4-column gutter. */
  width?: number;
  /** Rows. Clamped to the terminal height minus a 4-row gutter. */
  height?: number;
  children?: ReactNode;
}

/** Terminal columns a modal box costs on top of its content: 2 border + 2 padding. */
export const MODAL_CHROME_COLUMNS = 4;
/** Terminal rows a modal box costs on top of its content: the two border rows. */
export const MODAL_CHROME_ROWS = 2;

export interface ModalBox {
  /** The outer box, border included. */
  boxWidth: number;
  boxHeight: number;
  /** What a child may actually draw into. */
  innerWidth: number;
  innerHeight: number;
}

/**
 * The size a `<Modal>` resolves to for a requested size on this terminal.
 *
 * Exported because a child cannot see the clamp: a picker that sized its
 * separator and its list from the REQUESTED width drew a 56-column rule inside
 * a 26-column box the moment the terminal was narrower than the request
 * (reproduced at 34 columns). Both sides now compute from this one function.
 */
export function modalBox(
  dimensions: { width: number; height: number },
  width = 64,
  height = 16,
): ModalBox {
  const boxWidth = Math.min(width, Math.max(dimensions.width - 4, 20));
  const boxHeight = Math.min(height, Math.max(dimensions.height - 4, 6));
  return {
    boxWidth,
    boxHeight,
    innerWidth: Math.max(boxWidth - MODAL_CHROME_COLUMNS, 1),
    innerHeight: Math.max(boxHeight - MODAL_CHROME_ROWS, 1),
  };
}

/**
 * A centered overlay. Positioned absolutely at the root so it covers whatever
 * is behind it, with `zIndex` above the layout.
 *
 * It must be mounted at the ROOT of the tree, never inside a `<Panel>`:
 * `ui/panel.tsx` sets `overflow: 'hidden'`, which scissors every absolutely
 * positioned descendant to the panel's rectangle (verified in wave 1 — the
 * sidebar's account picker rendered as a 10-column sliver). `app.tsx` owns one
 * overlay slot at the root; a feature that needs a modal asks for it through a
 * callback instead of rendering one itself.
 */
export function Modal({ title, hint, onClose, width, height, children }: ModalProps) {
  const dimensions = useTerminalDimensions();
  const { boxWidth, boxHeight } = modalBox(dimensions, width, height);

  useKeyboard((key) => {
    if (matchesBinding(key, 'back')) onClose?.();
  });

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width={dimensions.width}
      height={dimensions.height}
      zIndex={100}
      alignItems="center"
      justifyContent="center"
      backgroundColor={theme.bg}
    >
      <box
        border
        borderStyle="single"
        borderColor={theme.borderFocus}
        title={title}
        titleColor={theme.fg}
        bottomTitle={hint}
        bottomTitleAlignment="right"
        backgroundColor={theme.surface}
        flexDirection="column"
        width={boxWidth}
        height={boxHeight}
        paddingLeft={1}
        paddingRight={1}
        overflow="hidden"
      >
        {children}
      </box>
    </box>
  );
}
