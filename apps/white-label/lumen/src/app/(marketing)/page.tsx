import { AssistantVignette, ReviewVignette, VaultVignette, WorkflowVignette } from '@/components/marketing/vignettes';
import { BRAND } from '@/config/brand';
import { Button } from '@kortix/ui/button';
import { ArrowRightIcon, ShieldCheckIcon } from '@phosphor-icons/react/dist/ssr';
import Link from 'next/link';

const MODULES = [
  {
    name: 'Assistant',
    title: 'Ask the matter, not the internet.',
    body: 'Questions are answered from the documents in the matter. Every claim links to the paragraph it came from, and a quote that is not in the source is flagged, never shown as fact.',
    vignette: <AssistantVignette />,
  },
  {
    name: 'Vault',
    title: 'One place for every document in a matter.',
    body: 'Drop in PDFs and Word files. Lumen reads them page by page, so search finds the passage and the preview opens at the right page.',
    vignette: <VaultVignette />,
  },
  {
    name: 'Tabular review',
    title: 'A data room, as a table.',
    body: 'Each row is a document, each column a question: liability cap, governing law, change of control. Lawyers verify, flag or edit each cell, and a re-run never overwrites their work.',
    vignette: <ReviewVignette />,
  },
  {
    name: 'Workflows',
    title: 'Your playbook, applied clause by clause.',
    body: 'Review a contract against your firm’s positions, draft from your templates, or summarize a diligence set. Redlines arrive as tracked changes in Word.',
    vignette: <WorkflowVignette />,
  },
];

export default function MarketingHome() {
  return (
    <>
      <section className="mx-auto max-w-6xl px-4 pt-20 pb-16 text-center sm:px-6 sm:pt-28">
        <p className="font-mono text-xs tracking-wider text-brand uppercase">For small firms and in-house teams</p>
        <h1 className="mx-auto mt-4 max-w-3xl font-display text-5xl leading-[1.05] tracking-tight sm:text-7xl">
          {BRAND.name}. {BRAND.tagline}
        </h1>
        <p className="mx-auto mt-5 max-w-xl text-lg text-muted-foreground">{BRAND.subline}</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Button asChild size="lg">
            <Link href="/sign-up">Start free trial</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="#product">
              See how it works <ArrowRightIcon className="size-4" />
            </Link>
          </Button>
        </div>
      </section>

      <section id="product" className="mx-auto max-w-6xl scroll-mt-20 space-y-24 px-4 py-16 sm:px-6">
        {MODULES.map((m, i) => (
          <div key={m.name} className="grid items-center gap-10 md:grid-cols-2">
            <div className={i % 2 ? 'md:order-2' : undefined}>
              <p className="font-mono text-xs tracking-wider text-brand uppercase">{m.name}</p>
              <h2 className="mt-3 font-display text-4xl leading-tight tracking-tight">{m.title}</h2>
              <p className="mt-4 max-w-md text-muted-foreground">{m.body}</p>
            </div>
            <div>{m.vignette}</div>
          </div>
        ))}
      </section>

      <section className="border-y border-border bg-muted/40">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-16 sm:px-6 md:grid-cols-3">
          {[
            ['Set up in minutes', 'Name your firm, invite colleagues, open a sample matter. No IT project.'],
            ['Priced per seat', 'Solo, Team or Firm. Add a seat when you add a lawyer.'],
            ['Your firm, your rules', 'Roles, restricted matters and an audit log that records every change.'],
          ].map(([t, b]) => (
            <div key={t}>
              <h3 className="font-display text-2xl tracking-tight">{t}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{b}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <Link
          href="/security"
          className="flex flex-col items-start gap-4 rounded-2xl border border-border bg-card p-6 transition-colors hover:border-brand/40 sm:flex-row sm:items-center"
        >
          <ShieldCheckIcon className="size-8 shrink-0 text-brand" />
          <div className="flex-1">
            <p className="font-medium">Your documents stay in your firm’s workspace.</p>
            <p className="text-sm text-muted-foreground">Each task runs in its own isolated workspace. Read how Lumen handles your data.</p>
          </div>
          <span className="flex items-center gap-1 text-sm text-brand">
            Security <ArrowRightIcon className="size-4" />
          </span>
        </Link>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-24 text-center sm:px-6">
        <h2 className="font-display text-4xl tracking-tight">Open your first matter today.</h2>
        <div className="mt-6 flex justify-center">
          <Button asChild size="lg">
            <Link href="/sign-up">Start free trial</Link>
          </Button>
        </div>
      </section>
    </>
  );
}
