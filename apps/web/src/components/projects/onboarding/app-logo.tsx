'use client';

import { PlugIcon } from '@phosphor-icons/react';
import Image from 'next/image';

import { cn } from '@/lib/utils';

/**
 * Third-party logos are drawn for a white page: many are black marks (GitHub,
 * X, Notion) that vanish on a dark tile. Each one sits on a white chip in both
 * themes; on the light theme the chip matches the tile.
 */
const LOGO_CHIP_CLASS = 'bg-white';

/** A catalogue app's logo in a 24px slot, or a plug when the catalogue has none. */
export function AppLogo({ src, className }: { src: string | null; className?: string }) {
  if (!src) {
    return (
      <span
        aria-hidden
        className={cn(
          'bg-muted text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-sm',
          className,
        )}
      >
        <PlugIcon className="size-3.5" />
      </span>
    );
  }
  return (
    <span
      className={cn(
        'flex size-6 shrink-0 items-center justify-center rounded-sm',
        LOGO_CHIP_CLASS,
        className,
      )}
    >
      <Image
        src={src}
        alt=""
        width={24}
        height={24}
        unoptimized
        referrerPolicy="no-referrer"
        className="size-5 object-contain"
      />
    </span>
  );
}
