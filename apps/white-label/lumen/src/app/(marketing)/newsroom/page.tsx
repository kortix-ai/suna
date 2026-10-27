import { NewsCards } from '@/components/marketing/bands';
import { NEWS } from '@/components/marketing/content';
import { ArrowLink, BrandFrame, Container, Lead, Section } from '@/components/marketing/parts';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Newsroom', description: 'Lumen announcements and product news.' };

export default function NewsroomPage() {
  const [lead, ...rest] = NEWS;
  return (
    <>
      <Section rule={false} className="pt-20! pb-16! md:pt-28!">
        <Container className="flex flex-col items-center text-center">
          <h1 className="display-xl text-[clamp(3.5rem,9vw,7.5rem)]!">Newsroom</h1>
          <Lead className="mt-6 max-w-md">Product releases and announcements from Lumen.</Lead>
        </Container>
      </Section>
      <Container>
        <div className="grid items-center gap-8 md:grid-cols-12">
          <BrandFrame className="grid aspect-[16/10] place-items-center md:col-span-7">
            <p className="display-sm max-w-md px-6 text-center text-white">{lead.title}</p>
          </BrandFrame>
          <div className="md:col-span-4 md:col-start-9">
            <p className="text-[14px] text-muted-foreground">
              {lead.tag} · {lead.date}
            </p>
            <h2 className="mt-3 text-[28px] leading-[1.15] font-[470] tracking-[-0.03em]">{lead.title}</h2>
            <ArrowLink href={`/blog/${lead.slug}`} tone="muted" className="mt-6">
              Read
            </ArrowLink>
          </div>
        </div>
      </Container>
      <Section>
        <Container>
          <NewsCards items={rest} />
        </Container>
      </Section>
    </>
  );
}
