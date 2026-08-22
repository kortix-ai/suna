'use client';

/**
 * One dialect for every alert row in the project sidebar's footer.
 *
 * Four rows can fire at once — a failing sandbox build, a v1 manifest, an empty
 * wallet, a free plan — and each used to describe itself differently: one
 * transparent with tinted text, one tinted fill, one tinted fill *and* a
 * coloured border, one solid inverted button. Three heights (`h-8`/`h-9`), three
 * icon-size overrides, two horizontal paddings. Stacked, they read as four
 * unrelated warnings shouting over each other instead of one calm list.
 *
 * So the rules live here, once:
 *
 * - **Tone is text, never fill.** The icon and the label carry the colour; the
 *   background stays the sidebar's. A tinted bar per warning turns the footer
 *   into a ransom note, and it competes with the one row that legitimately
 *   fills — the green "Review changes" pill, which is an invitation rather than
 *   a warning.
 * - **One height, one gutter.** Everything is a default `SidebarMenuButton`
 *   (`h-8`, `p-2`), so the footer shares its left edge with Files, Customize and
 *   every session row above it.
 * - **A row that expands says so.** Both alerts hid an expandable body behind a
 *   row with no affordance at all. One caret, rotating on open.
 *
 * The one deliberate exception is the upgrade CTA: it is an offer, not an
 * alert, and stays a solid button so the difference is legible at a glance.
 */

import { CaretDownIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';

export type SidebarAlertTone = 'critical' | 'warning' | 'info' | 'neutral';

/**
 * `hover:` and `active:` repeat the resting colour on purpose. The sidebar
 * button recipe resets both to the neutral accent foreground, so a caller that
 * set only `text-destructive` watched its tone vanish the moment the pointer
 * touched the row — the state that matters most is the one where the colour
 * disappeared.
 */
const TONE_TEXT: Record<SidebarAlertTone, string> = {
  critical: 'text-destructive hover:text-destructive active:text-destructive',
  warning: 'text-kortix-orange hover:text-kortix-orange active:text-kortix-orange',
  info: 'text-kortix-base hover:text-kortix-base active:text-kortix-base',
  neutral: 'text-muted-foreground hover:text-foreground active:text-foreground',
};

const ROW_CLASS = 'font-medium';

/** A footer alert that just goes somewhere — one click, no body. */
export function SidebarAlertRow({
  tone,
  icon,
  label,
  trailing,
  onClick,
}: {
  tone: SidebarAlertTone;
  icon: ReactNode;
  label: string;
  /** Optional right-aligned hint naming what the click does ("Top up"). */
  trailing?: ReactNode;
  onClick: () => void;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton type="button" onClick={onClick} className={cn(ROW_CLASS, TONE_TEXT[tone])}>
        {icon}
        <span className="truncate">{label}</span>
        {trailing ? <span className="ml-auto shrink-0 text-xs opacity-70">{trailing}</span> : null}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * A footer alert that expands in place to explain itself and offer a fix.
 *
 * `group` sits on the disclosure root, which is where `data-state` lands — that
 * is what lets the caret know it is open without any of its own state.
 */
export function SidebarAlert({
  tone,
  icon,
  label,
  open,
  onOpenChange,
  children,
}: {
  tone: SidebarAlertTone;
  icon: ReactNode;
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <SidebarMenuItem>
      <Disclosure
        open={open}
        onOpenChange={onOpenChange}
        className={cn('group w-full overflow-hidden rounded-md', open && 'bg-primary/[0.06]')}
      >
        <DisclosureTrigger>
          <SidebarMenuButton className={cn(ROW_CLASS, TONE_TEXT[tone])}>
            {icon}
            <span className="truncate">{label}</span>
            <CaretDownIcon className="ml-auto size-3.5 shrink-0 opacity-50 transition-transform duration-200 ease-out group-data-[state=open]:rotate-180" />
          </SidebarMenuButton>
        </DisclosureTrigger>
        <DisclosureContent>{children}</DisclosureContent>
      </Disclosure>
    </SidebarMenuItem>
  );
}

/**
 * The explanation. `px-2` matches the trigger's own gutter, so the sentence
 * starts on the same left edge as the label above it.
 */
export function SidebarAlertBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn('px-2 pt-0.5 pb-3', className)}>{children}</div>;
}

/** Body prose. One size, one colour, wherever an alert explains itself. */
export function SidebarAlertText({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground text-xs text-pretty">{children}</p>;
}

/**
 * The action tray. Separated by a hairline because these commit something —
 * the seam is the pause between "here is what happened" and "here is what you
 * can do about it".
 */
export function SidebarAlertActions({ children }: { children: ReactNode }) {
  return <div className="border-border/60 flex flex-col gap-1.5 border-t p-2">{children}</div>;
}
