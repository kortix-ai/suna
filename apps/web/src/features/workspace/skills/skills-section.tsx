'use client';

/**
 * Skills — one flat screen for skills AND commands.
 *
 * A title, one line of description, a search box top right, a row of pills with
 * the primary action, then a 2-column card grid. Detail is a modal, not the
 * 264px name-rail + third column the split layout used.
 *
 * The Commands pill is a RESTORED feature, not a new one: `commands` has always
 * been a real Customize section with its own IAM leaves and its own rail entry,
 * but `customize-panel`'s switch had no `case 'commands'`, so the entry rendered
 * `null` — a live blank screen. `resolveLegacyCustomizeHref` already points that
 * section at `/skills?tab=commands`; this screen is what it lands on.
 */

import { useQuery } from '@tanstack/react-query';
import { Plus, Sparkles, SquareSlash, Store } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useMemo, useState } from 'react';

import { useMarketplaceEnabled } from '@/components/projects/marketplace/marketplace-nav';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import {
  editConfigPrompt,
  newConfigPrompt,
  useConfigureThread,
} from '@/features/workspace/customize/use-configure-thread';
import {
  ProjectSectionPage,
  type ProjectSectionState,
} from '@/features/workspace/project-section/project-section-page';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { getProjectDetail } from '@kortix/sdk';

import { SkillCard } from './skill-card';
import { SkillDetailModal } from './skill-detail';
import {
  SKILLS_DOCS_HREF,
  SKILL_KINDS,
  SKILL_KIND_ORDER,
  type SkillEntity,
  type SkillKind,
  filterSkills,
} from './skill-entities';

const KIND_ICON = { skill: Sparkles, command: SquareSlash } as const;

export interface SkillsSectionProps {
  projectId: string;
  /**
   * Controlled active tab — the route passes `?tab=`. Omit it and the screen
   * keeps its own state, which is how the Customize overlay renders it.
   */
  kind?: SkillKind;
  onKindChange?: (kind: SkillKind) => void;
  /** Tab the uncontrolled screen opens on. */
  initialKind?: SkillKind;
  /** The persistent project section strip, rendered above the header. */
  navTabs?: ReactNode;
}

export function SkillsSection({
  projectId,
  kind: kindProp,
  onKindChange,
  initialKind = 'skill',
  navTabs,
}: SkillsSectionProps) {
  const [internalKind, setInternalKind] = useState<SkillKind>(initialKind);
  const kind = kindProp ?? internalKind;
  const meta = SKILL_KINDS[kind];

  const [query, setQuery] = useState('');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const selectKind = (next: SkillKind) => {
    // Clearing the selection matters: a skill path is not a command path, and
    // leaving it set would open the modal on a file the new tab cannot show.
    setSelectedPath(null);
    setInternalKind(next);
    onKindChange?.(next);
  };

  // Both probes run unconditionally — hooks cannot be called behind the tab.
  const canWriteSkill =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_SKILL_WRITE).allowed === true;
  const canWriteCommand =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_COMMAND_WRITE).allowed === true;
  const canWrite = kind === 'skill' ? canWriteSkill : canWriteCommand;

  const configure = useConfigureThread(projectId);

  const detailQuery = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    staleTime: 10_000,
    enabled: !!projectId,
  });

  const config = detailQuery.data?.config ?? null;
  const raw = kind === 'skill' ? config?.skills : config?.commands;
  const entities = useMemo(() => filterSkills(raw, ''), [raw]);
  const filtered = useMemo(() => filterSkills(raw, query), [raw, query]);

  const selected: SkillEntity | null = filtered.find((e) => e.path === selectedPath) ?? null;

  const isForbidden =
    detailQuery.isError && /403|forbidden/i.test((detailQuery.error as Error)?.message ?? '');

  const state: ProjectSectionState = (() => {
    if (detailQuery.isLoading) return 'loading';
    if (isForbidden) return 'forbidden';
    if (detailQuery.isError) return 'error';
    if (entities.length === 0) return 'empty';
    if (filtered.length === 0) return 'no-results';
    return 'ready';
  })();

  // The old header used MarketplaceSectionButton, whose entire onClick is
  // `customizeStore.setSection('marketplace')` — it never sets `open`. The
  // overlay IS still mounted (project-shell.tsx renders CustomizPanel), but
  // nothing opens it from here, so the button was a dead click that also
  // silently repointed where the overlay would next open.
  // Marketplace is a route now — link to it.
  const marketplaceLink = useMarketplaceEnabled(projectId) ? (
    <Button asChild size="sm" variant="secondary">
      <Link href={`/projects/${projectId}/marketplace`}>
        <Store className="size-3 shrink-0" />
        Marketplace
      </Link>
    </Button>
  ) : null;

  const newButton = canWrite ? (
    <Button
      type="button"
      size="sm"
      onClick={() => configure.start(newConfigPrompt(kind))}
      disabled={configure.pending}
    >
      {configure.pending ? <Loading className="size-4 shrink-0" /> : <Plus className="size-4" />}
      {meta.newLabel}
    </Button>
  ) : null;

  return (
    <>
      <ProjectSectionPage
        title="Skills"
        description="Reusable capabilities and slash commands your agents can call."
        docsHref={SKILLS_DOCS_HREF}
        navTabs={navTabs}
        width="wide"
        search={{ value: query, onChange: setQuery, placeholder: meta.searchPlaceholder }}
        action={
          <div className="flex items-center gap-1.5">
            {marketplaceLink}
            {newButton}
          </div>
        }
        filters={
          <div className="flex items-center gap-1">
            {SKILL_KIND_ORDER.map((option) => (
              <Button
                key={option}
                type="button"
                size="sm"
                variant={kind === option ? 'secondary' : 'ghost'}
                aria-current={kind === option ? 'page' : undefined}
                onClick={() => selectKind(option)}
                className="rounded-full"
              >
                {SKILL_KINDS[option].label}
              </Button>
            ))}
          </div>
        }
        state={state}
        forbiddenMessage="You don't have permission to read this repository."
        errorProps={{
          title: 'Failed to load',
          description:
            detailQuery.error instanceof Error
              ? detailQuery.error.message
              : `Could not load ${meta.noun}s.`,
        }}
        emptyProps={{
          icon: KIND_ICON[kind],
          title: meta.emptyTitle,
          description: meta.emptyDescription,
          action: newButton ?? undefined,
          secondaryAction: (
            <Button asChild variant="ghost" size="sm">
              <a href={SKILLS_DOCS_HREF} target="_blank" rel="noopener noreferrer">
                Docs
              </a>
            </Button>
          ),
        }}
        noResultsMessage={meta.noResultsMessage}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {filtered.map((entity) => (
            <SkillCard
              key={entity.path}
              kind={kind}
              entity={entity}
              onOpen={() => setSelectedPath(entity.path)}
              onEdit={
                canWrite
                  ? () => configure.start(editConfigPrompt(kind, entity.name, entity.path))
                  : undefined
              }
              editing={configure.pending}
            />
          ))}
        </div>
      </ProjectSectionPage>

      <SkillDetailModal
        projectId={projectId}
        kind={kind}
        entity={selected}
        open={!!selected}
        onOpenChange={(next) => {
          if (!next) setSelectedPath(null);
        }}
        canWrite={canWrite}
      />
    </>
  );
}

export default SkillsSection;
