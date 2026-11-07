'use client';

import { uiRoutes } from '../../../lib/routes';
import { ProjectNavRow } from '../../../internal/layout/project-nav-row';
import { HoverPrefetchLink } from '../../../internal/components/hover-prefetch-link';
import { useTranslations } from '../../../i18n';
import { Popover, PopoverAnchor } from '../../../primitives/popover';
import {
  InputGroupSearch,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '../../../primitives/input-group';
import { menuRow } from '../../../primitives/menu-recipe';
import { NavHoverCardContent, NavHoverCardList, useNavHoverCard } from '../../../internal/layout/nav-hover-card';
import { useArtifacts, useFeatureFlag } from '@kortix/sdk/react';
import type { Artifact, ArtifactType } from '@kortix/sdk';
import { BrowserIcon, CardsThreeIcon, FileTextIcon, MagnifyingGlassIcon, type Icon } from '@phosphor-icons/react';
import { useUiPathname } from '../../../providers/ui-provider';
import { useRef, useState } from 'react';

/** Above this many artifacts the card gets a search field. Same as the Apps card. */
const SEARCH_THRESHOLD = 10;
/** The list's page size (the API default). A full page may hold more: a search there asks the server. */
const LIST_PAGE = 100;

/** The glyph the artifact's own header draws for its type (`artifact-session.tsx`). */
const TYPE_ICON: Record<ArtifactType, Icon> = { doc: FileTextIcon, html: BrowserIcon };

/** The Artifacts row shows only with the `artifacts` flag on. */
export function useArtifactsRowVisible(projectId: string | undefined): boolean {
  return useFeatureFlag(projectId, 'artifacts').enabled;
}

/**
 * The Artifacts row: docs, slides, boards and dashboards published in the
 * project. A mouse that rests on it opens a card of those artifacts, newest
 * change first, so one click opens one. The list is the gallery's own query
 * (`scope: 'all'`), so the card and the page share one cache entry.
 */
export function ProjectArtifactsNavItem({ projectId }: { projectId: string }) {
  const t = useTranslations('sidebar');
  const pathname = useUiPathname();
  const visible = useArtifactsRowVisible(projectId);
  const artifacts = useArtifacts(visible ? projectId : null, { scope: 'all' });
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const listed = artifacts.data ?? [];
  const card = useNavHoverCard({ enabled: listed.length > 0, holdRef: searchRef });
  const showSearch = listed.length > SEARCH_THRESHOLD;
  const needle = query.trim().toLowerCase();
  // Same split as the gallery: a full page filters on the server, a shorter list here.
  const paged = listed.length >= LIST_PAGE;
  const server = useArtifacts(paged && needle ? projectId : null, { scope: 'all', q: needle || undefined });
  // Title or description, as the server's `q` matches. The loaded page shows until the server
  // answers this query (not a previous one's placeholder), and when it fails.
  const local = needle
    ? listed.filter(
        (artifact) =>
          artifact.title.toLowerCase().includes(needle) || !!artifact.description?.toLowerCase().includes(needle),
      )
    : listed;
  const shown = paged && needle && server.data && !server.isPlaceholderData ? server.data : local;

  const href = projectId ? uiRoutes().artifacts(projectId) : null;
  if (!href || !visible) return null;
  const close = () => card.setOpen(false);
  return (
    <Popover
      open={card.open}
      onOpenChange={(next) => {
        card.setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <PopoverAnchor virtualRef={card.anchorRef} />
      <ProjectNavRow
        active={pathname?.startsWith(href) === true}
        label={t('artifacts')}
        href={href}
        prefetch
        {...card.rowProps}
      >
        <span className="shrink-0">
          <CardsThreeIcon />
        </span>
        {t('artifacts')}
      </ProjectNavRow>
      <NavHoverCardContent {...card.contentProps}>
        {showSearch ? (
          <div className="border-border border-b p-1">
            <InputGroupSearch>
              <InputGroupSearchIcon>
                <MagnifyingGlassIcon />
              </InputGroupSearchIcon>
              <InputGroupSearchInput
                ref={searchRef}
                variant="popover"
                size="xs"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('searchArtifacts')}
                aria-label={t('searchArtifacts')}
              />
            </InputGroupSearch>
          </div>
        ) : null}
        <NavHoverCardList className="max-h-80 overflow-x-hidden overflow-y-auto overscroll-contain">
          {shown.map((artifact) => (
            <li key={artifact.artifact_id}>
              <ArtifactRow
                artifact={artifact}
                href={`${href}/${encodeURIComponent(artifact.artifact_id)}`}
                onOpen={close}
              />
            </li>
          ))}
          {/* The Apps card's key: the text ("No matches") is not about Apps. */}
          {shown.length === 0 ? (
            <li className={menuRow('sm', 'default', 'text-muted-foreground pointer-events-none')}>
              {t('appsNoMatches')}
            </li>
          ) : null}
        </NavHoverCardList>
      </NavHoverCardContent>
    </Popover>
  );
}

/** One artifact: its type glyph and its title. */
function ArtifactRow({ artifact, href, onOpen }: { artifact: Artifact; href: string; onOpen: () => void }) {
  const Glyph = TYPE_ICON[artifact.type];
  return (
    <HoverPrefetchLink href={href} onClick={onOpen} className={menuRow('sm', 'default', 'cursor-pointer')}>
      <Glyph aria-hidden className="text-muted-foreground size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{artifact.title}</span>
    </HoverPrefetchLink>
  );
}
