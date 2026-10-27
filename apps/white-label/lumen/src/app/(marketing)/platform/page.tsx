import { CtaBand, Quote, SecurityBand } from '@/components/marketing/bands';
import { PRODUCTS, STORIES } from '@/components/marketing/content';
import { AppWindow, Mock } from '@/components/marketing/mocks';
import { ArrowLink, BrandFrame, Container, Eyebrow, Lead, MediaCard, Section, SectionTitle } from '@/components/marketing/parts';
import { cn } from '@kortix/ui';
import { CubeIcon, QuotesIcon, ShieldCheckIcon } from '@phosphor-icons/react/dist/ssr';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Platform', description: 'One workspace for legal review, research and drafting, with every answer cited.' };

const SOURCES = ['PDF', 'Word', 'Text', 'Data rooms', 'Playbooks', 'Templates', 'Precedents', 'Prior versions'];

const PRINCIPLES = [
  { icon: QuotesIcon, title: 'Sourced', body: 'Every claim carries the paragraph it came from, checked before it is shown.' },
  { icon: CubeIcon, title: 'Capable', body: 'Each task runs in its own isolated workspace with real tools, not just a chat window.' },
  { icon: ShieldCheckIcon, title: 'Governed', body: 'Roles, restricted matters and an audit log the firm controls from day one.' },
];

export default function PlatformPage() {
  const quote = STORIES[1];
  return (
    <>
      <Section rule={false} className="pt-20! pb-0! md:pt-28!">
        <Container className="flex flex-col items-center text-center">
          <Eyebrow>Platform overview</Eyebrow>
          <h1 className="display-lg mt-6 max-w-5xl text-balance">One workspace for the whole matter</h1>
          <Lead className="mt-8 max-w-xl">
            A legal AI workspace that reads the whole matter, answers with its sources and keeps the firm in control of every run.
          </Lead>
          <ArrowLink href="/demo" className="mt-10">
            Request demo
          </ArrowLink>
        </Container>
        <Container className="mt-16 md:mt-24">
          <BrandFrame className="px-3 pt-8 md:px-24 md:pt-20">
            <AppWindow className="-mb-2" />
          </BrandFrame>
        </Container>
      </Section>

      <Section className="mt-24 md:mt-36">
        <Container className="space-y-24 md:space-y-32">
          {PRODUCTS.map((p, i) => (
            <div key={p.slug} className="grid grid-cols-1 items-center gap-10 md:grid-cols-2 md:gap-6">
              <div className={cn('min-w-0', i % 2 === 0 && 'md:order-2')}>
                <MediaCard>
                  <Mock name={p.heroMock} />
                </MediaCard>
              </div>
              <div className="flex flex-col items-center px-4 text-center md:px-16">
                <h2 className="display-sm">{p.name}</h2>
                <p className="mt-5 max-w-sm text-[17px] leading-[1.45] text-muted-foreground">{p.summary}</p>
                <ArrowLink href={`/platform/${p.slug}`} tone="muted" className="mt-8">
                  Learn more
                </ArrowLink>
              </div>
            </div>
          ))}
        </Container>
      </Section>

      <Quote quote={quote.quote} person={quote.person} role={quote.role} />

      <Section>
        <Container>
          <SectionTitle>Everything the matter is made of</SectionTitle>
          <div className="relative mx-auto mt-16 grid aspect-square max-w-[560px] place-items-center">
            <div className="absolute inset-[12%] rounded-full border border-hairline" />
            <div className="absolute inset-[28%] rounded-full border border-dashed border-hairline" />
            {SOURCES.map((s, i) => {
              const a = (i / SOURCES.length) * Math.PI * 2 - Math.PI / 2;
              return (
                <span
                  key={s}
                  className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-border bg-card px-3 py-1.5 text-[13px] whitespace-nowrap shadow-sm"
                  style={{ left: `${50 + Math.cos(a) * 38}%`, top: `${50 + Math.sin(a) * 38}%` }}
                >
                  {s}
                </span>
              );
            })}
            <p className="display-xs max-w-[13rem] text-center">Your matters, one workspace</p>
          </div>
          <p className="mx-auto mt-10 max-w-md text-center text-[15px] text-muted-foreground">
            Lumen reads PDF, Word and text files page by page. Playbooks and templates live in the firm Library.
          </p>
        </Container>
      </Section>

      <Section>
        <Container>
          <div className="grid gap-12 md:grid-cols-3">
            {PRINCIPLES.map((p) => (
              <div key={p.title} className="border-t border-hairline pt-6">
                <p.icon className="size-5" />
                <h3 className="mt-6 text-[24px] font-[470] tracking-[-0.03em]">{p.title}</h3>
                <p className="mt-2 text-[16px] leading-[1.45] text-muted-foreground">{p.body}</p>
              </div>
            ))}
          </div>
        </Container>
      </Section>

      <SecurityBand />
      <CtaBand title="Accelerate your practice with Lumen" />
    </>
  );
}
