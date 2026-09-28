'use client';

import { CopyIcon } from '@phosphor-icons/react';
import type * as React from 'react';

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { useTranslations } from '@/i18n/use-translations';

const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
// A key chord, not UI copy: it is the same in every locale.
const COPY_SHORTCUT = isMac ? '⌘C' : 'Ctrl+C';

/**
 * Right-click menu for a canvas grid (CSV, XLSX). A canvas has no text for the
 * browser's own menu to copy, so this gives the selection a Copy item.
 */
export function ViewerCopyMenu({
  children,
  onCopy,
}: {
  children: React.ReactNode;
  onCopy: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-40">
        <ContextMenuItem onSelect={onCopy}>
          <CopyIcon className="size-4" />
          {tI18nComplete.raw('texte21f935f11d7')}
          <ContextMenuShortcut>{COPY_SHORTCUT}</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
