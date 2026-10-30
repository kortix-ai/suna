import { CaretLeftIcon } from '@phosphor-icons/react';

import { cn } from '../lib/utils';

/**
 * The top-left way out of a full-screen surface (settings, account hub, /new):
 * a rounded-full ghost pill with a chevron and a label; it fills with
 * `bg-secondary` on hover. Below `sm` it is the chevron
 * alone in a round 28px button; the label stays as its accessible name.
 *
 * Use on `<Button variant="ghost" size="xs" className={backPillClass()}>`
 * with `<BackPillBody label=… />` as its content (or inside its `asChild` link).
 */
export function backPillClass(className?: string) {
  return cn(
    'hover:bg-secondary shrink-0 gap-1 rounded-full has-[>svg]:pr-3 has-[>svg]:pl-2',
    'max-sm:size-7 max-sm:justify-center max-sm:has-[>svg]:px-0',
    className,
  );
}

export function BackPillBody({ label }: { label: string }) {
  return (
    <>
      <CaretLeftIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="max-sm:sr-only">{label}</span>
    </>
  );
}
