import { CtaBand, Quote, StoryCards } from '@/components/marketing/bands';
import { FIRMS, STORIES } from '@/components/marketing/content';
import { Container, FirmLockup, Lead, Section } from '@/components/marketing/parts';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Customers', description: 'How firms and legal teams work with Lumen.' };

export default function CustomersPage() {
  const q = STORIES[2];
  return (
    <>
      <Section rule={false} className="pt-20! pb-16! md:pt-28!">
        <Container className="flex flex-col items-center text-center">
          <h1 className="display-lg">Customer stories</h1>
          <Lead className="mt-6 max-w-lg">How firms and in-house teams put Lumen to work on real matters.</Lead>
          <p className="mt-4 text-[13px] text-muted-foreground">Illustrative stories: the firms and people are fictional.</p>
        </Container>
      </Section>
      {/* A slow marquee of lockups. */}
      <div className="overflow-hidden border-y border-hairline py-8 [mask-image:linear-gradient(to_right,transparent,black_12%,black_88%,transparent)]">
        <div className="flex w-max animate-[lumen-marquee_60s_linear_infinite] gap-16 text-muted-foreground motion-reduce:animate-none">
          {[...FIRMS, ...FIRMS].map((f, i) => (
            <FirmLockup key={i} name={f.name} style={f.style} />
          ))}
        </div>
      </div>
      <Section rule={false}>
        <Container>
          <StoryCards />
        </Container>
      </Section>
      <Quote quote={q.quote} person={q.person} role={q.role} />
      <CtaBand />
    </>
  );
}
