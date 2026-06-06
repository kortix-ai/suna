import { Badge } from '@/components/ui/badge';
import { KortixAsterisk } from '@/components/ui/kortix-asterisk';
import { Button } from '@/components/ui/marketing/button';
import {
  favicon,
  getAllUseCases,
  getUseCaseBySlug,
  integrationLabel,
} from '@/features/use-cases/data';
import { UseCaseTryCta } from '@/features/use-cases/use-case-try-cta';
import { YOUTUBE_IFRAME_ALLOW } from '@/lib/security/iframe-sandbox';
import { ArrowRight, Check } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

const DEMO_URL = '/enterprise';

export function generateStaticParams() {
  return getAllUseCases().map((useCase) => ({ slug: useCase.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const useCase = getUseCaseBySlug(slug);
  if (!useCase) return { title: 'Use case not found' };
  return {
    title: `${useCase.title} — Use cases`,
    description: useCase.overview,
  };
}

export default async function UseCasePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const useCase = getUseCaseBySlug(slug);
  if (!useCase) notFound();

  const integrationIcons = useCase.integrations.slice(0, 3);

  return (
    <div className="bg-background min-h-screen pt-28 sm:pt-32">
      <header className="border-border flex w-full flex-col border-b pb-12">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-6 md:flex-row xl:px-0">
          <div className="flex-1 space-y-5">
            <div className="space-y-2">
              <h1 className="text-foreground text-3xl font-semibold tracking-tight">
                {useCase.title}
              </h1>
              <p className="text-muted-foreground text-base">{useCase.subtitle}</p>
            </div>
            <UseCaseTryCta slug={useCase.slug} prompt={useCase.prompt} />
          </div>

          <div className="flex w-full flex-row items-start justify-start gap-8 md:w-auto md:flex-col md:gap-4">
            <div className="space-y-1">
              <span className="text-muted-foreground text-xs uppercase">Category</span>
              <p className="text-base leading-normal font-normal text-balance">
                {useCase.category}
              </p>
            </div>
            <div className="space-y-1">
              <span className="text-muted-foreground text-xs uppercase">Features</span>
              <p className="text-base leading-normal font-normal text-balance">
                {useCase.tags.slice(0, 3).join(', ')}
              </p>
            </div>
            <div className="space-y-2">
              <span className="text-muted-foreground text-xs uppercase">Integrations</span>
              <span className="flex flex-wrap gap-2">
                {integrationIcons.map((domain) => (
                  <span
                    key={`${useCase.id}-${domain}-icon`}
                    className="flex size-5 shrink-0 items-center justify-center"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={favicon(domain)}
                      alt={integrationLabel(domain)}
                      width={20}
                      height={20}
                      className="size-5 rounded-sm"
                    />
                  </span>
                ))}
              </span>
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-6 py-8 md:py-12 xl:px-0">
        <main className="space-y-12">
          {useCase.videoId && (
            <section className="space-y-3">
              <h2 className="text-foreground text-lg font-semibold">Watch demo</h2>
              <div className="border-border bg-muted aspect-video w-full overflow-hidden rounded-md border">
                <iframe
                  title={`${useCase.title} demo`}
                  src={`https://www.youtube.com/embed/${useCase.videoId}?rel=0`}
                  allow={YOUTUBE_IFRAME_ALLOW}
                  allowFullScreen
                  className="h-full w-full"
                />
              </div>
            </section>
          )}

          <section className="space-y-6">
            <div className="space-y-2">
              <h2 className="text-foreground text-lg font-semibold">How it works</h2>
              <p className="text-muted-foreground max-w-3xl text-base leading-relaxed">
                {useCase.overview}
              </p>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {useCase.steps.map((step, i) => (
                <div key={step.title} className="border-border bg-card rounded-md border p-4">
                  <div className="text-muted-foreground font-mono text-xs">/0{i + 1}</div>
                  <div className="text-foreground mt-1.5 text-sm font-semibold">{step.title}</div>
                  <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
                    {step.description}
                  </p>
                </div>
              ))}
            </div>
          </section>

          <section className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            <div className="space-y-3">
              <h2 className="text-foreground text-lg font-semibold">What it needs</h2>
              <ul className="space-y-2">
                {useCase.inputs.map((input) => (
                  <li
                    key={input}
                    className="text-muted-foreground flex items-start gap-2.5 text-base"
                  >
                    <Check className="text-foreground/60 mt-0.5 size-4 shrink-0" />
                    {input}
                  </li>
                ))}
              </ul>
            </div>
            <div className="space-y-3">
              <h2 className="text-foreground text-lg font-semibold">What you get back</h2>
              <ul className="space-y-2">
                {useCase.outputs.map((output, i) => (
                  <li
                    key={output}
                    className="text-muted-foreground flex items-start gap-2.5 text-base"
                  >
                    {/* <Check className="mt-0.5 size-4 shrink-0 text-emerald-500" /> */}
                    <KortixAsterisk index={i} parentClass="mt-0" />
                    {output}
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-foreground text-lg font-semibold">Real metrics</h2>
            <p className="text-muted-foreground max-w-3xl text-sm leading-relaxed">
              {useCase.metrics}
            </p>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {useCase.integrations.map((domain) => (
                <Badge key={domain} variant="secondary" size="sm" className="gap-1 p-2 px-1.5">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={favicon(domain)}
                    alt={integrationLabel(domain)}
                    width={16}
                    height={16}
                    className="size-4 rounded-sm"
                  />
                  <span className="text-foreground">{integrationLabel(domain)}</span>
                </Badge>
              ))}
              <span className="text-muted-foreground text-sm">+ 3,000 more</span>
            </div>
          </section>

          <section className="flex flex-col items-start gap-3 pt-10 sm:flex-row sm:items-center">
            <Button asChild size="lg">
              <Link href="/auth">
                Get started free
                <ArrowRight className="size-3.5" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="accent">
              <Link href={DEMO_URL}>Request a demo of this agent</Link>
            </Button>
          </section>
        </main>
      </div>
    </div>
  );
}
