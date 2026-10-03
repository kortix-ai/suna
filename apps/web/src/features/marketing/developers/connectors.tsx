import { cn } from '@/lib/utils';
import { LaptopIcon } from '@phosphor-icons/react/ssr';
import type { CSSProperties } from 'react';
import { localizedDevelopersCopy } from './content';
import { useTranslations } from '@/i18n/use-translations';
import { HalftoneMask, TwoToneHeading } from './shared';

const fav = (domain: string) => `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;

/** Chip positions as % of the art panel (Paper 700x620). */
const CHIP_POS: CSSProperties[] = [
  { left: '6.3%', top: '15.5%' },
  { right: '12.3%', top: '19.4%' },
  { right: '6.6%', top: '64.5%' },
  { left: '10%', top: '71%' },
  { left: '42.9%', top: '87%' },
];

const chipClass =
  'animate-chip-drift motion-reduce:animate-none absolute flex items-center gap-2 rounded-md px-3 py-2 text-xs sm:text-sm';

export function DevelopersConnectors() {
  const { connectors } = localizedDevelopersCopy(useTranslations('hardcodedUi.i18nComplete'));
  return (
    <section id="connectors" className="relative w-full">
      <div className="relative mx-auto grid max-w-7xl items-center gap-12 px-6 py-24 md:py-30 lg:grid-cols-2 lg:items-stretch lg:gap-16">
        <div className="bg-muted relative aspect-[700/620] w-full overflow-hidden rounded-2xl">
          <HalftoneMask
            src="/marketing/developers/halftone-globe.png"
            className="bg-kortix-base absolute top-[11.3%] left-[15.7%] aspect-square w-[68.6%]"
          />
          {/* Same chip as the "Your computer" card in features/tunnel/computer-connect.tsx. */}
          <span className="bg-foreground text-background absolute top-[46%] left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full px-4 py-2 text-sm font-medium whitespace-nowrap">
            <LaptopIcon className="size-4 shrink-0" />
            {connectors.hubLabel}
          </span>
          {connectors.apps.map((app, i) => (
            <div
              key={app.name}
              style={{ ...CHIP_POS[i], animationDelay: `${i * -1.2}s` }}
              className={cn(chipClass, 'bg-card text-foreground border-border border shadow-sm')}
            >
              <img src={fav(app.domain)} alt="" width={16} height={16} />
              {app.name}
            </div>
          ))}
          <div
            style={{ left: '47%', top: '6.5%', animationDelay: '-0.6s' }}
            className={cn(chipClass, 'bg-card text-foreground border-border border shadow-sm')}
          >
            {connectors.mcpChip}
          </div>
        </div>

        <div className="flex flex-col justify-between gap-10">
          <div>
            <TwoToneHeading lines={connectors.headline} />
            <p className="text-muted-foreground mt-6 text-lg text-pretty">
              {connectors.description}
            </p>
          </div>
          <ul>
            {connectors.facts.map(([text, code]) => (
              <li
                key={text}
                className="border-border flex items-center justify-between gap-4 border-b py-4 first:border-t"
              >
                <span className="text-foreground text-sm md:text-base">{text}</span>
                <code className="text-muted-foreground font-mono text-xs">{code}</code>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
