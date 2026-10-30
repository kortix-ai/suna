'use client';

import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { CommandDialog } from '@kortix/ui/command';
import { useTranslations } from '@/i18n/use-translations';
import {
  consumePendingCommandPalette,
  hasPendingCommandPalette,
  OPEN_COMMAND_PALETTE_EVENT,
  openCommandPalette,
} from '@kortix/ui/internal/layout/open-command-palette';

function CommandPaletteLoading() {
  const t = useTranslations('common');
  const [open, setOpen] = useState(hasPendingCommandPalette);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    const down = (event: KeyboardEvent) => {
      if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        if (hasPendingCommandPalette()) {
          consumePendingCommandPalette();
          setOpen(false);
        } else {
          openCommandPalette();
        }
      }
    };
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen);
    document.addEventListener('keydown', down);
    setOpen(hasPendingCommandPalette());
    return () => {
      window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen);
      document.removeEventListener('keydown', down);
    };
  }, []);

  return (
    <CommandDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) consumePendingCommandPalette();
        setOpen(nextOpen);
      }}
      className="top-[17vh] translate-y-0 sm:max-w-[600px]"
      showCloseButton={false}
    >
      <div role="status" className="text-muted-foreground p-6 text-sm">
        {t('loading')}
      </div>
    </CommandDialog>
  );
}

export function CommandPaletteBoundary({ children }: { children: ReactNode }) {
  return <Suspense fallback={<CommandPaletteLoading />}>{children}</Suspense>;
}
