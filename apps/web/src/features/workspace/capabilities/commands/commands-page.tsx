'use client';

import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import Loading from '@/components/ui/loading';
import { EmptyState } from '@/features/layout/section/empty-state';
import {
  newConfigPrompt,
  useConfigureThread,
} from '@/features/workspace/customize/use-configure-thread';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { CommandIcon, MagnifyingGlassIcon, PlusIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';

import { CapabilityPageShell } from '@/features/workspace/capabilities/shared/capability-page-shell';
import { CatalogCard } from '@/features/workspace/capabilities/shared/catalog/catalog-card';
import { catalogEmptyKind } from '@/features/workspace/capabilities/shared/catalog/catalog-empty';
import { CatalogNoMatch } from '@/features/workspace/capabilities/shared/catalog/catalog-empty-state';
import { CatalogGrid } from '@/features/workspace/capabilities/shared/catalog/catalog-grid';
import { detailSelection } from '@/features/workspace/capabilities/shared/detail-selection';
import { EntityDetailModal } from '@/features/workspace/capabilities/shared/entity/entity-modal';
import {
  projectDetailQuery,
  useProjectAccountId,
} from '@/features/workspace/capabilities/shared/project-detail-query';
import { filterCommands } from './command-filter';

/**
 * /projects/[id]/commands — the standalone Commands catalog. Reads
 * `config.commands` off the same `['project-detail', projectId]` query
 * `ConfigEntityView` (Customize) reads, so the two surfaces cannot disagree
 * about what a project's commands are.
 *
 * Same shape as `SkillsPage`, minus the scope filter: commands have no
 * `kortix-*` family to split on, so there is no `filters` slot at all here.
 *
 * Card click opens `EntityDetailModal` (file tree + rendered markdown) for
 * the clicked command. `selectedPath` is looked up against the unfiltered
 * `commands` list, not `filtered` — so typing into search while the modal is
 * open can't yank it shut out from under the user.
 * "New" in the header and "Create a command" in the empty state are the SAME
 * control under two labels (`createButton`), reusing `useConfigureThread` /
 * `newConfigPrompt('command')` unchanged — creation still happens by an agent
 * editing the repo on a branch, not a form here.
 */
export function CommandsPage({ projectId }: { projectId: string }) {
  // `accountId` skips useProjectCan's own getProject and lets the IAM probe
  // run on the first render instead of waiting a round-trip for it.
  const accountId = useProjectAccountId(projectId);
  const canWrite =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_COMMAND_WRITE, { accountId }).allowed === true;
  const configure = useConfigureThread(projectId);

  const [query, setQuery] = useState('');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const detailQuery = useQuery(projectDetailQuery(projectId));

  const commands = useMemo(() => {
    const raw = detailQuery.data?.config.commands;
    return Array.isArray(raw) ? raw : [];
  }, [detailQuery.data]);

  const filtered = useMemo(() => filterCommands(commands, { query }), [commands, query]);

  // Unfiltered lookup (see the component doc comment above) — deliberately
  // not `filtered.find(...)`.
  // `open` follows `selectedPath` alone — see `shared/detail-selection.ts`.
  // Deriving it from this lookup meant any blip in `detailQuery` (a failed
  // refetch, or a background agent renaming the path in kortix.yaml) closed
  // the modal while the user was reading a file inside it.
  const detail = detailSelection({
    selection: selectedPath,
    record: commands.find((command) => command.path === selectedPath),
    isSuccess: detailQuery.isSuccess,
  });

  // The one honest auto-close: the config came back and this command is not in
  // it, so it really was deleted or renamed.
  useEffect(() => {
    if (detail.isMissing) setSelectedPath(null);
  }, [detail.isMissing]);

  // `null` = render the grid. Otherwise which "nothing to show" copy applies:
  // genuinely zero commands vs. commands exist but this search hid all of
  // them. Telling the user "No commands yet" in the second case is false and
  // points at the wrong fix (clear the search, not create a command).
  const emptyKind = catalogEmptyKind(commands.length, filtered.length);

  // One control, two labels. The header has a title beside it and can be terse;
  // the empty state is the whole screen and has to name what it creates. Both
  // start the same configure thread, so they cannot drift apart.
  const createButton = (label: string) =>
    canWrite ? (
      <Button
        size="sm"
        variant="secondary"
        onClick={() => configure.start(newConfigPrompt('command'))}
        disabled={configure.pending}
      >
        {configure.pending ? (
          <Loading className="size-4 shrink-0" />
        ) : (
          <PlusIcon className="size-4" />
        )}
        {label}
      </Button>
    ) : null;

  return (
    <CapabilityPageShell
      title="Commands"
      description="Slash actions people and agents can run in a session."
      action={createButton('New')}
      search={
        <InputGroupSearch>
          <InputGroupSearchIcon>
            <MagnifyingGlassIcon />
          </InputGroupSearchIcon>
          <InputGroupSearchInput
            placeholder="Search commands"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            variant="popover"
          />
          <InputGroupSearchClear onClick={() => setQuery('')} />
        </InputGroupSearch>
      }
    >
      <CatalogGrid
        isLoading={detailQuery.isLoading}
        isError={detailQuery.isError}
        onRetry={() => detailQuery.refetch()}
        isEmpty={emptyKind !== null}
        empty={
          emptyKind === 'no-match' ? (
            <CatalogNoMatch query={query} />
          ) : (
            <EmptyState
              icon={CommandIcon}
              size="sm"
              title="No commands yet"
              description="Create a command to give agents reusable slash actions."
              // The description invites an action; without this the screen was
              // a dead end and the only way to create anything was the header
              // button the user has already scrolled past.
              action={createButton('Create a command')}
            />
          )
        }
      >
        {filtered.map((command) => (
          <CatalogCard
            key={command.path}
            title={command.name}
            description={command.description}
            onClick={() => setSelectedPath(command.path)}
          />
        ))}
      </CatalogGrid>
      <EntityDetailModal
        projectId={projectId}
        entity={detail.record}
        kind="command"
        open={detail.open}
        isResolving={detail.isResolving}
        onOpenChange={(next) => {
          if (!next) setSelectedPath(null);
        }}
      />
    </CapabilityPageShell>
  );
}
