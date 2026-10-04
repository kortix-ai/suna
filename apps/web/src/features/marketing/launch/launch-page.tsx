'use client';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { CodePanel } from '@/features/marketing/company-as-code/code-panel';
import { CapabilityHero } from '@/features/marketing/component/capability-hero';
import SectionHeader from '@/features/marketing/component/section-header';
import { TerminalBlock } from '@/features/marketing/download/terminal-block';
import { FilmPlayer } from '@/app/[locale]/presentations/film/engine/film';
import { FPS } from '@/app/[locale]/presentations/film/engine/time';
import { launchFilm } from '@/app/[locale]/presentations/film/films/launch';
import { cn } from '@/lib/utils';
import { ArrowUpRightIcon } from '@phosphor-icons/react';
import { useCallback, useRef, useState } from 'react';
import { hero, kit, pillars, start } from './content';

const chapters = launchFilm.chapters ?? [];
const stamp = (frame: number) => {
  const s = Math.round(frame / FPS);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** The film, with a chapter strip that follows playback and seeks on click. */
function FilmHero() {
  const [frame, setFrame] = useState(0);
  const player = useRef<{ seek: (frame: number) => void }>(null);
  const onFrame = useCallback((f: number) => setFrame(f), []);
  const active = chapters.findLastIndex((c) => frame >= c.frame);

  return (
    <div className="w-full">
      <div className="border-border bg-background aspect-video overflow-hidden rounded-xl border">
        <FilmPlayer ref={player} film={launchFilm} autoPlay loop onFrame={onFrame} />
      </div>
      <ol className="mt-4 flex gap-1 overflow-x-auto pb-2">
        {chapters.map((c, i) => (
          <li key={c.frame} className="shrink-0">
            <button
              type="button"
              onClick={() => player.current?.seek(c.frame)}
              className={cn(
                'hover:bg-hover flex items-center gap-2 rounded-full px-3 py-1.5 text-sm transition-colors duration-fast active:scale-[0.96]',
                i === active ? 'bg-muted text-foreground' : 'text-muted-foreground',
              )}
            >
              <span className="font-mono text-xs tabular-nums">{stamp(c.frame)}</span>
              {c.label}
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * `/launch` — the launch page, and the marketing design reference. The film in
 * the hero is the route at /presentations/film/launch, playing live; the page
 * around it is drawn from the same marketing components as the home page.
 */
export function LaunchPage() {
  return (
    <div className="bg-background relative">
      <CapabilityHero
        eyebrow="Kortix"
        title={hero.title}
        sub={hero.sub}
        ctaPrimary={hero.ctaPrimary}
        ctaPrimaryHref={hero.ctaPrimaryHref}
        ctaSecondary={hero.ctaSecondary}
        ctaSecondaryHref={hero.ctaSecondaryHref}
        visual={<FilmHero />}
      />

      <section id="pillars" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
        <SectionHeader eyebrow={pillars.eyebrow} title={pillars.title} description={pillars.sub} />
        <ul className="border-border mt-10 grid overflow-hidden rounded-xl border sm:grid-cols-2">
          {pillars.items.map((item, i) => (
            <li
              key={item.id}
              className={cn(
                'border-border bg-card flex flex-col gap-3 p-6 sm:p-8',
                i > 0 && 'border-t',
                i % 2 === 1 && 'sm:border-l',
                i === 1 && 'sm:border-t-0',
              )}
            >
              <h3 className="text-foreground text-lg font-medium">{item.title}</h3>
              <p className="text-muted-foreground flex-1 text-sm leading-relaxed">{item.body}</p>
              <HoverPrefetchLink
                href={item.href}
                className="text-foreground flex items-center gap-1 text-sm font-medium hover:underline"
              >
                {item.link}
                <ArrowUpRightIcon className="size-3.5" />
              </HoverPrefetchLink>
            </li>
          ))}
        </ul>
      </section>

      <section id="start" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
        <SectionHeader eyebrow={start.eyebrow} title={start.title} description={start.sub} />
        <div className="mt-10 grid gap-4 lg:grid-cols-12">
          <div className="min-w-0 lg:col-span-7">
            <TerminalBlock />
          </div>
          <div className="min-w-0 lg:col-span-5">
            <CodePanel title={start.shell.title} lines={start.shell.lines} lang="sh" />
          </div>
        </div>
      </section>

      <section id="design" className="mx-auto max-w-7xl px-6 py-24 md:py-30">
        <SectionHeader eyebrow={kit.eyebrow} title={kit.title} description={kit.sub} />
        <HoverPrefetchLink
          href={kit.filmHref}
          className="text-foreground mt-4 inline-flex items-center gap-1 text-sm font-medium hover:underline"
        >
          {kit.filmLink}
          <ArrowUpRightIcon className="size-3.5" />
        </HoverPrefetchLink>

        <div className="border-border mt-10 grid overflow-hidden rounded-xl border lg:grid-cols-3">
          <div className="bg-card space-y-4 p-6 sm:p-8">
            <h3 className="text-foreground text-sm font-medium">Color</h3>
            <ul className="space-y-2">
              {kit.colors.map((c) => (
                <li key={c.token} className="flex items-center gap-3">
                  {/* `dark` scopes the swatch to the film's stage palette in either theme. */}
                  <span className={cn('dark border-border size-8 shrink-0 rounded-md border', c.token)} />
                  <span className="text-foreground text-sm">{c.label}</span>
                  <span className="text-muted-foreground ml-auto font-mono text-xs">{c.token}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="border-border bg-card space-y-6 border-t p-6 sm:p-8 lg:border-t-0 lg:border-l">
            <h3 className="text-foreground text-sm font-medium">Type</h3>
            {kit.type.map((t) => (
              <div key={t.spec} className="space-y-2">
                <p className={cn('text-foreground text-2xl font-normal tracking-tight', 'mono' in t && 'font-mono')}>
                  {t.sample}
                </p>
                <p className="text-muted-foreground text-xs">{t.spec}</p>
              </div>
            ))}
          </div>
          <div className="border-border bg-card space-y-4 border-t p-6 sm:p-8 lg:border-t-0 lg:border-l">
            <h3 className="text-foreground text-sm font-medium">Motion</h3>
            <ul className="space-y-2.5">
              {kit.motion.map((rule) => (
                <li key={rule} className="text-muted-foreground text-sm leading-relaxed">
                  {rule}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

    </div>
  );
}
