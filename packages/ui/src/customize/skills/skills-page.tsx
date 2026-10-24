'use client';

import { NewEntityMenu } from '../shared/new-entity-menu';
import { useTranslations as useI18nTranslations } from '../../i18n';
import { useMemo, useRef, useState } from 'react';

import { Button } from '../../primitives/button';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '../../primitives/input-group';
import { Tabs, TabsList, TabsTrigger } from '../../primitives/tabs';
import { EmptyState } from '../../primitives/empty-state';
import {
  newConfigPrompt,
  useConfigureThread,
} from '../use-configure-thread';
import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { useProjectCan } from '../../internal/lib/use-project-can';
import { getProjectDetail } from '@kortix/sdk';
import { contract, qk, useProjectAccountId } from '@kortix/sdk/react';
import { MagnifyingGlassIcon, SparkleIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';

import { type AgentGrant, GrantModeTabs, type ResourceScope } from '../shared/agent-resource-scope';
import { CapabilityPageShell } from '../shared/capability-page-shell';
import { CatalogCard } from '../shared/catalog/catalog-card';
import { catalogEmptyKind } from '../shared/catalog/catalog-empty';
import {
  CatalogEmptyNote,
  CatalogNoMatch,
} from '../shared/catalog/catalog-empty-state';
import { CatalogGrid } from '../shared/catalog/catalog-grid';
import { detailSelection } from '../shared/detail-selection';
import { EntityDetailModal } from '../shared/entity/entity-modal';
import { NewSkillModal } from './new-skill-modal';
import { filterSkills, type SkillScope } from './skill-scope';
import { useSlashFocus } from '../../internal/hooks';

type ScopeFilter = SkillScope | 'all';

const SCOPE_FILTERS: ReadonlyArray<{ value: ScopeFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'project', label: 'Project' },
  { value: 'kortix', label: 'Kortix' },
];

/**
 * /projects/[id]/skills — the standalone Skills catalog. Reads
 * `config.skills` off the same `qk.project.detail(id)` query
 * Customize reads, so the two surfaces cannot disagree
 * about what a project's skills are.
 *
 * Card click opens `EntityDetailModal` (file tree + rendered markdown) for
 * the clicked skill. `selectedPath` is looked up against the unfiltered
 * `skills` list, not `filtered` — so typing into search while the modal is
 * open can't yank it shut out from under the user.
 * "New" in the header and "Create a skill" in the empty state are the SAME
 * control under two labels (`createButton`), with two ways in:
 * "Create in chat" reuses `useConfigureThread` / `newConfigPrompt('skill')`
 * (an agent edits the repo on a branch — needs a model), and "Create with a
 * form" commits the skill straight onto the default branch, no model needed
 * — on a fresh free account the chat path was a dead end ("requires a paid
 * plan", no model to pick). The empty state adds Docs as its secondary,
 * which is all a reader without write permission gets.
 */
