'use client';

import { useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import Loading from '@/components/ui/loading';
import { Tabs, TabsListCompact, TabsTriggerCompact } from '@/components/ui/tabs';
import { EmptyState } from '@/features/layout/section/empty-state';
import {
  newConfigPrompt,
  useConfigureThread,
} from '@/features/workspace/customize/use-configure-thread';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { getProjectDetail } from '@kortix/sdk';
import {
  MagnifyingGlassIcon,
  PlusIcon,
  SparkleIcon,
} from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';

import { CapabilityPageShell } from '../capability-page-shell';
import { CatalogCard } from '../catalog-card';
import { CatalogGrid } from '../catalog-grid';
import { EntityDetailModal } from './entity-modal';
import { catalogEmptyKind, filterSkills, type SkillScope } from './skill-scope';

type ScopeFilter = SkillScope | 'all';

const SCOPE_FILTERS: ReadonlyArray<{ value: ScopeFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'project', label: 'Project' },
  { value: 'kortix', label: 'Kortix' },
];

/**
 * /projects/[id]/skills — the standalone Skills catalog. Reads
 * `config.skills` off the same `['project-detail', projectId]` query
 * `ConfigEntityView` (Customize) reads, so the two surfaces cannot disagree
 * about what a project's skills are.
 *
 * Card click opens `EntityDetailModal` (file tree + rendered markdown) for
 * the clicked skill. `selectedPath` is looked up against the unfiltered
 * `skills` list, not `filtered` — so typing into search while the modal is
 * open can't yank it shut out from under the user.
 * "New" and the empty state's create path reuse `useConfigureThread` /
 * `newConfigPrompt('skill')` unchanged — creation still happens by an agent
 * editing the repo on a branch, not a form here.
 */
export function SkillsPage({ projectId }: { projectId: string }) {
  const canWrite = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_SKILL_WRITE).allowed === true;
  const configure = useConfigureThread(projectId);

  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<ScopeFilter>('all');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const detailQuery = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    staleTime: 10_000,
  });

  const skills = useMemo(() => {
    const raw = detailQuery.data?.config.skills;
    return Array.isArray(raw) ? raw : [];
  }, [detailQuery.data]);

  const scopeArg = scope === 'all' ? null : scope;
  const filtered = useMemo(
    () => filterSkills(skills, { scope: scopeArg, query }),
    [skills, scopeArg, query],
  );

  const counts = useMemo(
    () => ({
      all: filterSkills(skills, { scope: null, query }).length,
      project: filterSkills(skills, { scope: 'project', query }).length,
      kortix: filterSkills(skills, { scope: 'kortix', query }).length,
    }),
    [skills, query],
  );

  // Unfiltered lookup (see the component doc comment above) — deliberately
  // not `filtered.find(...)`.
  const selectedSkill = useMemo(
    () => skills.find((skill) => skill.path === selectedPath) ?? null,
    [skills, selectedPath],
  );

  // `null` = render the grid. Otherwise which "nothing to show" copy applies:
  // genuinely zero skills vs. skills exist but this filter/search hid all of
  // them. Telling the user "No skills yet" in the second case is false and
  // points at the wrong fix (clear the filter, not create a skill).
  const emptyKind = catalogEmptyKind(skills.length, filtered.length);
  const scopeLabel = SCOPE_FILTERS.find((filter) => filter.value === scope)?.label ?? 'All';

  const newButton = canWrite ? (
    <Button
      size="sm"
      variant="secondary"
      onClick={() => configure.start(newConfigPrompt('skill'))}
      disabled={configure.pending}
    >
      {configure.pending ? (
        <Loading className="size-4 shrink-0" />
      ) : (
        <PlusIcon className="size-4" />
      )}
      New
    </Button>
  ) : null;

  return (
    <CapabilityPageShell
      title="Skills"
      description="Reusable instructions your agents load on demand."
      action={newButton}
      search={
        <InputGroupSearch>
          <InputGroupSearchIcon>
            <MagnifyingGlassIcon />
          </InputGroupSearchIcon>
          <InputGroupSearchInput
            placeholder="Search skills"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            variant="popover"
          />
          <InputGroupSearchClear onClick={() => setQuery('')} />
        </InputGroupSearch>
      }
      filters={
        <Tabs value={scope} onValueChange={(value) => setScope(value as ScopeFilter)}>
          <TabsListCompact>
            {SCOPE_FILTERS.map((filter) => (
              <TabsTriggerCompact key={filter.value} value={filter.value}>
                {filter.label}
                <Badge variant="secondary" size="sm">
                  {counts[filter.value]}
                </Badge>
              </TabsTriggerCompact>
            ))}
          </TabsListCompact>
        </Tabs>
      }
    >
      <CatalogGrid
        isLoading={detailQuery.isLoading}
        isError={detailQuery.isError}
        onRetry={() => detailQuery.refetch()}
        isEmpty={emptyKind !== null}
        empty={
          emptyKind === 'no-match' ? (
            <p className="text-muted-foreground px-3 py-6 text-center text-xs">
              {query.trim() ? (
                <>
                  No matches for <span className="text-foreground font-mono">{query}</span>.
                </>
              ) : (
                <>No matches in {scopeLabel}.</>
              )}
            </p>
          ) : (
            <EmptyState
              icon={SparkleIcon}
              size="sm"
              title="No skills yet"
              description="Create a skill to give agents reusable capabilities."
              action={
                <Button asChild variant="ghost" size="sm" className="gap-1.5">
                  <a href="https://opencode.ai/docs/skills/" target="_blank" rel="noopener noreferrer">
                    Docs
                  </a>
                </Button>
              }
            />
          )
        }
      >
        {filtered.map((skill) => (
          <CatalogCard
            key={skill.path}
            leading={
              <span className="bg-primary/[0.06] flex size-9 shrink-0 items-center justify-center rounded-sm">
                <SparkleIcon className="size-5" />
              </span>
            }
            title={skill.name}
            description={skill.description}
            onClick={() => setSelectedPath(skill.path)}
          />
        ))}
      </CatalogGrid>
      <EntityDetailModal
        projectId={projectId}
        entity={selectedSkill}
        kind="skill"
        open={selectedSkill !== null}
        onOpenChange={(next) => {
          if (!next) setSelectedPath(null);
        }}
      />
    </CapabilityPageShell>
  );
}
