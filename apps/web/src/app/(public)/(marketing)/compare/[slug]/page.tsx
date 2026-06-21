import { Reveal } from '@/components/home/reveal';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Button } from '@/components/ui/marketing/button';
import KortixGrid from '@/components/ui/marketing/gridder';
import {
  Stepper,
  StepperDescription,
  StepperIndicator,
  StepperItem,
  StepperSeparator,
  StepperTitle,
  StepperTrigger,
} from '@/components/ui/stepper';
import { CompareSwitcher } from '@/features/marketing/compare-switcher';
import { COMPETITORS, type RowLean } from '@/features/marketing/marketing-pages';
import { siteMetadata } from '@/lib/site-metadata';
import { cn } from '@/lib/utils';
import { Check, Minus } from 'lucide-react';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Fragment } from 'react';
import { HiArrowRight } from 'react-icons/hi2';

interface PageProps {
  params: Promise<{ slug: string }>;
}

export function generateStaticParams() {
  return COMPETITORS.map((c) => ({ slug: c.slug }));
}

export async function generateMetadata(props: PageProps): Promise<Metadata> {
  const { slug } = await props.params;
  const c = COMPETITORS.find((x) => x.slug === slug);
  if (!c) return {};

  const url = `${siteMetadata.url}/compare/${c.slug}`;
  const ogImage = `${siteMetadata.url}/banner.png`;

  return {
    title: c.seo.title,
    description: c.seo.description,
    keywords: c.seo.keywords,
    alternates: { canonical: url },
    openGraph: {
      type: 'website',
      title: c.seo.ogTitle,
      description: c.seo.ogDescription,
      url,
      siteName: 'Kortix',
      images: [{ url: ogImage, width: 1200, height: 630, alt: c.headline }],
    },
    twitter: {
      card: 'summary_large_image',
      title: c.seo.ogTitle,
      description: c.seo.ogDescription,
      images: [ogImage],
    },
  };
}

function LeanMark({ side, lean }: { side: 'them' | 'kortix'; lean: RowLean }) {
  const on = lean === side || lean === 'both';
  if (side === 'kortix') {
    return on ? (
      <Check className="text-kortix-green mt-0.5 size-4 shrink-0" strokeWidth={2.5} />
    ) : (
      <Minus className="text-background/40 mt-0.5 size-4 shrink-0" strokeWidth={2.5} />
    );
  }
  return on ? (
    <Check className="text-muted-foreground mt-0.5 size-4 shrink-0" strokeWidth={2.5} />
  ) : (
    <Minus className="text-muted-foreground/30 mt-0.5 size-4 shrink-0" strokeWidth={2.5} />
  );
}

