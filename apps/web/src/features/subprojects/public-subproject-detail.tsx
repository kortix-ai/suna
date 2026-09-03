'use client';

import {
  ArrowLeftIcon,
  ArrowSquareOutIcon,
  ClockIcon,
  DownloadSimpleIcon,
  FileZipIcon,
  GithubLogoIcon,
  StarIcon,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { Suspense } from 'react';

import { Button } from '@/components/ui/marketing/button';
import { cn } from '@/lib/utils';
import { SubprojectConnectors } from './subproject-connectors';
import { SubprojectInstallCta } from './subproject-install-cta';
import { subprojectVisual } from './subproject-visual';
import {
  countLabel,
  formatCount,
  subprojectConnectorRows,
  subprojectRepoSlug,
  subprojectRepoUrl,
  type Subproject,
} from './subprojects-catalog';

/**
 * The PUBLIC detail surface for one subproject — `/marketplace/<slug>`.
 *
 * It answers the same question the install modal answers (what does this bring
 * into my project, and where did it come from) for a visitor who may not have a
 * project yet. So the panels are the modal's panels in the same order —
 * connectors first, because that is the question that gates an install,
 * provenance last.
 *
 * The action button is auth-aware — `SubprojectInstallCta` — because a
 * signed-in visitor already has an account (and usually a project) to install
 * into, where a signed-out one only has `/auth`. It lives in its own file and
 * comes wrapped in `<Suspense>` below for exactly one reason: it needs
 * `useSearchParams()` to notice `?install=1` on return from `/auth`, and that
 * hook forces dynamic rendering unless it sits behind Suspense. Everything
 * else on this page stays server-rendered under `revalidate = 3600`, which is
 * the point — this is an SEO page, and only the button opts out of that. The
 * fallback is the plain pre-auth link, so a crawler (or a client mid-hydration)
 * still gets a real, working CTA either way.
 *
 * `'use client'` for one more reason beyond the button: `subprojectVisual` /
 * `SubprojectConnectors` sit in the client graph because Phosphor's entry
 * calls `createContext` at module scope. Next still server-renders the static
 * panels, so they stay in the HTML a crawler reads.
 *
 * It never renders per-project install STATE (installed/not) — a visitor may
 * have several projects and none is "the" project until the install dialog's
 * picker resolves one — so `SubprojectConnectors` is deliberately called
 * without `connected`, same as before.
 */
export function PublicSubprojectDetail({ subproject }: { subproject: Subproject }) {
  const { Icon, color, bgColor } = subprojectVisual(subproject.slug);
  const connectors = subprojectConnectorRows(subproject);
  const repoUrl = subprojectRepoUrl(subproject);

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
            {subproject.title}
          </h1>
          <p className="text-muted-foreground mt-1.5 truncate font-mono text-xs">
            {subprojectRepoSlug(subproject)}
            {subproject.git_ref ? `@${subproject.git_ref}` : ''}
          </p>
        </div>
      </header>

      <p className="text-muted-foreground mt-6 text-base leading-relaxed text-pretty">
        {subproject.description ?? 'This subproject ships no description in its kortix.yaml.'}
      </p>

      <div className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Suspense
          fallback={
            <Button asChild size="lg">
              <Link href="/auth">Start free to install</Link>
            </Button>
          }
        >
          <SubprojectInstallCta subproject={subproject} />
        </Suspense>
        {/* Same sentence the install modal puts beside its button. A visitor must
            not read `Start free to install` (or `Install`) as "this lands in my
            repo". */}
        <span className="text-muted-foreground text-xs">
          Install opens a change request you review.
        </span>
      </div>

      <div className="mt-12 space-y-6">
        <SubprojectConnectors connectors={connectors} />

        <Panel title="Agents it adds" count={subproject.agents.length}>
          {subproject.agents.map((agent) => (
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

        <Panel title="Skills it adds" count={subproject.skills.length}>
          {subproject.skills.map((skill) => (
            <Row key={skill}>
              <span className="text-foreground font-mono text-xs">{skill}</span>
            </Row>
          ))}
        </Panel>

        <Panel title="Triggers it adds" count={subproject.triggers.length}>
          {subproject.triggers.map((trigger) => (
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

        <Panel title="Secrets you provide" count={subproject.env_required.length}>
          {subproject.env_required.map((key) => (
            <Row key={key}>
              <span className="text-foreground font-mono text-xs">{key}</span>
            </Row>
          ))}
        </Panel>

        {/* Provenance last, as in the modal: a github subproject links out so the
            source is one click away; an upload has no repository, so the row
            states what it is instead of linking to a 404. */}
        <section className="space-y-2">
          <h2 className="text-foreground text-sm font-medium">Source</h2>
          {repoUrl ? (
            <a
              href={repoUrl}
              target="_blank"
              rel="noreferrer"
              className="hover:border-foreground/20 bg-popover text-muted-foreground hover:text-foreground duration-normal flex items-center gap-2.5 rounded-md border px-3 py-2.5 text-xs transition-colors"
            >
              <GithubLogoIcon className="size-4 shrink-0" aria-hidden />
              <span className="min-w-0 truncate font-mono">{subprojectRepoSlug(subproject)}</span>
              {subproject.stars === null ? null : (
                <span className="ml-auto inline-flex shrink-0 items-center gap-1 tabular-nums">
                  <StarIcon weight="fill" className="size-3" aria-hidden />
                  {formatCount(subproject.stars)}
                </span>
              )}
              <span
                className={cn(
                  'inline-flex shrink-0 items-center gap-1 tabular-nums',
                  subproject.stars === null && 'ml-auto',
                )}
              >
                <DownloadSimpleIcon className="size-3" aria-hidden />
                {formatCount(subproject.install_count)}
              </span>
              <ArrowSquareOutIcon className="size-3 shrink-0 opacity-60" aria-hidden />
            </a>
          ) : (
            <div className="bg-popover text-muted-foreground flex items-center gap-2.5 rounded-md border px-3 py-2.5 text-xs">
              <FileZipIcon className="size-4 shrink-0" aria-hidden />
              <span className="min-w-0 truncate font-mono">
                {subproject.upload_name ?? subproject.slug}
              </span>
              <span className="ml-auto shrink-0 tabular-nums">
                {countLabel(subproject.file_count, 'file')}
              </span>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * One bordered list of things the subproject contributes, or nothing at all.
 *
 * `count === 0` renders NOTHING rather than an empty panel saying "no agents":
 * a subproject that ships no agents is normal, and a page of empty panels reads
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
          `SubprojectConnectors` uses. */}
      <ul className="bg-popover overflow-hidden rounded-md border [&>li+li]:border-t">
        {children}
      </ul>
    </section>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <li className="flex items-center gap-2.5 px-3 py-2">{children}</li>;
}
