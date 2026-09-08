import { Reveal } from '@/components/home/reveal';
import { Button } from '@/components/ui/marketing/button';
import { CapabilityHero } from '@/features/marketing/component/capability-hero';
import SectionHeader from '@/features/marketing/component/section-header';
import { useTranslations } from '@/i18n/use-translations';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { SolutionsHeroVisual } from './hero-visual';
import { ROLES } from './registry';
import { DefinitionRows, Eyebrow, Section, SectionDivider } from './shared';

/**
 * `/solutions` — the hub the eight role pages hang off.
 *
 * It exists so the section has a front door for search and a place every role
 * page can point back to. The nav menu links straight to the roles, so this
 * page is never the only way in.
 *
 * Accuracy gate: `./types.ts`. It governs this page too.
 */

export function SolutionsHubPage(): ReactNode {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <div className="bg-background relative">
      <CapabilityHero
        eyebrow="Solutions"
        title={tI18nComplete.raw('textbf05bba3082b')}
        sub={tI18nComplete.raw('text420962cdca94')}
        ctaPrimary={tI18nComplete.raw('text61e8d44ad423')}
        ctaPrimaryHref="/auth"
        ctaSecondary={tI18nComplete.raw('text1d1d94fb5397')}
        ctaSecondaryHref="/contact"
        visual={<SolutionsHeroVisual />}
      />

      {/* ── the eight roles ─────────────────────────────────────────────── */}
      <Section id="roles">
        <SectionHeader
          eyebrow={tI18nComplete.raw('textc78b5e29dfe3')}
          title={tI18nComplete.raw('texte1ecf8a598e7')}
          description={tI18nComplete.raw('text3ab40f6192f6')}
        />

        <Reveal delay={0.06}>
          <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {ROLES.map((role, i) => (
              <li key={role.slug}>
                <Link
                  href={`/solutions/${role.slug}`}
                  className="border-border bg-card hover:bg-accent/40 flex h-full flex-col rounded-sm border p-6 transition-colors"
                >
                  <Eyebrow>{String(i + 1).padStart(2, '0')}</Eyebrow>
                  <span className="text-foreground mt-3 text-lg leading-tight font-medium">
                    {role.name}
                  </span>
                  <span className="text-muted-foreground mt-2.5 text-sm leading-relaxed">
                    {role.navDescription}
                  </span>
                  <span className="text-muted-foreground mt-auto pt-6 font-mono text-[10px] tracking-widest uppercase">
                    {tI18nComplete.raw('texta5490cf22d33')}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Reveal>
      </Section>

      <SectionDivider />

      {/* ── what does not change between them ───────────────────────────── */}
      <Section id="constant">
        <SectionHeader
          eyebrow={tI18nComplete.raw('text0e613afafe9e')}
          title={tI18nComplete.raw('textdaa5af1847ed')}
          description={tI18nComplete.raw('text6a212e980319')}
        />

        <Reveal delay={0.06}>
          <div className="mt-10">
            <DefinitionRows
              rows={[
                {
                  k: tI18nComplete.raw('texte3d24b442025'),
                  v: tI18nComplete.raw('text184486387f75'),
                },
                {
                  k: tI18nComplete.raw('texta6d9e74b6d8a'),
                  v: tI18nComplete.raw('text46866b323e0b'),
                },
                {
                  k: tI18nComplete.raw('textb71608b2cdaf'),
                  v: tI18nComplete.raw('text8959f78a7385'),
                },
                {
                  k: tI18nComplete.raw('textd87cb0774bec'),
                  v: tI18nComplete.raw('textc2989475638c'),
                },
                {
                  k: tI18nComplete.raw('texta5d3555619a3'),
                  v: tI18nComplete.raw('text7d5f66c6d997'),
                },
              ]}
            />
          </div>
        </Reveal>

        <Reveal delay={0.1}>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button size="lg" variant="secondary" asChild>
              <Link href="/agent-computer">{tI18nComplete.raw('text495a8a5d24a9')}</Link>
            </Button>
            <Button size="lg" variant="secondary" asChild>
              <Link href="/connectors">{tI18nComplete.raw('textc3d2e79ebdd0')}</Link>
            </Button>
            <Button size="lg" variant="secondary" asChild>
              <Link href="/security">{tI18nComplete.raw('text8f6fb4eb7f42')}</Link>
            </Button>
          </div>
        </Reveal>
      </Section>
    </div>
  );
}
