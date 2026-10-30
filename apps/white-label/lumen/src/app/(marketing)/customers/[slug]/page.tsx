import { CtaBand } from '@/components/marketing/bands';
import { STORIES, storyBySlug } from '@/components/marketing/content';
import { Container, FirmLockup, Photo, Section } from '@/components/marketing/parts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

export const dynamicParams = false;
export const generateStaticParams = () => STORIES.map((s) => ({ slug: s.slug }));

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const s = storyBySlug((await params).slug);
  return s ? { title: s.title } : {};
}

export default async function StoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const s = storyBySlug((await params).slug);
  if (!s) notFound();
  return (
    <>
      <Section rule={false} className="pt-16! pb-12! md:pt-24!">
        <Container className="flex flex-col items-center text-center">
          <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-[15px] font-medium">
            <Link href="/customers" className="hover:text-muted-foreground">
              Customers
            </Link>
            <span className="text-muted-foreground">/</span>
            <span>{s.meta[1]?.value}</span>
          </nav>
          <h1 className="display-md mt-8 max-w-4xl text-balance">{s.title}</h1>
        </Container>
      </Section>
      <Container>
        <Photo tone={s.tone} className="grid aspect-[16/9] place-items-center md:aspect-[16/7]">
          <FirmLockup name={s.firm} style={s.style} className="relative scale-[1.6] text-white" />
        </Photo>
      </Container>
      <Section rule={false}>
        <Container className="flex flex-col items-center text-center">
          <blockquote className="display-xs max-w-4xl text-balance">“{s.quote}”</blockquote>
          <p className="mt-8 text-[15px] font-medium">{s.person}</p>
          <p className="text-[15px] text-muted-foreground">{s.role}</p>
        </Container>
      </Section>
      <Section>
        <Container className="grid gap-12 lg:grid-cols-12">
          <dl className="space-y-6 lg:col-span-3">
            {s.meta.map((m) => (
              <div key={m.label}>
                <dt className="text-[14px] text-muted-foreground">{m.label}</dt>
                <dd className="text-[15px]">{m.value}</dd>
              </div>
            ))}
            <p className="text-[13px] text-muted-foreground">An illustrative story. The firm and its people are fictional.</p>
          </dl>
          <article className="space-y-12 lg:col-span-7 lg:col-start-5">
            {s.body.map((b) => (
              <section key={b.heading}>
                <h2 className="text-[24px] font-[470] tracking-[-0.03em]">{b.heading}</h2>
                {b.paragraphs.map((p) => (
                  <p key={p.slice(0, 24)} className="mt-4 text-[17px] leading-[1.6] text-muted-foreground">
                    {p}
                  </p>
                ))}
              </section>
            ))}
          </article>
        </Container>
      </Section>
      <CtaBand />
    </>
  );
}