export function SkillsPage({
  projectId,
  surface = { kind: 'global' },
  grant,
}: {
  projectId: string;
  /** `global` (default) is the project catalogue; `agent` scopes the same page
   *  to one agent and turns each skill card into a grant control. */
  surface?: ResourceScope;
  /** Required in `agent` scope: the agent's `skills` grant. */
  grant?: AgentGrant;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const agentScoped = surface.kind === 'agent' && grant !== undefined;
  // `accountId` skips useProjectCan's own getProject and lets the IAM probe
  // run on the first render instead of waiting a round-trip for it.
  const accountId = useProjectAccountId(projectId);
  const canWrite =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_SKILL_WRITE, { accountId }).allowed === true;
  const configure = useConfigureThread(projectId);

  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  useSlashFocus(searchRef);
  const [scope, setScope] = useState<ScopeFilter>('all');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  const detailQuery = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    ...contract('config'),
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

  // Unfiltered lookup (see the component doc comment above) — deliberately
  // not `filtered.find(...)`.
  // `open` follows `selectedPath` alone — see `shared/detail-selection.ts`.
  // Deriving it from this lookup meant any blip in `detailQuery` (a failed
  // refetch, or a background agent renaming the path in kortix.yaml) closed
  // the modal while the user was reading a file inside it.
  const detail = detailSelection({
    selection: selectedPath,
    record: skills.find((skill) => skill.path === selectedPath),
    isSuccess: detailQuery.isSuccess,
  });

  // The one honest auto-close: the config came back and this skill is not in
  // it, so it really was deleted or renamed.
  if (detail.isMissing) setSelectedPath(null);

  // `null` = render the grid. Otherwise which "nothing to show" copy applies:
  // genuinely zero skills vs. skills exist but this filter/search hid all of
  // them. Telling the user "No skills yet" in the second case is false and
  // points at the wrong fix (clear the filter, not create a skill).
  const emptyKind = catalogEmptyKind(skills.length, filtered.length);
  const scopeLabel = SCOPE_FILTERS.find((filter) => filter.value === scope)?.label ?? 'All';

  // One control, two labels. The header has a title beside it and can be terse;
  // the empty state is the whole screen and has to name what it creates. Both
  // offer the same two ways in, so they cannot drift apart.
  // The header button is `h-9`, the height of the `size="sm"` search input
  // beside it. The empty state keeps `sm` to match its `sm` docs link.
  const createButton = (label: string, size?: 'sm') =>
    canWrite ? (
      <NewEntityMenu
        label={label}
        size={size}
        pending={configure.pending}
        onChat={() => configure.start(newConfigPrompt('skill'))}
        manual={{
          label: tI18nComplete.raw('texta38668224f1a'),
          description: tI18nComplete.raw('textedac6130dac7'),
          onSelect: () => setFormOpen(true),
        }}
      />
    ) : null;

  return (
    <CapabilityPageShell
      title={tI18nComplete.raw('text66d0f523a379')}
      description={
        agentScoped ? 'Choose which skills this agent can use.' : tI18nComplete.raw('text000c02c11c7a')
      }
      action={createButton('New')}
      search={
        <InputGroupSearch>
          <InputGroupSearchIcon>
            <MagnifyingGlassIcon />
          </InputGroupSearchIcon>
          <InputGroupSearchInput
            ref={searchRef}
            placeholder={tI18nComplete.raw('text76c02b7eddca')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            variant="popover"
            size="sm"
          />
          <InputGroupSearchClear onClick={() => setQuery('')} />
        </InputGroupSearch>
      }
      filters={
        <>
          {agentScoped && grant ? (
            <GrantModeTabs grant={grant} label="Skill access for this agent" />
          ) : null}
          <Tabs value={scope} onValueChange={(value) => setScope(value as ScopeFilter)}>
            <TabsList>
              {SCOPE_FILTERS.map((filter) => (
                <TabsTrigger key={filter.value} value={filter.value}>
                  {filter.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </>
      }
    >
      <CatalogGrid
        isLoading={detailQuery.isLoading}
        isError={detailQuery.isError}
        onRetry={() => detailQuery.refetch()}
        isEmpty={emptyKind !== null}
        empty={
          emptyKind === 'no-match' ? (
            query.trim() ? (
              <CatalogNoMatch query={query} />
            ) : (
              <CatalogEmptyNote>
                {tI18nComplete.raw('textdc5255461795')}
                {scopeLabel}.
              </CatalogEmptyNote>
            )
          ) : (
            <EmptyState
              icon={SparkleIcon}
              size="sm"
              title={tI18nComplete.raw('text32ae9b80f832')}
              description={tI18nComplete.raw('text031b8fd1f46a')}
              // The copy invites an action, so the action is here — not only in
              // the header. Docs stays as the secondary, for the reader who has
              // no write permission and gets no primary at all.
              action={createButton('Create a skill', 'sm')}
              secondaryAction={
                <Button asChild variant="ghost" size="sm" className="gap-1.5">
                  <a
                    href="/docs/project/agents#skills"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {tI18nComplete.raw('text7af023c43013')}
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
            title={skill.name}
            description={skill.description}
            onClick={() => setSelectedPath(skill.path)}
            select={
              agentScoped && grant
                ? {
                    checked: grant.isGranted(skill.name),
                    disabled: grant.mode !== 'specific',
                    onCheckedChange: () => grant.toggle(skill.name),
                    label: `Grant ${skill.name} to this agent`,
                  }
                : undefined
            }
          />
        ))}
      </CatalogGrid>
      <EntityDetailModal
        projectId={projectId}
        entity={detail.record}
        kind="skill"
        removable
        open={detail.open}
        isResolving={detail.isResolving}
        onOpenChange={(next) => {
          if (!next) setSelectedPath(null);
        }}
      />
      <NewSkillModal projectId={projectId} open={formOpen} onOpenChange={setFormOpen} />
    </CapabilityPageShell>
  );
}
