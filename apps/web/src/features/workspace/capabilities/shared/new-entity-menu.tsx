'use client';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Loading from '@/components/ui/loading';
import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
import {
  CaretDownIcon,
  ChatCircleIcon,
  GearSixIcon,
  PlusIcon,
  type Icon,
} from '@phosphor-icons/react';
import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * The one "New" control on the Agents, Skills, Connectors and Triggers tabs
 * (Marko, 2026-09-03: "show something similar like option create in Chat /
 * set up manually"). Two ways in, always the same two words:
 *
 *  - **Create in chat** — starts a configure session that scaffolds the thing
 *    and opens a change request.
 *  - **Set up manually** — the page's own form or modal, or the place in the
 *    repo where the thing is declared.
 */

/**
 * Both rows are the same object, so they are built by the same function: one
 * icon column, one title, one description. Writing either row by hand is how
 * the two drift apart.
 *
 * `items-start` — a description wraps to two lines, so a centred icon would
 * float into the middle of the block instead of reading as the title's marker.
 * `mt-0.5` (1.8px) then drops the 16px glyph onto the optical centre of the
 * 20px title line. Same nudge as `sandbox-template-menu.tsx`.
 *
 * `py-2` overrides the sm row's `py-1`: that step is sized for a single line of
 * text, and a two-line row under it reads as crowded against the panel edge.
 */
const OPTION_ROW = 'items-start gap-2 py-2';

function OptionContent({
  icon: OptionIcon,
  title,
  description,
}: {
  icon: Icon;
  title: ReactNode;
  description?: ReactNode;
}) {
  return (
    <>
      <OptionIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="block text-sm font-medium">{title}</span>
        {description ? (
          <span className="text-muted-foreground block text-xs">{description}</span>
        ) : null}
      </span>
    </>
  );
}

export function NewEntityMenu({
  label = 'New',
  size = 'sm',
  pending = false,
  onChat,
  manual,
}: {
  label?: string;
  size?: 'sm' | 'default';
  /** A configure session is being created — the trigger shows a spinner. */
  pending?: boolean;
  onChat: () => void;
  /** Absent = there is no manual flow for this thing (Skills, Marko
   *  2026-09-03): the control is a plain button that goes straight to chat. */
  manual?: { label?: string; description?: string } & (
    { onSelect: () => void; href?: never } | { href: string; onSelect?: never }
  );
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');

  // One button for both modes — the menu version only adds the caret. Written
  // twice, the two triggers drift in padding and icon size the first time
  // either is touched. The leading glyph and the spinner are both `size-4`, so
  // entering `pending` swaps the mark without moving the label a pixel.
  const trigger = (
    <Button
      variant="secondary"
      size={size}
      className="group gap-1.5"
      disabled={pending}
      onClick={manual ? undefined : onChat}
    >
      {pending ? <Loading className="size-4 shrink-0" /> : <PlusIcon className="size-4 shrink-0" />}
      {label}
      {manual ? (
        // `-mr-0.5` pulls the caret's optical edge back onto the button's text
        // inset: it is lighter than the label, so a full gap reads as a gap.
        <CaretDownIcon className="text-muted-foreground -mr-0.5 size-3.5 shrink-0 transition-transform duration-(--duration-normal) ease-out group-data-[state=open]:rotate-180 motion-reduce:transition-none" />
      ) : null}
    </Button>
  );

  if (!manual) return trigger;

  const manualContent = (
    <OptionContent
      icon={GearSixIcon}
      title={manual.label ?? 'Set up manually'}
      description={manual.description}
    />
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      {/* w-72 so both descriptions wrap at two lines: the rows end up the same
          height, and the panel reads as two equal choices rather than one
          option with a footnote. */}
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuItem className={OPTION_ROW} onSelect={onChat}>
          <OptionContent
            icon={ChatCircleIcon}
            title={tI18nComplete.raw('textb1895f6ddd9d')}
            description={tI18nComplete.raw('text31e3ed0f6798')}
          />
        </DropdownMenuItem>
        {manual.href ? (
          <DropdownMenuItem asChild className={OPTION_ROW}>
            <Link href={manual.href} prefetch>
              {manualContent}
            </Link>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem className={OPTION_ROW} onSelect={manual.onSelect}>
            {manualContent}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
