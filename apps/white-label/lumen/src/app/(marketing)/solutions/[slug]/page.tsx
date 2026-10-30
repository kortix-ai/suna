import { CtaBand, Results, StoryCards } from '@/components/marketing/bands';
import { SOLUTIONS, solutionBySlug } from '@/components/marketing/content';
import { Mock } from '@/components/marketing/mocks';
import { ArrowLink, Container, Diamond, MediaCard, Photo, PillLink, Section } from '@/components/marketing/parts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

export const dynamicParams = false;
export const generateStaticParams = () => SOLUTIONS.map((s) => ({ slug: s.slug }));

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const s = solutionBySlug((await params).slug);
  return s ? { title: s.name, description: s.lead } : {};
}

const TONE = { 'law-firms': 'stone', 'in-house': 'moss', litigation: 'ember', transactions: 'night' } as const;

export default async function SolutionPage({ params }: { params: Promise<{ slug: string }> }) {
  const s = solutionBySlug((await params).slug);
  if (!s) notFound();
  return (
    <>
      {/* A cinematic hero: an abstract interior, the headline set on it. */}
      <Container className="pt-6">
        <Photo tone={TONE[s.slug]} className="flex min-h-[560px] flex-col justify-end p-6 text-white md:min-h-[720px] md:p-14">
          <div className="relative grid gap-8 lg:grid-cols-12">
            <div className="lg:col-span-7">
              <p className="eyebrow text-white/70">{s.eyebrow}</p>
              <h1 className="display-lg mt-6 text-balance">{s.title}</h1>
            </div>
            <div className="flex flex-col justify-end gap-8 lg:col-span-4 lg:col-start-9">
              <p className="text-[18px] leading-[1.4] text-white/75">{s.lead}</p>
              <div className="flex flex-wrap gap-3">
                <PillLink href="/demo" variant="light" arrow>
                  Request demo
                </PillLink>
              </div>
            </div>
          </div>
        </Photo>
      </Container>

      {/* Editorial rows: a label column, then the content from column 5. */}
      <Section rule={false}>
        <Container className="space-y-24 md:space-y-32">
          {s.rows.map((r) => (
            <div key={r.label} className="grid gap-8 lg:grid-cols-12">
              <p className="eyebrow text-muted-foreground lg:col-span-3">{r.label}</p>
              <div className="lg:col-span-4">
                <h2 className="display-xs">{r.title}</h2>
                <p className="mt-4 text-[17px] leading-[1.45] text-muted-foreground">{r.body}</p>
              </div>
              <div className="lg:col-span-5">
                <MediaCard>
                  <Mock name={r.mock} />
                </MediaCard>
              </div>
            </div>
          ))}
        </Container>
      </Section>

      <Section>
        <Container className="grid gap-12 lg:grid-cols-12">
          <div className="lg:col-span-3">
            <p className="eyebrow text-muted-foreground">Workflows</p>
          </div>
          <div className="lg:col-span-9">
            <h2 className="display-sm max-w-2xl">Ready on day one, yours to change</h2>
            <ul className="mt-12 border-t border-hairline">
              {s.workflows.map((w) => (
                <li key={w} className="flex items-center gap-4 border-b border-hairline py-5 text-[20px] tracking-[-0.02em]">
                  <Diamond className="text-lamp" />
                  {w}
                </li>
              ))}
            </ul>
            <ArrowLink href="/platform/workflows" tone="muted" className="mt-10">
              How workflows work
            </ArrowLink>
          </div>
        </Container>
      </Section>

      <Results />

      <Section>
        <Container>
          <h2 className="display-sm">Stories from the practice</h2>
          <StoryCards limit={2} className="mt-14" />
        </Container>
      </Section>

      <CtaBand />
    </>
  );
}
