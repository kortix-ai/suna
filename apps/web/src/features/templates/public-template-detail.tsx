'use client';

import { ArrowSquareOutIcon, CubeIcon, GithubLogoIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';


import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/marketing/button';
import { cn } from '@/lib/utils';
import { connectorFor } from './connectors-catalog';
import { TemplateCard } from './template-card';
import { ConnectorMark } from './template-connectors';
import { TemplateContentCard, TemplateContentTile } from './template-content-card';
import { TemplateFileTree } from './template-file-tree';
import { TemplateFileView } from './template-file-view';
import { TemplateInstallCta } from './template-install-cta';
import { TemplateSectionLabel, TemplateShell } from './template-shell';
import { templateVisual } from './template-visual';
import {
  type Template,
  type TemplateFile,
  templateConnectorRows,
  templateRepoSlug,
  templateRepoUrl,
} from './templates-catalog';

/**
 * The PUBLIC detail surface for one template — `/templates/<slug>`.
 *
 * Same two-column shell as the catalog: the rail is the template's identity and
 * the one action, the wide column is everything it brings. The column is
 * ordered give-then-ask — the agents, skills and triggers a visitor gets, then
 * the connectors and secrets they will have to supply — because this page's job
 * is to explain the value before it names the cost. The rail's action stays
 * pinned throughout, so the ask is never further than one glance from the
 * button that acts on it.
 *
 * The action is auth-aware (`TemplateInstallCta`): a signed-in visitor has an
 * account to install into, a signed-out one only has `/auth`. It comes wrapped
 * in `<Suspense>` for exactly one reason — it calls `useSearchParams()` to
 * notice `?install=1` on return from `/auth`, and that hook forces dynamic
 * rendering unless it sits behind a boundary. Everything else stays server
 * rendered under `revalidate = 3600`, which is the point of an SEO page; the
 * fallback is the plain pre-auth link, so a crawler (or a client mid-hydration)
 * still gets a real, working action either way.
 *
 * It never renders per-project install STATE. A visitor may have several
 * projects and none is "the" project until the install dialog's picker resolves
 * one, so the connector list here shows requirements and no connection status.
 */
export function PublicTemplateDetail({
  template,
  otherTemplates = [],
  files = [],
  defaultPath = null,
  defaultContent = null,
}: {
  template: Template;
  /** The rest of the catalog, for cross-links at the foot of the page. */
  otherTemplates?: Template[];
  /** The template repo's readable files at its pinned commit. */
  files?: TemplateFile[];
  /** The file the page opens on — its README, normally. */
  defaultPath?: string | null;
  /** That file's body, server-rendered so the prose is in the crawled HTML. */
  defaultContent?: string | null;
}) {
  const { Icon, banner, color } = templateVisual(template.slug);
  const connectors = templateConnectorRows(template);
  // Which file the tree has selected. Undefined means "the default document",
  // which is the one already rendered into the page.
  const [selectedPath, setSelectedPath] = useState<string | undefined>(undefined);

  return (
    <TemplateShell
      crumbs={[{ label: 'Templates', href: '/templates' }, { label: template.title }]}
      sidebar={
        <>
          <div className="space-y-4">
            <div
              className={cn(
                'flex h-20 items-center justify-center rounded-md bg-gradient-to-br',
                banner,
              )}
            >
              <Icon weight="fill" className={cn('size-7 opacity-80', color)} aria-hidden />
            </div>

            <div className="space-y-1">
              <h1 className="text-foreground text-2xl font-semibold tracking-tight text-balance">
                {template.title}
              </h1>
              <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
                <CubeIcon className="size-3.5 shrink-0" aria-hidden />
                Template
              </span>
            </div>

            <ExpandableText
              text={template.description ?? 'This template ships no description in its kortix.yaml.'}
            />

            <div className="flex flex-col items-start gap-2">
              <Suspense
                fallback={
                  <Button asChild size="lg" className="w-full">
                    <Link href="/auth">Start free to install</Link>
                  </Button>
                }
              >
                <TemplateInstallCta template={template} className="w-full" />
              </Suspense>
              {/* The same sentence the install modal puts beside its button. A
                  visitor must not read `Install` as "this lands in my repo". */}
              <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
                Install opens a change request you review.
              </p>
            </div>
          </div>

          {files.length > 0 ? (
            <div>
              <TemplateSectionLabel count={files.length}>Files</TemplateSectionLabel>
              {/* Capped and scrolled: a template repo is small, but the rail is
                  sticky, and a tree taller than the viewport would push the
                  provenance row out of reach on a short screen. */}
              <div className="bg-popover max-h-72 overflow-y-auto rounded-md border py-1">
                <TemplateFileTree
                  paths={files.map((file) => file.path)}
                  selected={selectedPath ?? defaultPath ?? undefined}
                  onSelect={setSelectedPath}
                />
              </div>
            </div>
          ) : null}

          {/* Provenance closes the rail, the way the source block closed it on the
              old project page: who published this, and the exact commit the
              install reads. */}
          <a
            href={templateRepoUrl(template)}
            target="_blank"
            rel="noreferrer"
            className="group border-border/60 duration-normal flex items-center gap-3 border-t pt-4 transition-transform ease-out active:scale-[0.99]"
          >
            <span className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-sm">
              <GithubLogoIcon className="size-4" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="text-foreground block truncate font-mono text-sm group-hover:underline">
                {templateRepoSlug(template)}
              </span>
              <span className="text-muted-foreground block truncate font-mono text-xs tabular-nums">
                {template.resolved_sha.slice(0, 7)}
                {template.git_ref ? ` · ${template.git_ref}` : ''}
              </span>
            </span>
            <ArrowSquareOutIcon
              className="text-muted-foreground/60 size-3.5 shrink-0"
              aria-hidden
            />
          </a>
        </>
      }
    >
      <div className="space-y-8">
        {/* The template's own words come first — its README is what a person
            reads to decide, and the sections below only summarize what its
            manifest declares. */}
        {defaultPath || selectedPath ? (
          <section>
            <TemplateFileView
              slug={template.slug}
              path={selectedPath}
              defaultPath={defaultPath ?? undefined}
              initialContent={defaultContent}
            />
          </section>
        ) : null}

        {template.agents.length > 0 ? (
          <section>
            <TemplateSectionLabel count={template.agents.length}>Agents</TemplateSectionLabel>
            <div className="grid gap-3 sm:grid-cols-2">
              {template.agents.map((agent) => (
                <TemplateContentCard
                  key={agent.name}
                  leading={<TemplateContentTile kind="agent" />}
                  title={agent.name}
                  subtitle={agent.description}
                />
              ))}
            </div>
          </section>
        ) : null}

        {template.skills.length > 0 ? (
          <section>
            <TemplateSectionLabel count={template.skills.length}>Skills</TemplateSectionLabel>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {template.skills.map((skill) => (
                <TemplateContentCard
                  key={skill}
                  leading={<TemplateContentTile kind="skill" />}
                  title={skill}
                />
              ))}
            </div>
          </section>
        ) : null}

        {template.triggers.length > 0 ? (
          <section>
            <TemplateSectionLabel count={template.triggers.length}>Triggers</TemplateSectionLabel>
            <div className="grid gap-3 sm:grid-cols-2">
              {template.triggers.map((trigger) => (
                <TemplateContentCard
                  key={trigger.slug}
                  leading={<TemplateContentTile kind="trigger" />}
                  title={trigger.name}
                  // The cadence, not the state. `enabled` is a per-project
                  // setting a visitor has not made yet, and every trigger ships
                  // disabled anyway — printing it would describe a project that
                  // does not exist.
                  subtitle={trigger.cron ?? trigger.type}
                />
              ))}
            </div>
          </section>
        ) : null}

        {connectors.length > 0 ? (
          <section>
            <TemplateSectionLabel count={connectors.length}>
              Connectors it uses
            </TemplateSectionLabel>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {connectors.map((use) => {
                const connector = connectorFor(use.id);
                return (
                  <TemplateContentCard
                    key={use.slug || use.id}
                    leading={<ConnectorMark connector={connector} />}
                    title={connector.name}
                  />
                );
              })}
            </div>
          </section>
        ) : null}

        {template.env_required.length > 0 ? (
          <section>
            <TemplateSectionLabel count={template.env_required.length}>
              Secrets you provide
            </TemplateSectionLabel>
            {/* Keys are short and there can be many, so they read better as a
                wrapped badge set than as one card each. */}
            <div className="bg-popover flex flex-wrap gap-1.5 rounded-md border px-4 py-4">
              {template.env_required.map((key) => (
                <Badge key={key} variant="outline" size="sm" className="font-mono">
                  {key}
                </Badge>
              ))}
            </div>
          </section>
        ) : null}

        {otherTemplates.length > 0 ? (
          <section>
            <TemplateSectionLabel count={otherTemplates.length}>
              Other templates
            </TemplateSectionLabel>
            <ul className="grid gap-3 sm:grid-cols-2">
              {otherTemplates.map((other) => (
                <li key={other.slug}>
                  <TemplateCard
                    template={other}
                    href={`/templates/${other.slug}`}
                    size="default"
                  />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </TemplateShell>
  );
}

/**
 * The description, clamped to five lines with a toggle.
 *
 * The rail is narrow, so a three-sentence description runs ten lines and pushes
 * the install action below the fold — the one thing on this page that must stay
 * visible. Clamping is measured rather than guessed at from a character count:
 * the toggle only appears when the text actually overflows, so a short
 * description never grows a dead "Show more".
 */
function ExpandableText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);

  const checkOverflow = useCallback(() => {
    const el = ref.current;
    if (!el || expanded) return;
    setCanExpand(el.scrollHeight > el.clientHeight + 1);
  }, [expanded]);

  useLayoutEffect(() => {
    checkOverflow();
  }, [checkOverflow, text]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // The rail reflows at `lg`, and a clamp that was overflowing at one width
    // may not be at another — so the check is tied to the element's own size,
    // not to a one-shot measurement on mount.
    const observer = new ResizeObserver(checkOverflow);
    observer.observe(el);
    return () => observer.disconnect();
  }, [checkOverflow]);

  return (
    <div className="space-y-1">
      <p
        ref={ref}
        className={cn(
          'text-muted-foreground text-sm leading-relaxed text-pretty',
          !expanded && 'line-clamp-5',
        )}
      >
        {text}
      </p>
      {canExpand ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="text-muted-foreground hover:text-foreground duration-normal cursor-pointer text-xs font-medium transition-colors ease-out"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  );
}
