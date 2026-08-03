'use client';

/**
 * Source — one cited web result.
 *
 * Adapted from prompt-kit (https://prompt-kit.com/c/source.json). Changes from
 * upstream: uses this repo's Tooltip rather than a bespoke hover card, and the
 * favicon falls back to the first letter of the host on load error rather than
 * leaving a broken image.
 */

import * as React from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

const SourceContext = React.createContext<{ href: string }>({ href: '' });

export function Source({ href, children }: { href: string; children?: React.ReactNode }) {
  return <SourceContext.Provider value={{ href }}>{children}</SourceContext.Provider>;
}

function hostOf(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, '');
  } catch {
    return href;
  }
}

export function SourceTrigger({
  label,
  showFavicon = false,
  className,
}: {
  label?: string;
  showFavicon?: boolean;
  className?: string;
}) {
  const { href } = React.useContext(SourceContext);
  const [faviconFailed, setFaviconFailed] = React.useState(false);
  const host = hostOf(href);
  const text = label ?? host;

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className={cn(
        'text-muted-foreground hover:text-foreground',
        'inline-flex max-w-full items-center gap-1.5 rounded-md text-xs transition-colors',
        className,
      )}
    >
      {showFavicon &&
        (faviconFailed ? (
          <span className="bg-muted text-muted-foreground flex size-3.5 flex-none items-center justify-center rounded-sm text-[9px] uppercase">
            {host.charAt(0)}
          </span>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`}
            alt=""
            className="size-3.5 flex-none rounded-sm"
            onError={() => setFaviconFailed(true)}
          />
        ))}
      <span className="min-w-0 truncate">{text}</span>
    </a>
  );
}

export function SourceContent({
  title,
  description,
  className,
}: {
  title?: string;
  description?: string;
  className?: string;
}) {
  const { href } = React.useContext(SourceContext);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('text-muted-foreground truncate text-xs', className)}>
          {title ?? hostOf(href)}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <p className="font-medium">{title ?? hostOf(href)}</p>
        {description ? <p className="text-muted-foreground mt-1 text-xs">{description}</p> : null}
      </TooltipContent>
    </Tooltip>
  );
}
