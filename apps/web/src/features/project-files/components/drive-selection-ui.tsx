'use client';

import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import { Checkbox } from '@/components/ui/checkbox';
import { CheckSquareIcon } from '@phosphor-icons/react';
import type { ComponentType, ReactNode } from 'react';

import type { FileNode } from '@/features/file-browser/types';
import type { DriveSelection } from './drive-selection';

/** "Select" at the top of an item's menu: select mode, with this item in. */
export function SelectMenuItem({
  selection,
  node,
  Item,
  Separator,
}: {
  selection: DriveSelection | null;
  node: FileNode;
  Item: ComponentType<{ onClick?: () => void; children: ReactNode }>;
  Separator: ComponentType;
}) {
  const t = useTranslations('drives');
  if (!selection) return null;
  return (
    <>
      <Item onClick={() => selection.selectItem(node)}>
        <CheckSquareIcon />
        {t('select')}
      </Item>
      <Separator />
    </>
  );
}

/** The design system's checkbox in a card's corner while selecting; the card's click toggles it. */
export function SelectionCheck({ selected, className }: { selected: boolean; className?: string }) {
  return (
    <Checkbox
      checked={selected}
      tabIndex={-1}
      aria-hidden
      className={cn('bg-popover pointer-events-none shadow-xs', className)}
    />
  );
}
