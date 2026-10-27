import { Band, Heading } from '@/features/marketing/kit/page-frame';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { BriefcaseIcon, CellTowerIcon, ChartLineUpIcon, CheckIcon } from '@phosphor-icons/react/dist/ssr';
import Image from 'next/image';

import { caseStudies, type CaseStudy } from './content';

const ICONS = { telecom: CellTowerIcon, search: BriefcaseIcon, finance: ChartLineUpIcon } as const;

const PLATINUM_TRACKING = 'tracking-[0.22em]'; // audit:allow Platinum's own wordmark tracking (pt-logo.tsx), a third-party mark

/** Platinum's mark as platinum.dev draws it (`pt-logo.tsx`): a square and PLATINUM in mono, both currentColor. */
function PlatinumMark() {
  return (
    <span className="text-foreground inline-flex items-center gap-4" role="img" aria-label="Platinum">
      <span aria-hidden className="block size-5 bg-current" />
      <span aria-hidden className={`font-mono text-xl ${PLATINUM_TRACKING}`}>
        PLATINUM
      </span>
    </span>
  );
}

/** A third-party logo is drawn for a white ground: white in both themes (color.md, logo tile rule). */
const LOGO_TILE_BACKGROUND = 'bg-white';

/** The card's top: the logo on its white tile, or the glyph on the muted ground. */
function Mark({ item }: { item: CaseStudy }) {
  if (item.logo) {
    return (
      <div className={`${LOGO_TILE_BACKGROUND} flex h-40 items-center justify-center rounded-md border`}>
        <Image
          src={item.logo.src}
          alt={item.logo.alt}
          width={item.logo.width}
          height={item.logo.height}
          unoptimized
          // A wordmark (wider than 2.5:1) sits lower so it matches a stacked mark's weight.
          className={item.logo.width / item.logo.height > 2.5 ? 'h-12 w-auto' : 'h-24 w-auto'}
        />
      </div>
    );
  }
  const Icon = ICONS[item.icon ?? 'search'];
  return (
    <div className="bg-muted flex h-40 items-center justify-center rounded-md">
      {item.mark === 'kortix' ? (
        <KortixLogo size={28} variant="logomark" />
      ) : item.mark === 'platinum' ? (
        <PlatinumMark />
      ) : (
        <Icon className="text-foreground size-12" aria-hidden />
      )}
    </div>
  );
}

/**
 * Case studies as eight equal cards, two per row. Nothing here links
 * anywhere, on purpose. Copy and the naming rules: `./content.ts`.
 */
export function CaseStudies({ id = 'case-studies' }: { id?: string }) {
  return (
    <section id={id} className="scroll-mt-16 py-20 lg:py-28">
      <Heading title={caseStudies.title} titleMuted={caseStudies.titleMuted} />
      <Band className="mt-12">
        <ul className="bg-border grid grid-cols-1 gap-px lg:grid-cols-2">
          {caseStudies.items.map((item) => (
            <li key={item.id} className="bg-background flex flex-col gap-5 p-6 lg:p-11">
              <Mark item={item} />
              <div className="flex flex-col gap-1">
                <p className="text-muted-foreground text-sm">{item.category}</p>
                <p className="text-foreground text-sm font-medium">{item.org}</p>
              </div>
              <h3 className="text-foreground text-xl font-medium tracking-tight text-balance">{item.title}</h3>
              <p className="text-muted-foreground text-base text-pretty">{item.body}</p>
              <ul className="mt-auto grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                {item.facts.map((fact) => (
                  <li key={fact} className="text-foreground flex items-start gap-2">
                    <CheckIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
                    {fact}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </Band>
    </section>
  );
}
