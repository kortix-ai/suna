'use client';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Loading from '@/components/ui/loading';
import { CaretDownIcon, ChatCircleIcon, GearSixIcon, PlusIcon } from '@phosphor-icons/react';
import Link from 'next/link';

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
  if (!manual) {
    return (
      <Button
        variant="secondary"
        size={size}
        className="gap-1.5"
        disabled={pending}
        onClick={onChat}
      >
        {pending ? <Loading className="size-4 shrink-0" /> : <PlusIcon className="size-4" />}
        {label}
      </Button>
    );
  }
  const manualLabel = manual.label ?? 'Set up manually';
  const manualBody = (
    <>
      <GearSixIcon className="text-muted-foreground size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block">{manualLabel}</span>
        {manual.description ? (
          <span className="text-muted-foreground block text-xs">{manual.description}</span>
        ) : null}
      </span>
    </>
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size={size} className="gap-1.5" disabled={pending}>
          {pending ? <Loading className="size-4 shrink-0" /> : <PlusIcon className="size-4" />}
          {label}
          <CaretDownIcon className="text-muted-foreground size-3.5 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuItem className="items-start gap-2" onSelect={onChat}>
          <ChatCircleIcon className="text-muted-foreground size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block">Create in chat</span>
            <span className="text-muted-foreground block text-xs">
              An agent scaffolds it and opens a change request.
            </span>
          </span>
        </DropdownMenuItem>
        {manual.href ? (
          <DropdownMenuItem asChild className="items-start gap-2">
            <Link href={manual.href} prefetch>
              {manualBody}
            </Link>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem className="items-start gap-2" onSelect={manual.onSelect}>
            {manualBody}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
