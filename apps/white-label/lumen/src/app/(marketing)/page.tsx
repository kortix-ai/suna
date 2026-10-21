import { CtaBand, LogoWall, NewsCards, Quote, Results, SecurityBand, StoryCards } from '@/components/marketing/bands';
import type { MockName } from '@/components/marketing/content';
import { STORIES } from '@/components/marketing/content';
import { AppWindow, Mock } from '@/components/marketing/mocks';
import { ArrowLink, BrandFrame, Container, PillLink, Section, SectionTitle } from '@/components/marketing/parts';
import { StickyList } from '@/components/marketing/sticky-list';
import { BRAND } from '@/config/brand';
import Link from 'next/link';

const FUTURE: { title: string; body: string; mock: MockName }[] = [
  { title: 'Review at the speed of reading', body: 'Run the diligence grid over a data room and come back to every cell filled and cited.', mock: 'review' },
  { title: 'Every answer, cited', body: 'Each claim links to the paragraph it came from. A quote Lumen cannot find is marked, never shown as fact.', mock: 'answer' },
  { title: 'The firm’s positions, applied', body: 'Playbooks, templates and workflows the firm writes once and every lawyer uses.', mock: 'playbook' },
  { title: 'Governed from day one', body: 'Roles, restricted matters and an audit log nobody can edit.', mock: 'audit' },
];

export default function MarketingHome() {
  const media = Object.fromEntries(FUTURE.map((f) => [f.mock, <Mock key={f.mock} name={f.mock} />]));
  const story = STORIES[0];
  return (
    <>
      {/* The hero sits under the transparent header. */}
      <section className="pattern-laid -mt-[72px] flex min-h-[640px] flex-col items-center justify-center px-6 pt-[72px] text-center text-white md:min-h-[860px]">
        <h1 className="display-xl">Built for law</h1>
        <p className="mt-8 max-w-xl text-[18px] leading-[1.35] tracking-[-0.015em] text-white/75 md:text-[20px]">{BRAND.subline}</p>
        <div className="mt-10 flex flex-wrap items-center justify-center gap-5">
          <PillLink href="/demo" variant="glass" arrow>
            Request demo
          </PillLink>
          <ArrowLink href="/sign-up" tone="light">
            Start free trial
          </ArrowLink>
        </div>
      </section>

      <LogoWall caption="Trusted by firms that check their sources" />

      <Section>
        <Container>
          <SectionTitle>The future of legal work</SectionTitle>
          <div className="mt-20">
            <StickyList items={FUTURE} media={media} />
          </div>
        </Container>
      </Section>

      <Section>
        <Container>
          <div className="flex flex-col items-center text-center">
            <p className="text-[15px] font-medium">The platform</p>
            <h2 className="display-md mt-5 max-w-3xl text-balance">One workspace for review, research and drafting</h2>
            <ArrowLink href="/platform" className="mt-8">
              See the platform
            </ArrowLink>
          </div>
          <BrandFrame className="mt-16 px-4 pt-10 md:px-24 md:pt-20">
            <AppWindow className="-mb-24 md:-mb-28" />
          </BrandFrame>
        </Container>
      </Section>

      <Quote quote={story.quote} person={story.person} role={story.role} />

      <Section>
        <Container>
          <div className="flex items-end justify-between gap-6">
            <h2 className="display-sm max-w-xl">How firms work with Lumen</h2>
            <ArrowLink href="/customers" tone="muted" className="hidden sm:inline-flex">
              All stories
            </ArrowLink>
          </div>
          <StoryCards limit={2} className="mt-14" />
        </Container>
      </Section>

      <Results />

      <SecurityBand />

      <Section rule={false}>
        <Container>
          <div className="flex items-end justify-between gap-6">
            <h2 className="display-sm">Newsroom</h2>
            <Link href="/newsroom" className="text-[15px] text-muted-foreground hover:text-foreground">
              All news
            </Link>
          </div>
          <div className="mt-14">
            <NewsCards />
          </div>
        </Container>
      </Section>

      <CtaBand />
    </>
  );
}
