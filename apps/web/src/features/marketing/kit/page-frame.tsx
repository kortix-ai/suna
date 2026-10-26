import type { ReactNode } from 'react';

/*
 * The landing page's frame for full marketing pages (/security, /self-hosted,
 * /enterprise): one 1440px column between two hairline rails; each section is
 * a two-tone title (font-medium, 20/24/30px) and one line of description,
 * then a bordered band whose top and bottom hairlines cross the page and fade
 * past the rails (`kx-rail-fade`). Cells inside a band are split by hairlines
 * (`gap-px` over `bg-border`). No eyebrows, no reveal motion.
 */

/** The page shell: the 1440 column and its two rails (62px in on desktop). */
export function PageFrame({ children }: { children: ReactNode }) {
  return (
    <main className="bg-background relative mx-auto w-full max-w-[1440px]">
      <div aria-hidden className="bg-border pointer-events-none absolute inset-y-0 left-4 z-10 w-px lg:left-17" />
      <div aria-hidden className="bg-border pointer-events-none absolute inset-y-0 right-4 z-10 w-px lg:right-17" />
      {children}
    </main>
  );
}

/** The landing hero's type and spacing: 44px two-tone title, description, actions. */
export function PageHero({
  title,
  titleMuted,
  sub,
  actions,
  aside,
}: {
  title: string;
  titleMuted?: string;
  sub: string;
  actions?: ReactNode;
  /** Art: right column from `lg`, centred; hidden below `lg`. */
  aside?: ReactNode;
}) {
  const copy = (
    <div className="flex min-w-0 flex-col gap-7.5">
      <div className="flex flex-col gap-4 lg:gap-5">
        <h1 className="max-w-261 text-3xl font-medium tracking-tight text-balance sm:text-4xl lg:text-[44px] lg:leading-13">
          <span className="text-foreground block">{title}</span>
          {titleMuted ? <span className="text-muted-foreground block">{titleMuted}</span> : null}
        </h1>
        <p className="text-muted-foreground max-w-2xl text-base text-pretty sm:text-lg md:text-xl">{sub}</p>
      </div>
      {actions ? <div className="flex flex-wrap gap-2.5 pt-2">{actions}</div> : null}
    </div>
  );
  if (!aside) return <div className="px-8 pt-32 pb-18 lg:px-28 lg:pt-40">{copy}</div>;
  // With art: the copy takes 3/5 from `lg` so a title line never wraps, the
  // art is centred in the remaining 2/5.
  // The padding is even around the content: the top carries the fixed 59px
  // navbar on top of the same space as the bottom. Below `lg` the art is not
  // shown: on a phone it only pushes the content down.
  return (
    <div className="grid grid-cols-1 items-center gap-12 px-8 pt-32 pb-16 lg:grid-cols-[3fr_2fr] lg:gap-16 lg:px-28 lg:pt-48 lg:pb-32">
      {copy}
      <div className="hidden items-center justify-center lg:flex">{aside}</div>
    </div>
  );
}

/** A section's two-tone title and one line of description. A muted line with
 *  no translation yet may be absent; `actions` sits under the description. */
export function Heading({
  title,
  titleMuted,
  sub,
  actions,
}: {
  title: string;
  titleMuted?: string;
  sub?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="px-8 lg:px-28">
      <h2 className="text-foreground text-xl font-medium tracking-tight text-balance md:text-2xl lg:text-3xl">
        {title}
        {titleMuted ? <span className="text-muted-foreground block"> {titleMuted}</span> : null}
      </h2>
      {sub ? <p className="text-muted-foreground mt-4 max-w-2xl text-base text-pretty">{sub}</p> : null}
      {actions ? <div className="flex flex-wrap gap-2.5 pt-6">{actions}</div> : null}
    </div>
  );
}

/** Short facts as cells: the term muted on top, the value under it. Sits in a Band. */
export function SpecGrid({ items, cols }: { items: readonly { k: string; v: string }[]; cols: string }) {
  return (
    <dl className={`bg-border grid grid-cols-1 gap-px sm:grid-cols-2 ${cols}`}>
      {items.map((item) => (
        <div key={item.k} className="bg-background flex flex-col gap-2 p-6 lg:p-8">
          <dt className="text-muted-foreground text-sm">{item.k}</dt>
          <dd className="text-foreground text-base font-medium text-pretty">{item.v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A band whose hairlines cross the page, its content between the rails. */
export function Band({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={`kx-rail-fade border-y px-4 lg:px-17 ${className ?? ''}`}>
      {children}
    </div>
  );
}

/** Cells split by hairlines: the band's grid over the border colour. */
export function CellGrid({
  items,
  cols,
}: {
  items: readonly { id: string; n?: string; k: string; v: string }[];
  cols: string;
}) {
  return (
    <ul className={`bg-border grid grid-cols-1 gap-px sm:grid-cols-2 ${cols}`}>
      {items.map((item) => (
        <li key={item.id} className="bg-background flex flex-col gap-3 p-6 lg:p-8">
          {item.n ? <span className="text-muted-foreground font-mono text-xs tabular-nums">{item.n}</span> : null}
          <h3 className="text-foreground text-base font-medium text-pretty">{item.k}</h3>
          <p className="text-muted-foreground text-sm text-pretty">{item.v}</p>
        </li>
      ))}
    </ul>
  );
}

/** Key / value rows on hairlines, aligned with the section copy. */
export function KeyRows({ rows }: { rows: readonly { id?: string; k: ReactNode; v: ReactNode }[] }) {
  return (
    <dl className="divide-y px-8 lg:px-28">
      {rows.map((row, i) => (
        <div key={row.id ?? i} className="grid grid-cols-1 gap-y-2 py-6 lg:grid-cols-3 lg:gap-x-8">
          <dt className="text-foreground text-base font-medium text-pretty">{row.k}</dt>
          <dd className="text-muted-foreground text-sm text-pretty lg:col-span-2">{row.v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Block({ id, children }: { id: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-16 py-20 lg:py-28">
      {children}
    </section>
  );
}

