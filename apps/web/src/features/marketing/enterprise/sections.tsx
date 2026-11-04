import { Band, Heading } from '@/features/marketing/kit/page-frame';
import { Seal } from '@/features/marketing/kit/seal';
import { CheckIcon } from '@phosphor-icons/react/dist/ssr';
import type { ComponentType, ReactNode } from 'react';

/*
 * The sections /enterprise and /compliance share, in the home page's shapes:
 * the page column between two rails, the pillars band, and the trust band.
 */

export type Glyph = ComponentType<{ className?: string }>;

type Pillar = { readonly id: string; readonly name: string; readonly line: string; readonly facts: readonly string[] };

/** The 1440px column between two hairline rails, as on the home page. */
export function PageColumn({ children }: { children: ReactNode }) {
  return (
    <main className="bg-background relative mx-auto w-full max-w-[1440px]">
      <div aria-hidden className="bg-border pointer-events-none absolute inset-y-0 left-4 z-10 w-px lg:left-17" />
      <div aria-hidden className="bg-border pointer-events-none absolute inset-y-0 right-4 z-10 w-px lg:right-17" />
      {children}
    </main>
  );
}

/** Four cells, one idea each. `footer` renders under a cell's facts, by cell id. */
export function Pillars({
  pillars,
  icons,
  footer,
}: {
  pillars: { readonly title: string; readonly titleMuted: string; readonly items: readonly Pillar[] };
  icons: Record<string, Glyph>;
  footer?: Record<string, ReactNode>;
}) {
  return (
    <section id="pillars" className="scroll-mt-16 py-14 lg:py-20">
      <Heading title={pillars.title} titleMuted={pillars.titleMuted} />
      <Band className="mt-12">
        <ul className="bg-border grid grid-cols-1 gap-px sm:grid-cols-2 xl:grid-cols-4">
          {pillars.items.map(({ id, name, line, facts }) => {
            const Icon = icons[id];
            return (
              <li key={id} className="bg-background flex flex-col gap-5 p-6 lg:p-10">
                <Icon className="text-foreground size-6" aria-hidden />
                <h3 className="text-foreground text-2xl font-medium tracking-tight text-balance">
                  {name}
                  <span className="text-muted-foreground mt-1 block text-lg leading-snug">{line}</span>
                </h3>
                <ul className="mt-auto flex flex-col gap-2 text-sm">
                  {facts.map((fact) => (
                    <li key={fact} className="text-foreground flex items-start gap-2">
                      <CheckIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
                      {fact}
                    </li>
                  ))}
                </ul>
                {footer?.[id]}
              </li>
            );
          })}
        </ul>
      </Band>
    </section>
  );
}

/** The home page's trust band: dark in both themes, four cells, then the SOC 2 row. */
export function TrustBand({
  trust,
  icons,
  actions,
}: {
  trust: {
    readonly title: string;
    readonly titleMuted: string;
    readonly cells: readonly { readonly k: string; readonly v: string }[];
    readonly seal: string;
    readonly sealNote: string;
  };
  icons: readonly Glyph[];
  actions: ReactNode;
}) {
  return (
    <section id="trust" className="scroll-mt-16 py-14 lg:py-20">
      <div className="kx-rail-fade border-y px-4 lg:px-17">
        <div className="dark bg-muted text-foreground px-6 py-10 lg:px-11 lg:py-16">
          <h2 className="text-xl font-medium tracking-tight text-balance md:text-2xl lg:text-3xl">
            {trust.title}
            <span className="text-muted-foreground block">{trust.titleMuted}</span>
          </h2>
          <ul className="bg-border mt-10 grid grid-cols-1 gap-px border sm:grid-cols-2 lg:mt-12 lg:grid-cols-4">
            {trust.cells.map(({ k, v }, i) => {
              const Icon = icons[i];
              return (
                <li key={k} className="bg-muted flex flex-col gap-3 p-5 lg:p-6">
                  <Icon className="size-7" aria-hidden />
                  <h3 className="mt-1 text-base font-medium">{k}</h3>
                  <p className="text-muted-foreground text-sm text-pretty">{v}</p>
                </li>
              );
            })}
            <li className="bg-muted flex flex-col items-start justify-between gap-6 p-5 sm:col-span-2 sm:flex-row sm:items-center lg:col-span-4 lg:p-6">
              <div className="flex items-center gap-5">
                <Seal
                  name="SOC 2"
                  detail="Type I"
                  note="Verified"
                  ornament="double"
                  className="text-foreground size-20 shrink-0"
                />
                <div>
                  <p className="text-base font-medium">{trust.seal}</p>
                  <p className="text-muted-foreground mt-1 text-sm">{trust.sealNote}</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2.5">{actions}</div>
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}
