'use client';

/**
 * What a subproject owns, beside the composer: Instructions, Context,
 * Scheduled, and (for a manager) Access — one flat panel of stacked sections
 * on the right of the page (user, 2026-09-06: "like Claude's project page,
 * not a drawer"). A section with something in it opens on load; an empty one
 * shows its one-line invitation and a `+` that opens the editor. The editors
 * are the same ones the sheet used (`subproject-sections.tsx`).
 */
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { AgentPeopleSection } from '@/features/workspace/capabilities/agents/agent-people-section';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import { listProjectTriggers, type Subproject } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { CaretDownIcon, PlusIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';

import {
  ContextBody,
  InstructionsBody,
  ScheduledBody,
  firstLine,
} from './subproject-sections';
import { triggersForSubproject } from './subprojects-data';

export function SubprojectAside({
  projectId,
  subproject,
  canManage,
}: {
  projectId: string;
  subproject: Subproject;
  canManage: boolean;
}) {
  const canManageMembers =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE).allowed === true;
  const triggersQuery = useQuery({
    queryKey: qk.project.triggers(projectId),
    queryFn: () => listProjectTriggers(projectId),
    ...contract('config'),
  });
  const triggers = useMemo(
    () => triggersForSubproject(triggersQuery.data?.triggers ?? [], subproject.slug),
    [triggersQuery.data, subproject.slug],
  );
  const files = subproject.context.length;

  return (
    // Flat, in-flow panel: border, no shadow (design system, "Elevation").
    // The seams between sections are the only lines inside it.
    <div className="bg-popover rounded-md border">
      <AsideSection
        title="Instructions"
        empty={!subproject.instructions}
        summary={
          firstLine(subproject.instructions) ?? 'Tell the agent how to work here.'
        }
        canOpen={canManage || Boolean(subproject.instructions)}
      >
        <InstructionsBody projectId={projectId} subproject={subproject} canManage={canManage} />
      </AsideSection>
      <AsideSection
        title="Context"
        empty={files === 0}
        summary={
          files === 0
            ? 'Files the agent reads first.'
            : `${files} ${files === 1 ? 'file' : 'files'} the agent reads first.`
        }
        canOpen={canManage || files > 0}
      >
        <ContextBody projectId={projectId} subproject={subproject} canManage={canManage} />
      </AsideSection>
      <AsideSection
        title="Scheduled"
        empty={triggers.length === 0}
        summary={
          triggersQuery.isLoading
            ? '…'
            : triggers.length === 0
              ? 'Work that runs on its own.'
              : `${triggers.length} ${triggers.length === 1 ? 'schedule' : 'schedules'} run on their own.`
        }
        canOpen={canManage || triggers.length > 0}
      >
        <ScheduledBody
          projectId={projectId}
          slug={subproject.slug}
          triggers={triggers}
          loading={triggersQuery.isLoading}
        />
      </AsideSection>
      {canManageMembers ? (
        <AsideSection title="Access" empty={false} summary="Who may use this subproject." canOpen>
          <div className="[&_section]:border-0 [&_section]:bg-transparent [&_section>div:first-child]:hidden [&_section>div]:px-0">
            <AgentPeopleSection
              projectId={projectId}
              agentName={subproject.slug}
              resourceType="subproject"
            />
          </div>
        </AsideSection>
      ) : null}
    </div>
  );
}

/**
 * One section of the panel. The header is the disclosure trigger — its
 * accessible name is exactly the title, so the summary and the glyph live
 * beside it, not inside it. Opens on load when it holds something.
 */
function AsideSection({
  title,
  summary,
  empty,
  canOpen,
  children,
}: {
  title: string;
  /** One line under the title: what is in here, or the invitation when empty. */
  summary: string;
  /** Mutes the summary: a placeholder, not a value. */
  empty: boolean;
  /** A reader with nothing to see gets no trigger at all. */
  canOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(!empty);
  return (
    <Disclosure
      open={open && canOpen}
      onOpenChange={setOpen}
      className="border-border group/aside border-t first:border-t-0"
    >
      <div className="flex items-start gap-3 px-4 pt-4 pb-3">
        <div className="min-w-0 flex-1">
          <DisclosureTrigger>
            <button
              type="button"
              disabled={!canOpen}
              className={cn(
                'text-foreground -mx-1 rounded-sm px-1 text-left text-sm font-medium',
                'focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none',
                canOpen ? 'cursor-pointer' : 'cursor-default',
              )}
            >
              {title}
            </button>
          </DisclosureTrigger>
          <p
            className={cn(
              'mt-0.5 truncate text-xs',
              empty ? 'text-muted-foreground/70' : 'text-muted-foreground',
            )}
          >
            {summary}
          </p>
        </div>
        {canOpen ? (
          // The same toggle as the title, drawn as the glyph the state
          // invites: `+` on an empty section, a caret once it holds
          // something. Decorative — the title already carries the name.
          <DisclosureTrigger>
            <button
              type="button"
              tabIndex={-1}
              aria-hidden
              className="text-muted-foreground hover:text-foreground hover:bg-hover flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors"
            >
              {empty && !open ? (
                <PlusIcon className="size-4" />
              ) : (
                <CaretDownIcon
                  className={cn('size-4 transition-transform', open && 'rotate-180')}
                />
              )}
            </button>
          </DisclosureTrigger>
        ) : null}
      </div>
      <DisclosureContent>
        <div className="px-4 pb-4">{children}</div>
      </DisclosureContent>
    </Disclosure>
  );
}
