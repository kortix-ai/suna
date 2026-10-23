'use client';

import type { ProjectMemorySource } from '@kortix/sdk';

import { useTranslations } from '../../i18n';
import { cn } from '../../lib/utils';
import { uiRoutes } from '../../lib/routes';
import Hint from '../../primitives/hint';
import { UiLink as Link, useUiPathname, useUiSearchParams } from '../../providers/ui-provider';
import { participantLabel } from '../../session/participants/session-participants';

const CHIP =
  'bg-kortix-base/15 text-foreground mx-0.5 inline-flex h-5 max-w-60 items-center rounded-sm px-1.5 align-middle text-xs font-medium';
const LINK = 'focus-visible:ring-ring underline-offset-2 outline-none hover:underline focus-visible:ring-2';

/** The hint of a chip that opens nothing: a person, an import, a deleted thread, an outside source without a URL. */
const STATIC_HINT = { thread: 'threadGone', outside: 'outsideText', person: 'person', import: 'import' } as const;

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Where a source thread opens: its channel or DM with `?thread=`. A thread of
 * the page the reader is on opens beside it and keeps the other params (the
 * Memory tab stays open).
 */
export function useSourceThreadHref(projectId: string): (source: ProjectMemorySource) => string | null {
  const pathname = useUiPathname();
  const searchParams = useUiSearchParams();
  return (source) => {
    const hint = source.thread_href_hint;
    if (!source.session_id || !hint) return null;
    const path =
      hint.space_kind === 'channel' ? uiRoutes().channel(projectId, hint.slug) : uiRoutes().dm(projectId, hint.agent);
    const here = pathname.endsWith(path);
    const params = new URLSearchParams(here ? searchParams.toString() : '');
    params.set('thread', source.session_id);
    return `${here ? pathname : path}?${params.toString()}`;
  };
}

/** A fact's ⟦n⟧ token: the source's label. A thread opens, an outside source opens its URL in a new tab. */
export function SourceChip({ source, projectId }: { source: ProjectMemorySource; projectId: string }) {
  const t = useTranslations('spaces.memory');
  const threadHref = useSourceThreadHref(projectId)(source);
  // A person source is labelled with the name or, without one, the email: show the name part.
  const text = source.kind === 'person' ? participantLabel({ name: source.label, email: null }) : source.label;
  const label = <span className="truncate">{text}</span>;
  if (threadHref) {
    return (
      <Hint side="top" label={t('source.thread', { label: source.label })}>
        <Link href={threadHref} className={cn(CHIP, LINK)}>
          {label}
        </Link>
      </Hint>
    );
  }
  if (source.kind === 'outside' && source.url && isHttpUrl(source.url)) {
    return (
      <Hint side="top" label={t('source.outside', { label: source.label })}>
        <a href={source.url} target="_blank" rel="noopener noreferrer" className={cn(CHIP, LINK)}>
          {label}
        </a>
      </Hint>
    );
  }
  return (
    <Hint side="top" label={t(`source.${STATIC_HINT[source.kind]}`, { label: text })}>
      {/* Focusable, so a keyboard reaches the hint that says what the source is. */}
      <span tabIndex={0} className={cn(CHIP, 'focus-visible:ring-ring outline-none focus-visible:ring-2')}>
        {label}
      </span>
    </Hint>
  );
}
