import { CtaBand, FeatureRows } from '@/components/marketing/bands';
import { PRODUCTS, productBySlug } from '@/components/marketing/content';
import { Mock } from '@/components/marketing/mocks';
import { ArrowLink, BrandFrame, Container, Lead, Section, SectionTitle } from '@/components/marketing/parts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

export const dynamicParams = false;
export const generateStaticParams = () => PRODUCTS.map((p) => ({ slug: p.slug }));

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const p = productBySlug((await params).slug);
  return p ? { title: p.name, description: p.lead } : {};
}

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const p = productBySlug((await params).slug);
  if (!p) notFound();
  const next = PRODUCTS[(PRODUCTS.indexOf(p) + 1) % PRODUCTS.length];
  return (
    <>
      <Section rule={false} className="pt-12! pb-24! md:pt-20!">
        <Container className="grid items-center gap-12 lg:grid-cols-2 lg:gap-6">
          <div className="lg:pr-16">
            <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-[15px] font-medium">
              <Link href="/platform" className="hover:text-muted-foreground">
                Platform
              </Link>
              <span className="text-muted-foreground">/</span>
              <span>{p.name}</span>
            </nav>
            <h1 className="display-lg mt-8 text-balance">{p.title}</h1>
            <Lead className="mt-8 max-w-md">{p.lead}</Lead>
            <ArrowLink href="/demo" className="mt-10">
              Request demo
            </ArrowLink>
          </div>
          <BrandFrame className="grid aspect-square place-items-center p-6 md:p-16">
            <div className="w-full max-w-[460px]">
              <Mock name={p.heroMock} />
            </div>
          </BrandFrame>
        </Container>
      </Section>

      <Section>
        <Container>
          <SectionTitle>{p.sectionTitle}</SectionTitle>
          <div className="mt-20 md:mt-28">
            <FeatureRows features={p.features} />
          </div>
        </Container>
      </Section>

      <Section>
        <Container className="flex flex-col items-center text-center">
          <p className="text-[15px] text-muted-foreground">Next</p>
          <Link href={`/platform/${next.slug}`} className="display-md mt-3 transition-colors hover:text-muted-foreground">
            {next.name}
          </Link>
          <p className="mt-4 max-w-md text-[17px] text-muted-foreground">{next.summary}</p>
        </Container>
      </Section>

      <CtaBand />
    </>
  );
}
