'use client';

import { Reveal } from '@/components/home/reveal';
import { SkillsPage } from '@/components/home/interactive-demo/pages/skills-page';
import { KortixAsterisk } from '@/components/ui/kortix-asterisk';
import { SKILLIFY } from './narrative';

function SkillsFrame() {
  return (
    <div className="bg-border dark:bg-background rounded-xl p-1 shadow-sm">
      <div className="bg-background dark:bg-primary/7 flex items-center gap-2 rounded-t-lg px-3.5 py-2.5">
        <span className="flex gap-1.5">
          <span className="bg-muted-foreground/25 size-2.5 rounded-full" />
          <span className="bg-muted-foreground/25 size-2.5 rounded-full" />
          <span className="bg-muted-foreground/25 size-2.5 rounded-full" />
        </span>
        <span className="text-muted-foreground ml-1.5 font-mono text-xs">kortix · skills</span>
      </div>
      <div className="bg-background dark:bg-primary/7 relative h-[440px] overflow-hidden rounded-b-lg p-5">
        <SkillsPage />
        <div className="from-background dark:from-primary/7 pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t to-transparent" />
      </div>
    </div>
  );
}

export function Skillify() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-16 sm:py-24 lg:px-0">
      <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-2 lg:gap-16">
        <Reveal>
          <p className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
            {SKILLIFY.eyebrow}
          </p>
          <h2 className="text-foreground mt-3 text-3xl font-medium tracking-tight sm:text-4xl">
            {SKILLIFY.title[0]}
            <br />
            <span className="text-muted-foreground">{SKILLIFY.title[1]}</span>
          </h2>
          <p className="text-muted-foreground mt-4 max-w-md text-base leading-relaxed">
            {SKILLIFY.description}
          </p>
          <ul className="mt-6 max-w-md space-y-2.5">
            {SKILLIFY.bullets.map((b) => (
              <li key={b} className="text-muted-foreground flex gap-2.5 text-[15px] leading-relaxed">
                <KortixAsterisk index={1} />
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </Reveal>

        <Reveal delay={0.1}>
          <SkillsFrame />
        </Reveal>
      </div>
    </section>
  );
}
