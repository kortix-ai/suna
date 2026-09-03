'use client';

import { ArrowLeftIcon, ArrowSquareOutIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import type { ConnectorSetupStep } from './connector-detail-copy';

export interface ConnectorDocumentationLink {
  label: string;
  href: string;
  external?: boolean;
}

export function ConnectorDetailLayout({
  backHref,
  icon,
  title,
  description,
  status,
  primaryTitle,
  primaryDescription,
  primaryAction,
  children,
  className,
}: {
  backHref: string;
  icon: ReactNode;
  title: ReactNode;
  description?: string | null;
  status?: ReactNode;
  primaryTitle: string;
  primaryDescription: string;
  primaryAction?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <main
        className={cn('mx-auto w-full max-w-3xl space-y-6 px-4 py-8 pb-20 lg:py-12', className)}
      >
        <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit gap-1.5">
          <Link href={backHref}>
            <ArrowLeftIcon className="size-3.5 shrink-0" />
            Back to connectors
          </Link>
        </Button>

        <header className="flex min-w-0 items-start gap-3">
          {icon}
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-foreground text-2xl font-semibold tracking-tight text-balance">
                {title}
              </h1>
              {status}
            </div>
            {description ? (
              <p className="text-muted-foreground max-w-[64ch] text-base text-pretty sm:text-sm">
                {description}
              </p>
            ) : null}
          </div>
        </header>

        <section className="bg-popover rounded-md border">
          <div className="flex flex-col gap-4 px-4 py-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-1">
              <h2 className="text-foreground text-base font-medium sm:text-sm">{primaryTitle}</h2>
              <p className="text-muted-foreground max-w-[64ch] text-base text-pretty sm:text-sm">
                {primaryDescription}
              </p>
            </div>
            {primaryAction ? <div className="shrink-0 max-sm:*:w-full">{primaryAction}</div> : null}
          </div>
        </section>

        {children}
      </main>
    </div>
  );
}

export function ConnectorSetupGuide({ steps }: { steps: readonly ConnectorSetupStep[] }) {
  return (
    <section className="space-y-3" aria-labelledby="connector-setup-title">
      <h2 id="connector-setup-title" className="text-foreground text-sm font-medium">
        Connection flow
      </h2>
      <ol role="list" className="bg-popover rounded-md border">
        {steps.map((step, index) => (
          <li key={step.title} className="border-border flex gap-3 px-4 py-4 not-last:border-b">
            <span className="bg-primary/6 text-foreground flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-medium tabular-nums">
              {index + 1}
            </span>
            <div className="min-w-0 space-y-0.5">
              <p className="text-foreground text-base font-medium sm:text-sm">{step.title}</p>
              <p className="text-muted-foreground text-base text-pretty sm:text-sm">
                {step.description}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function ConnectorDocumentationLinks({
  links,
}: {
  links: readonly ConnectorDocumentationLink[];
}) {
  if (links.length === 0) return null;
  return (
    <section className="space-y-3" aria-labelledby="connector-docs-title">
      <h2 id="connector-docs-title" className="text-foreground text-sm font-medium">
        Documentation
      </h2>
      <div className="flex flex-wrap gap-2">
        {links.map((link) =>
          link.external ? (
            <Button key={`${link.label}:${link.href}`} asChild variant="outline" size="sm">
              <a href={link.href} target="_blank" rel="noreferrer">
                {link.label}
                <ArrowSquareOutIcon className="size-3.5 shrink-0" />
              </a>
            </Button>
          ) : (
            <Button key={`${link.label}:${link.href}`} asChild variant="outline" size="sm">
              <Link href={link.href}>{link.label}</Link>
            </Button>
          ),
        )}
      </div>
    </section>
  );
}