export default async function ComparePage(props: PageProps) {
  const tI18nHardcoded = await getTranslations('hardcodedUi');
  const { slug } = await props.params;
  const c = COMPETITORS.find((x) => x.slug === slug);
  if (!c) notFound();

  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: c.faqs.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };

  return (
    <main className="bg-background relative pt-32">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }}
      />

      <section className="mx-auto max-w-6xl px-6 lg:px-0">
        <Reveal>
          <h1 className="text-foreground mt-5 flex max-w-4xl flex-wrap items-center gap-x-3 gap-y-2 text-4xl leading-tight font-medium tracking-tight text-balance md:text-5xl lg:text-6xl">
            <span>
              {tI18nHardcoded.raw('autoAppPublicMarketingCompareSlugPageJsxTextKortixVs7d03d509')}
            </span>
            <CompareSwitcher
              current={{ slug: c.slug, name: c.name }}
              options={COMPETITORS.map((x) => ({ slug: x.slug, name: x.name }))}
            />
          </h1>
          <p className="text-muted-foreground mt-6 max-w-2xl text-lg leading-relaxed text-pretty">
            {c.sub}
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button size="xl" asChild>
              <Link href="/auth">
                {tI18nHardcoded.raw(
                  'autoAppPublicMarketingCompareSlugPageJsxTextStartFree05549e67',
                )}
                <HiArrowRight className="size-4" />
              </Link>
            </Button>
            <Button size="xl" variant="secondary" asChild>
              <Link
                href="https://github.com/kortix-ai/suna"
                target="_blank"
                rel="noopener noreferrer"
              >
                {tI18nHardcoded.raw('autoAppPublicMarketingCompareSlugPageJsxTextRunIt7c6d52d5')}
              </Link>
            </Button>
          </div>
        </Reveal>
      </section>

      <section className="mx-auto mt-24 max-w-6xl px-6 lg:px-0">
        <Reveal>
          <h2 className="text-foreground text-2xl font-medium tracking-tight sm:text-3xl">
            {tI18nHardcoded.raw('autoAppPublicMarketingCompareSlugPageJsxTextTheShorta0fe796a')}
          </h2>
          <p className="text-muted-foreground mt-3 max-w-2xl text-base leading-relaxed">
            {tI18nHardcoded.raw('autoAppPublicMarketingCompareSlugPageJsxTextNoFence7e04b210')}
          </p>
        </Reveal>
        <div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-2">
          <Reveal>
            <div className="border-border bg-card flex h-full flex-col rounded-sm border p-6">
              <span className="text-muted-foreground text-sm font-medium">
                Choose {c.name}{' '}
                {tI18nHardcoded.raw('autoAppPublicMarketingCompareSlugPageJsxTextIf9b282c07')}
              </span>
              <p className="text-foreground mt-4 text-base leading-relaxed">{c.verdictThem}</p>
            </div>
          </Reveal>
          <Reveal delay={0.08}>
            <div className="border-kortix-green/30 bg-kortix-green/[0.06] flex h-full flex-col rounded-sm border p-6">
              <span className="text-foreground flex items-center gap-2 text-sm font-semibold">
                <span className="bg-kortix-green size-2 rounded-full" />{' '}
                {tI18nHardcoded.raw(
                  'autoAppPublicMarketingCompareSlugPageJsxTextChooseKortix0f7f6aec',
                )}
              </span>
              <p className="text-foreground mt-4 text-base leading-relaxed">{c.verdictKortix}</p>
            </div>
          </Reveal>
        </div>
      </section>

      <section className="mx-auto mt-24 max-w-6xl px-6 lg:px-0">
        <Reveal>
          <h2 className="text-foreground text-2xl font-medium tracking-tight sm:text-3xl">
            {tI18nHardcoded.raw('autoAppPublicMarketingCompareSlugPageJsxTextSideByffb7ae99')}
          </h2>
          <p className="text-muted-foreground mt-3 mb-8 max-w-2xl text-base leading-relaxed">
            {tI18nHardcoded.raw('autoAppPublicMarketingCompareSlugPageJsxTextAnHonest49ef79d5')}
            {c.name}.
          </p>
          <div className="grid grid-cols-[1.3fr_1fr_1fr] sm:grid-cols-[1.2fr_1fr_1fr]">
            <div className="px-2.5 pb-4 sm:px-5" />
            <div className="flex items-end px-2.5 pb-4 sm:px-5">
              <span className="text-muted-foreground text-sm font-medium sm:text-base">
                {c.name}
              </span>
            </div>
            <div className="bg-foreground flex items-center gap-2 rounded-t-2xl px-2.5 pt-5 pb-4 shadow-sm sm:px-5">
              <KortixLogo size={15} variant="logomark" className="text-background" />
              {/* <span className="text-background text-xs font-medium sm:text-sm">Kortix</span> */}
            </div>

            {c.rows.map((row, i) => {
              const lean = row.lean ?? 'kortix';
              const last = i === c.rows.length - 1;
              return (
                <Fragment key={row.dimension}>
                  <div
                    className={cn(
                      'text-foreground flex items-start px-2.5 py-4 text-xs font-medium sm:px-5 sm:text-sm',
                      !last && 'border-border border-b',
                    )}
                  >
                    {row.dimension}
                  </div>
                  <div
                    className={cn(
                      'text-muted-foreground flex items-start gap-2 px-2.5 py-4 text-xs sm:px-5 sm:text-sm',
                      !last && 'border-border border-b',
                    )}
                  >
                    <LeanMark side="them" lean={lean} />
                    <span>{row.them}</span>
                  </div>
                  <div
                    className={cn(
                      'bg-foreground text-background flex items-start gap-2 px-2.5 py-4 text-xs font-medium shadow-sm sm:px-5 sm:text-sm',
                      last ? 'rounded-b-2xl' : 'border-background/15 border-b',
                    )}
                  >
                    <LeanMark side="kortix" lean={lean} />
                    <span>{row.kortix}</span>
                  </div>
                </Fragment>
              );
            })}
          </div>
        </Reveal>
      </section>

      <section className="mx-auto mt-24 max-w-6xl px-6 lg:px-0">
        <Reveal>
          <h2 className="text-foreground mb-8 text-2xl font-medium tracking-tight sm:text-3xl">
            {tI18nHardcoded.raw('autoAppPublicMarketingCompareSlugPageJsxTextWhatEachaf7a1d83')}
          </h2>
        </Reveal>
        <div className="md:divide-border grid grid-cols-1 gap-x-12 gap-y-8 md:grid-cols-2 md:divide-x">
          <Reveal>
            <div className="md:pr-12">
              <span className="text-muted-foreground text-sm font-medium">{c.name}</span>
              <p className="text-foreground mt-4 text-base leading-relaxed text-pretty">
                {c.builtForThem}
              </p>
            </div>
          </Reveal>
          <Reveal delay={0.08}>
            <div className="md:pl-12">
              <span className="text-foreground flex items-center gap-2 text-sm font-semibold">
                <span className="bg-kortix-green size-2 rounded-full" /> Kortix
              </span>
              <p className="text-foreground mt-4 text-base leading-relaxed text-pretty">
                {c.builtForKortix}
              </p>
            </div>
          </Reveal>
        </div>
      </section>

      <section className="mx-auto mt-24 w-full max-w-6xl px-6 lg:px-0">
        <Reveal>
          <h2 className="text-foreground mb-8 text-2xl font-medium tracking-tight sm:text-3xl">
            {tI18nHardcoded.raw('autoAppPublicMarketingCompareSlugPageJsxTextWhereKortixa82be965')}
          </h2>
        </Reveal>
        <div className="w-full overflow-hidden">
          <Stepper orientation="vertical" className="flex w-full flex-col">
            {c.differentiators.map((d, i) => (
              <Reveal key={d.title}>
                <div className="flex gap-3 md:gap-10">
                  <StepperItem step={i + 1} completed className="items-center justify-center">
                    <StepperTrigger asChild>
                      <span className="flex shrink-0">
                        <StepperIndicator className="size-7 text-sm font-medium">
                          {i + 1}
                        </StepperIndicator>
                      </span>
                    </StepperTrigger>
                    {i < c.differentiators.length && (
                      <StepperSeparator className="bg-secondary m-0 h-full group-data-[orientation=vertical]/stepper:h-full" />
                    )}
                  </StepperItem>
                  <div className="min-w-0 flex-1 pb-14">
                    <StepperTitle className="text-foreground text-lg tracking-tight text-balance">
                      {d.title}
                    </StepperTitle>
                    <StepperDescription className="mt-3 max-w-2xl text-base leading-relaxed text-pretty">
                      {d.body}
                    </StepperDescription>
                  </div>
                </div>
              </Reveal>
            ))}
          </Stepper>
        </div>
      </section>

      <section className="mx-auto mt-24 flex w-full max-w-6xl flex-col items-center justify-center px-6 lg:px-0">
        <Reveal className="grid w-full grid-cols-12">
          <div className="lg:col-span-4">
            <h2 className="text-foreground mb-8 text-2xl font-medium tracking-tight sm:text-3xl">
              {tI18nHardcoded.raw('autoAppPublicMarketingCompareSlugPageJsxTextWhenTo67e7041d')}
            </h2>
          </div>
          <div className="border-border bg-card overflow-hidden rounded-2xl border lg:col-span-8">
            {c.scenarios.map((s, i) => (
              <div
                key={s.need}
                className={cn(
                  'flex items-center justify-between gap-4 px-5 py-4 sm:px-7',
                  i !== c.scenarios.length - 1 && 'border-border border-b',
                )}
              >
                <span className="text-foreground text-sm leading-relaxed sm:text-base">
                  {s.need}
                </span>
                {s.pick === 'kortix' ? (
                  <span className="text-foreground flex shrink-0 items-center gap-1.5 text-sm font-medium">
                    <span className="bg-kortix-green size-2 rounded-full" /> Kortix
                  </span>
                ) : (
                  <span className="text-muted-foreground shrink-0 text-sm font-medium">
                    {c.name}
                  </span>
                )}
              </div>
            ))}
          </div>
        </Reveal>
      </section>

      <section className="mx-auto mt-24 flex w-full max-w-6xl flex-col items-center justify-center px-6 lg:px-0">
        <Reveal className="grid w-full grid-cols-12">
          <div className="lg:col-span-4">
            <h2 className="text-foreground mb-8 text-2xl font-medium tracking-tight sm:text-3xl">
              {tI18nHardcoded.raw(
                'autoAppPublicMarketingCompareSlugPageJsxTextFrequentlyAsked2adb2de4',
              )}
            </h2>
          </div>
          <div className="border-border bg-card overflow-hidden rounded-2xl border lg:col-span-8">
            <Accordion type="single" collapsible className="w-full">
              {c.faqs.map((f, i) => (
                <AccordionItem key={f.q} value={`faq-${i}`} className="border-border px-5 sm:px-7">
                  <AccordionTrigger className="text-foreground py-6 text-base font-medium hover:no-underline">
                    {f.q}
                  </AccordionTrigger>
                  <AccordionContent>
                    <p className="text-muted-foreground max-w-3xl pb-2 text-base leading-relaxed text-pretty">
                      {f.a}
                    </p>
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </div>
        </Reveal>
      </section>

      <section className="relative mx-auto max-w-6xl px-6 py-16 sm:py-24 lg:px-0">
        <Reveal>
          <div className="border-border bg-card relative overflow-hidden rounded-sm border text-center">
            <div className="flex grid-cols-12 flex-col-reverse gap-2 md:grid">
              <div className="col-span-4 flex flex-col items-start justify-start space-y-4 p-6 *:text-left">
                <div className="space-y-2">
                  <h2 className="text-foreground text-2xl leading-tight font-medium tracking-tight sm:text-3xl">
                    {c.ctaTitle}
                  </h2>
                  <p className="text-muted-foreground mt-4 text-sm leading-relaxed">{c.ctaBody}</p>
                </div>

                <div className="mt-auto grid w-full grid-cols-1 gap-2">
                  <Button size="lg" className="w-full" asChild>
                    <Link href="/auth">
                      {tI18nHardcoded.raw(
                        'autoAppPublicMarketingCompareSlugPageJsxTextStartFree05549e67',
                      )}
                      <HiArrowRight className="size-4" />
                    </Link>
                  </Button>
                  <Button asChild size="lg" className="w-full" variant="accent">
                    <Link
                      href="https://github.com/kortix-ai/suna"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {tI18nHardcoded.raw(
                        'autoAppPublicMarketingCompareSlugPageJsxTextRunIt7c6d52d5',
                      )}
                    </Link>
                  </Button>
                </div>
              </div>
              <div className="col-span-1 hidden md:block" />
              <div className="col-span-7 mask-y-from-90% mask-x-from-90%">
                <KortixGrid count={58} seed={4228} />
              </div>
            </div>
          </div>
        </Reveal>
      </section>
    </main>
  );
}
