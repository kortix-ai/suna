import { CtaBand } from '@/components/marketing/bands';
import { Container, Section } from '@/components/marketing/parts';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Company', description: 'Why Lumen exists.' };

const PRINCIPLES = [
  ['Show the source', 'A lawyer signs their name to the work. Every answer Lumen gives must be checkable in one click.'],
  ['Say what we know', 'Lumen marks what it could not confirm. A blank with a flag beats a confident guess.'],
  ['Fit the firm', 'Positions, templates and walls belong to the firm. Lumen applies them; it does not replace them.'],
  ['Measure it', 'Every release is scored against an evaluation set of fictional contracts with planted issues.'],
  ['Keep it calm', 'Legal work is serious. The product is quiet, legible and in the lawyer’s control.'],
  ['Own the outcome', 'If a run fails, Lumen says so, keeps the partial work and lets you try again.'],
];

export default function CompanyPage() {
  return (
    <>
      <Section rule={false} className="pt-20! md:pt-28!">
        <Container className="grid gap-12 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <p className="text-[15px] font-medium">Company</p>
            <h1 className="display-lg mt-6 text-balance">Making legal work faster, without making it less careful</h1>
          </div>
          <div className="space-y-6 text-[18px] leading-[1.5] text-muted-foreground lg:col-span-4 lg:col-start-9 lg:pt-24">
            <p>
              Lawyers spend a large share of their week finding things: the clause, the date, the party, the prior turn. Lumen does the finding, and
              shows its work, so the lawyer can spend the week on judgment.
            </p>
            <p>
              We build for the lawyer who checks the source. That is why every answer carries a citation, every citation is verified, and every run
              is recorded.
            </p>
          </div>
        </Container>
      </Section>
      <Section>
        <Container>
          <h2 className="display-sm">What we hold ourselves to</h2>
          <div className="mt-14 grid border-t border-l border-hairline sm:grid-cols-2 lg:grid-cols-3">
            {PRINCIPLES.map(([t, b]) => (
              <div key={t} className="border-r border-b border-hairline p-8">
                <h3 className="text-[22px] font-[470] tracking-[-0.03em]">{t}</h3>
                <p className="mt-3 text-[16px] leading-[1.5] text-muted-foreground">{b}</p>
              </div>
            ))}
          </div>
        </Container>
      </Section>
      <Section>
        <Container className="grid gap-12 md:grid-cols-3">
          {[
            ['London', 'Headquarters'],
            ['New York', 'Legal engineering'],
            ['Remote', 'Engineering and design'],
          ].map(([c, r]) => (
            <div key={c} className="border-t border-hairline pt-6">
              <p className="display-xs">{c}</p>
              <p className="mt-2 text-[15px] text-muted-foreground">{r}</p>
            </div>
          ))}
        </Container>
      </Section>
      <CtaBand title="Come build the tools lawyers can check" />
    </>
  );
}
