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
import { CaretDownIcon, ChatCircleIcon, GearSixIcon, PlusIcon } from '@phosphor-icons/react';
import { UiLink as Link } from '@kortix/ui/providers/ui-provider';
import type { ComponentType } from 'react';

/**
 * One row of the New menu: icon, title, description (Paper "New menu" V03,
 * after `alert.tsx`). The 16px glyph takes `mt-1 ml-0.5` so it sits level
 * with the title's first line and in from the row edge, not up in the corner;
 * the title is ink at 550, the description one step down and muted, `mt-0.5`
 * under it.
 */
export const RICH_ROW_CLASS = 'items-start gap-2.5 py-2';

export function RichRowBody({
  icon: Glyph,
  title,
  description,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description?: string;
}) {
  return (
    <>
      <Glyph className="text-muted-foreground mt-1 ml-0.5 size-4 shrink-0" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-foreground text-sm font-[550]">{title}</span>
        {description ? (
          <span className="text-muted-foreground mt-0.5 text-xs font-normal text-pretty">
            {description}
          </span>
        ) : null}
      </span>
    </>
  );
}

/**
 * The one "New" control on the Agents, Skills, Connectors and Triggers tabs
 * (Marko, 2026-09-03: "show something similar like option create in Chat /
 * set up manually"). Two ways in, always the same two words:
 *
 *  - **Create in chat** — starts a configure session that scaffolds the thing
 *    and opens a change request.
 *  - **Set up manually** — the page's own form or modal, or the place in the
 *    repo where the thing is declared.
 *
 * A tab with one common case that needs no form leads with it (`quick`):
 * Connectors → "MCP server" (KRTX-2185).
 */
export function NewEntityMenu({
  label = 'New',
  size = 'sm',
  variant = 'secondary',
  caret = true,
  pending = false,
  onChat,
  manual,
  quick,
}: {
  label?: string;
  size?: 'sm' | 'default';
  /** `default` is the filled primary, for a page whose create action is its one primary (Triggers). */
  variant?: 'secondary' | 'default';
  /** The ⌄ after the label. Off inside a toolbar group (Triggers), where the menu still opens. */
  caret?: boolean;
  /** A configure session is being created — the trigger shows a spinner. */
  pending?: boolean;
  onChat: () => void;
  /** Absent = there is no manual flow for this thing (Skills, Marko
   *  2026-09-03): the control is a plain button that goes straight to chat. */
  manual?: { label?: string; description?: string } & (
    { onSelect: () => void; href?: never } | { href: string; onSelect?: never }
  );
  /** The first row, before Create in chat. Needs `manual`. */
  quick?: {
    icon: ComponentType<{ className?: string }>;
    label: string;
    description?: string;
    onSelect: () => void;
  };
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  if (!manual) {
    return (
      <Button variant={variant} size={size} className="gap-1.5" disabled={pending} onClick={onChat}>
        {pending ? <Loading className="size-4 shrink-0" /> : <PlusIcon className="size-4" />}
        {label}
      </Button>
    );
  }
  const manualLabel = manual.label ?? 'Set up manually';
  const manualBody = (
    <RichRowBody icon={GearSixIcon} title={manualLabel} description={manual.description} />
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={variant} size={size} className="gap-1.5" disabled={pending}>
          {pending ? <Loading className="size-4 shrink-0" /> : <PlusIcon className="size-4" />}
          {label}
          {caret ? <CaretDownIcon className="text-muted-foreground size-3.5 shrink-0" /> : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-76">
        {quick ? (
          <DropdownMenuItem className={RICH_ROW_CLASS} onSelect={quick.onSelect}>
            <RichRowBody icon={quick.icon} title={quick.label} description={quick.description} />
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem className={RICH_ROW_CLASS} onSelect={onChat}>
          <RichRowBody
            icon={ChatCircleIcon}
            title={tI18nComplete.raw('textb1895f6ddd9d')}
            description={tI18nComplete.raw('text31e3ed0f6798')}
          />
        </DropdownMenuItem>
        {manual.href ? (
          <DropdownMenuItem asChild className={RICH_ROW_CLASS}>
            <Link href={manual.href} prefetch>
              {manualBody}
            </Link>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem className={RICH_ROW_CLASS} onSelect={manual.onSelect}>
            {manualBody}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
