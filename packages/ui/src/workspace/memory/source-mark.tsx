'use client';

import type { ProjectMemorySource } from '@kortix/sdk';

import { useTranslations } from '../../i18n';
import { uiRoutes } from '../../lib/routes';
import Hint from '../../primitives/hint';
import { UiLink as Link, useUiPathname, useUiSearchParams } from '../../providers/ui-provider';
import { participantLabel } from '../../session/participants/session-participants';
import { superscript } from './body-doc';

/** A source number as superscript digits in the text's colour; the padding widens its hit area without moving the text. */
const MARK =
  'text-foreground hover:text-muted-foreground focus-visible:ring-ring -mx-0.5 -my-1 rounded-sm px-0.5 py-1 outline-none transition-colors duration-fast focus-visible:ring-2';

/** The API's name for a person without a display name (`apps/api/src/memory/serialize.ts`). */
const MEMBER_FALLBACK = 'A member';

/** The hint of a mark that opens nothing: a person, an import, a deleted thread, an outside source without a URL. */
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

/** A person source's name: the display name, or the API's neutral "A member" in the reader's language. */
function useSourceName(): (source: ProjectMemorySource) => string {
  const t = useTranslations('spaces.memory');
  return (source) =>
    source.kind === 'person'
      ? source.label === MEMBER_FALLBACK
        ? t('author.unknown')
        : participantLabel({ name: source.label, email: null })
      : source.label;
}

/**
 * The page's numbered sources under its text: "1  Launch plan · thread". A
 * thread opens beside the page, an outside source opens its URL in a new
 * tab; the others are text.
 */
export function SourceList({ sources, projectId }: { sources: readonly ProjectMemorySource[]; projectId: string }) {
  const t = useTranslations('spaces.memory.sourceKind');
  const threadHref = useSourceThreadHref(projectId);
  const name = useSourceName();
  return (
    <ol className="flex flex-col gap-2 pt-8">
      {sources.map((source) => {
        const text = `${name(source)} · ${t(source.kind)}`;
        const href = threadHref(source);
        const LINE = 'text-muted-foreground min-w-0 text-xs [overflow-wrap:anywhere]';
        return (
          <li key={source.number} className="flex gap-2">
            <span className="text-muted-foreground w-3 shrink-0 text-xs tabular-nums">{source.number}</span>
            {href ? (
              <Link href={href} className={`${LINE} hover:text-foreground transition-colors duration-fast`}>
                {text}
              </Link>
            ) : source.kind === 'outside' && source.url && isHttpUrl(source.url) ? (
              <a
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className={`${LINE} hover:text-foreground transition-colors duration-fast`}
              >
                {text}
              </a>
            ) : (
              <span className={LINE}>{text}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * A fact's ⟦n⟧ token: a small superscript number. Hover or focus names the
 * source; a thread opens, an outside source opens its URL in a new tab.
 */
export function SourceMark({ source, projectId }: { source: ProjectMemorySource; projectId: string }) {
  const t = useTranslations('spaces.memory');
  const threadHref = useSourceThreadHref(projectId)(source);
  const text = useSourceName()(source);
  const number = superscript(source.number);
  if (threadHref) {
    const label = source.kind === 'person' ? t('source.person', { label: text }) : t('source.thread', { label: source.label });
    return (
      <Hint side="top" label={label}>
        <Link href={threadHref} aria-label={label} className={MARK}>
          {number}
        </Link>
      </Hint>
    );
  }
  if (source.kind === 'outside' && source.url && isHttpUrl(source.url)) {
    const label = t('source.outside', { label: source.label });
    return (
      <Hint side="top" label={label}>
        <a href={source.url} target="_blank" rel="noopener noreferrer" aria-label={label} className={MARK}>
          {number}
        </a>
      </Hint>
    );
  }
  const label = t(`source.${STATIC_HINT[source.kind]}`, { label: text });
  return (
    <Hint side="top" label={label}>
      {/* Focusable, so a keyboard reaches the hint that says what the source is. */}
      <span tabIndex={0} aria-label={label} className={MARK}>
        {number}
      </span>
    </Hint>
  );
}
