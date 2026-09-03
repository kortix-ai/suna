'use client';

import {
  DOC_BODY,
  DOC_GRID,
  DocRail,
  docRailItem,
  useActiveSection,
} from '@/features/marketing/doc-rail';
import { cn } from '@/lib/utils';
import { ArrowLeftIcon, ArrowRightIcon, ArrowUpRightIcon, type Icon } from '@phosphor-icons/react';
import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * The shared shell for the support document family — the hub at `/support` and
 * every article under it.
 *
 * WHY IT EXISTS. Support used to be two pages in two different dialects: a
 * marketing doc page at `/support` (fixed navbar, `max-w-6xl`, sticky rail) and
 * a help centre at `/help` wearing the *app* sidebar — `SidebarProvider`, a ⌘K
 * command modal, a version number in a footer — for a grand total of one
 * article. Two shells, two nav entries, one job. The app shell lost; a page you
 * read is not a workspace you operate. Everything support-shaped now composes
 * from this file, so the hub and its articles cannot drift apart the way those
 * two did.
 *
 * Geometry is deliberately identical to `/legal` and `/changelog`: same
 * container, same header rhythm, same rail. A reader moving between them should
 * not notice a seam.
 */

/** Container shared by the header and the document grid, so nothing drifts. */
export const SUPPORT_CONTAINER = 'mx-auto max-w-6xl px-6';

/** Body prose scale. Matches `/legal` — `@tailwindcss/typography` is not installed. */
export const PROSE = 'text-muted-foreground text-[15px] leading-7 text-pretty';

export const LINK =
  'text-foreground decoration-foreground/25 hover:decoration-foreground/60 wrap-break-word underline underline-offset-4 transition-colors';

/**
 * One radius for the whole family.
 *
 * `rounded-lg`, not the app law's `rounded-md`: the FAQ accordion rows on the
 * hub come from the marketing `FaqSection` styling and are already `rounded-lg`.
 * Mixing both radii on one page reads worse than picking the one already there.
 */
const CARD_RADIUS = 'rounded-lg';

/**
 * The affordance arrow on a card.
 *
 * Direction carries meaning and is not decoration: ↗ means "this leaves the
 * page", → means "this is another page here". Getting that backwards is a small
 * lie the reader only catches after the tab has already opened.
 *
 * Derived from the href rather than passed in, so it cannot fall out of sync
 * with where the card actually goes. A `mailto:` counts as leaving even though
 * it opens no tab — it hands you to another application, which is the thing the
 * arrow is warning about.
 */
function CardArrow({ href }: { href: string }) {
  const leavesPage = /^(mailto:|https?:)/.test(href);
  const Glyph = leavesPage ? ArrowUpRightIcon : ArrowRightIcon;
  return (
    <Glyph
      aria-hidden
      className={cn(
        'text-muted-foreground/40 size-3.5 shrink-0 transition-all',
        'group-hover:text-muted-foreground',
        leavesPage
          ? 'group-hover:-translate-y-0.5 group-hover:translate-x-0.5'
          : 'group-hover:translate-x-0.5',
      )}
    />
  );
}

/** A titled block. `scroll-mt-28` clears the fixed navbar on anchor jumps. */
export function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-28">
      <h2 className="text-foreground text-lg font-medium tracking-tight text-balance">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function P({ children }: { children: ReactNode }) {
  return <p className={PROSE}>{children}</p>;
}

/**
 * Page header. `pt-28 sm:pt-36` reserves space for the fixed navbar in
 * `(public)/(marketing)/layout.tsx`, which is `position: fixed` and so does not
 * push the page down itself.
 *
 * `backTo` renders the article → hub return path. It is a real link rather than
 * a history-based "back" so it behaves the same arriving from search, from a
 * support reply, or from the hub itself.
 */
export function SupportHeader({
  title,
  lead,
  backTo,
  children,
}: {
  title: string;
  lead?: ReactNode;
  backTo?: { href: string; label: string };
  children?: ReactNode;
}) {
  return (
    <header className={cn('pt-28 sm:pt-36', children ? 'pb-10 sm:pb-14' : 'pb-12 sm:pb-16')}>
      {backTo ? (
        <Link
          href={backTo.href}
          className="text-muted-foreground hover:text-foreground group mb-6 inline-flex items-center gap-1.5 text-sm transition-colors"
        >
          <ArrowLeftIcon className="size-3.5 shrink-0 transition-transform group-hover:-translate-x-0.5" />
          {backTo.label}
        </Link>
      ) : null}
      <h1 className="text-3xl font-medium text-balance md:text-4xl lg:tracking-tight">{title}</h1>
      {lead ? (
        <p className="text-muted-foreground mt-5 max-w-xl text-base leading-relaxed text-pretty">
          {lead}
        </p>
      ) : null}
      {children}
    </header>
  );
}

/**
 * Rail + body pair with the scroll-spy wired up.
 *
 * The rail is anchor links into the page (the hub and the articles are both one
 * scrolling document), which is the `/support` behaviour — `/legal` uses the
 * same geometry to switch whole documents instead.
 */
export function SupportDocGrid({
  sections,
  children,
}: {
  sections: readonly { id: string; label: string }[];
  children: ReactNode;
}) {
  const ids = sections.map((section) => section.id);
  const active = useActiveSection(ids);

  return (
    <div className={DOC_GRID}>
      <DocRail label="On this page">
        {sections.map((section) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            aria-current={active === section.id ? 'true' : undefined}
            className={docRailItem(active === section.id)}
          >
            {section.label}
          </a>
        ))}
      </DocRail>

      <div className={cn(DOC_BODY, 'space-y-12')}>{children}</div>
    </div>
  );
}

/**
 * A way to reach a human, as a card rather than a mailto buried in a sentence.
 *
 * The old page's entire contact affordance was one underlined `support@` inside
 * a paragraph of prose. Someone arriving in a bad mood — billed twice, locked
 * out — had to read a paragraph to find the door. These are the doors, above
 * the fold, with the response expectation stated on the email one so nobody has
 * to guess whether anybody is listening.
 */
export function ChannelCard({
  icon: Icon,
  title,
  detail,
  note,
  href,
  external,
}: {
  icon: Icon;
  title: string;
  detail: string;
  note: string;
  href: string;
  external?: boolean;
}) {
  return (
    <Link
      href={href}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      className={cn(
        'group bg-popover relative flex flex-col gap-3 border p-4',
        CARD_RADIUS,
        'hover:border-foreground/20 hover:shadow-sm transition-[color,box-shadow,border-color]',
        'focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2',
        'focus-visible:ring-offset-background focus-visible:outline-none',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-sm">
          <Icon className="text-muted-foreground size-4.5" />
        </span>
        <CardArrow href={href} />
      </div>
      <div className="min-w-0 space-y-1">
        <div className="text-foreground text-sm font-medium tracking-tight">{title}</div>
        <div className="text-muted-foreground truncate text-[13px]">{detail}</div>
        <div className="text-muted-foreground/70 text-xs leading-5 text-pretty">{note}</div>
      </div>
    </Link>
  );
}

/**
 * A quiet aside for a fact that qualifies the section above it — the credit
 * priority rule, the irreversibility of a deletion.
 *
 * A left rule rather than a filled panel. `InfoBanner` is the app primitive for
 * this and it is tinted; on a calm marketing document a tinted band is the only
 * colour on the page and pulls the eye off the prose.
 */
export function Note({ children }: { children: ReactNode }) {
  return (
    <div className="border-border border-l-2 py-1 pl-4">
      <p className="text-muted-foreground/80 text-[13px] leading-6 text-pretty">{children}</p>
    </div>
  );
}
