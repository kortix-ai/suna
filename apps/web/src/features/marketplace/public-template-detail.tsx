'use client';

import {
  ArrowLeftIcon,
  ArrowSquareOutIcon,
  ClockIcon,
  GithubLogoIcon,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { Suspense } from 'react';

import { Button } from '@/components/ui/marketing/button';
import { cn } from '@/lib/utils';
import { TemplateConnectors } from './template-connectors';
import { TemplateInstallCta } from './template-install-cta';
import { templateVisual } from './template-visual';
import {
  type MarketplaceTemplate,
  templateConnectorRows,
  templateRepoSlug,
  templateRepoUrl,
} from './templates-catalog';

/**
 * The PUBLIC detail surface for one template — `/marketplace/<slug>`.
 *
 * It answers the same question the install modal answers (what does this bring
 * into my project, and where did it come from) for a visitor who may not have a
 * project yet. So the panels are the modal's panels in the same order —
 * connectors first, because that is the question that gates an install,
 * provenance last.
 *
 * The action button is auth-aware — `TemplateInstallCta` — because a signed-in
 * visitor already has an account (and usually a project) to install into,
 * where a signed-out one only has `/auth`. It lives in its own file and comes
 * wrapped in `<Suspense>` below for exactly one reason: it needs
 * `useSearchParams()` to notice `?install=1` on return from `/auth`, and that
 * hook forces dynamic rendering unless it sits behind Suspense. Everything
 * else on this page stays server-rendered under `revalidate = 3600`, which is
 * the point — this is an SEO page, and only the button opts out of that. The
 * fallback is the plain pre-auth link, so a crawler (or a client mid-hydration)
 * still gets a real, working CTA either way.
 *
 * `'use client'` for one more reason beyond the button: `templateVisual` /
 * `TemplateConnectors` sit in the client graph because Phosphor's entry calls
 * `createContext` at module scope. Next still server-renders the static panels,
 * so they stay in the HTML a crawler reads.
 *
 * It never renders per-project install STATE — a visitor may have several
 * projects and none is "the" project until the install dialog's picker resolves
 * one — so `TemplateConnectors` is deliberately called without `connected`.
 */
export function PublicTemplateDetail({ template }: { template: MarketplaceTemplate }) {
  const { Icon, color, bgColor } = templateVisual(template.slug);
  const connectors = templateConnectorRows(template);

  return (
    <div className="mx-auto max-w-3xl px-6 pt-32 pb-24 sm:pt-40 sm:pb-32">
      <Link
        href="/marketplace"
        className="text-muted-foreground hover:text-foreground duration-normal inline-flex items-center gap-1.5 text-sm transition-colors"
      >
        <ArrowLeftIcon className="size-3.5" aria-hidden />
        Marketplace
      </Link>

      <header className="mt-8 flex items-start gap-4">
        <span
          className={cn(
            'border-border flex size-12 shrink-0 items-center justify-center rounded-md border shadow-2xs',
            bgColor,
            color,
          )}
        >
          <Icon weight="fill" className="size-6" aria-hidden />
        </span>
        <div className="min-w-0">
          <h1 className="text-foreground text-2xl font-medium tracking-tight text-balance sm:text-3xl">
            {template.title}
          </h1>
          <p className="text-muted-foreground mt-1.5 truncate font-mono text-xs">
            {templateRepoSlug(template)}
            {template.git_ref ? `@${template.git_ref}` : ''}
          </p>
        </div>
      </header>

      <p className="text-muted-foreground mt-6 text-base leading-relaxed text-pretty">
        {template.description ?? 'This template ships no description in its kortix.yaml.'}
      </p>

      <div className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Suspense
          fallback={
            <Button asChild size="lg">
              <Link href="/auth">Start free to install</Link>
            </Button>
          }
        >
          <TemplateInstallCta template={template} />
        </Suspense>
        {/* Same sentence the install modal puts beside its button. A visitor must
            not read `Start free to install` (or `Install`) as "this lands in my
            repo". */}
        <span className="text-muted-foreground text-xs">
          Install opens a change request you review.
        </span>
      </div>

      <div className="mt-12 space-y-6">
        <TemplateConnectors connectors={connectors} />

        <Panel title="Agents it adds" count={template.agents.length}>
          {template.agents.map((agent) => (
            <Row key={agent.name}>
              <span className="text-foreground shrink-0 font-mono text-xs">{agent.name}</span>
              {agent.description ? (
                <span className="text-muted-foreground min-w-0 truncate text-xs">
                  {agent.description}
                </span>
              ) : null}
            </Row>
          ))}
        </Panel>

        <Panel title="Skills it adds" count={template.skills.length}>
          {template.skills.map((skill) => (
            <Row key={skill}>
              <span className="text-foreground font-mono text-xs">{skill}</span>
            </Row>
          ))}
        </Panel>

        <Panel title="Triggers it adds" count={template.triggers.length}>
          {template.triggers.map((trigger) => (
            <Row key={trigger.slug}>
              <span className="text-foreground min-w-0 truncate text-xs font-medium">
                {trigger.name}
              </span>
              {/* The cadence, not the state. `enabled` is a per-project setting a
                  visitor has not made yet — printing it here would describe a
                  project that does not exist. */}
              <span className="text-muted-foreground ml-auto inline-flex shrink-0 items-center gap-1 font-mono text-xs">
                <ClockIcon className="size-3.5" aria-hidden />
                {trigger.cron ?? trigger.type}
              </span>
            </Row>
          ))}
        </Panel>

        <Panel title="Secrets you provide" count={template.env_required.length}>
          {template.env_required.map((key) => (
            <Row key={key}>
              <span className="text-foreground font-mono text-xs">{key}</span>
            </Row>
          ))}
        </Panel>

        {/* Provenance last, as in the modal: the source is one click away. */}
        <section className="space-y-2">
          <h2 className="text-foreground text-sm font-medium">Source</h2>
          <a
            href={templateRepoUrl(template)}
            target="_blank"
            rel="noreferrer"
            className="hover:border-foreground/20 bg-popover text-muted-foreground hover:text-foreground duration-normal flex items-center gap-2.5 rounded-md border px-3 py-2.5 text-xs transition-colors"
          >
            <GithubLogoIcon className="size-4 shrink-0" aria-hidden />
            <span className="min-w-0 truncate font-mono">{templateRepoSlug(template)}</span>
            <ArrowSquareOutIcon className="ml-auto size-3 shrink-0 opacity-60" aria-hidden />
          </a>
        </section>
      </div>
    </div>
  );
}

/**
 * One bordered list of things the template contributes, or nothing at all.
 *
 * `count === 0` renders NOTHING rather than an empty panel saying "no agents":
 * a template that ships no agents is normal, and a page of empty panels reads
 * as a broken fetch. The count is passed rather than derived from `children`
 * because `children` is already-built JSX here.
 */
function Panel({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-foreground text-sm font-medium">{title}</h2>
      {/* Padding sits on the rows, never on the bordered element, so the
          `border-t` seams run edge to edge — the same shape
          `TemplateConnectors` uses. */}
      <ul className="bg-popover overflow-hidden rounded-md border [&>li+li]:border-t">
        {children}
      </ul>
    </section>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <li className="flex items-center gap-2.5 px-3 py-2">{children}</li>;
}
