'use client';

import { type ReactNode, useMemo, useState } from 'react';

import { HighlightedCode } from '@/components/markdown/code';
import { MarkdownWithFrontmatter } from '@/components/markdown/markdown-frontmatter';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { FileTree } from '@/components/ui/file-tree';
import Loading from '@/components/ui/loading';
import { Modal, ModalBody, ModalContent, ModalHeader, ModalTitle } from '@/components/ui/modal';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/features/layout/section/error-state';
import { useProjectAccountId } from '@/features/workspace/capabilities/shared/project-detail-query';
import { configEntitySourcePath } from '@/features/workspace/customize/sections/component/config-entity-source-path';
import {
  editConfigPrompt,
  useConfigureThread,
} from '@/features/workspace/customize/use-configure-thread';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import { listProjectFiles, readProjectFile } from '@kortix/sdk';
import { PencilSimpleIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';

import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import { buildFileTree, entityDirectory, isMarkdownPath, languageForPath } from './entity-files';

export type EntityKind = 'skill' | 'command' | 'agent';

export interface EntityDetailEntity {
  name: string;
  path: string;
  description: string | null;
}

export interface EntityDetailModalProps {
  projectId: string;
  /** The skill/command to show, or `null` when it has not resolved yet. `open`
   *  is driven by the SELECTION, not by this — see
   *  `shared/detail-selection.ts`. Selecting a different card while `open`
   *  stays `true` swaps the content in place (no close/reopen). */
  entity: EntityDetailEntity | null;
  kind: EntityKind;
  open: boolean;
  /** Open on a selection whose record has not arrived. Renders the shell so a
   *  refetch cannot blank the modal the user is working in. */
  isResolving?: boolean;
  /** Optional third column, right of the source pane — the entity's settings.
   *  Agents put their assignments + configuration cards here; skills and
   *  commands pass nothing and the modal stays two columns wide. */
  aside?: ReactNode;
  /** Status chips rendered inline after the title. Keep these to states worth
   *  flagging — a chip every entity carries is noise, and the source path
   *  already renders under the title as its own line. */
  meta?: ReactNode;
  onOpenChange: (open: boolean) => void;
}

const WRITE_ACTION: Record<EntityKind, string> = {
  skill: PROJECT_ACTIONS.PROJECT_SKILL_WRITE,
  command: PROJECT_ACTIONS.PROJECT_COMMAND_WRITE,
  agent: PROJECT_ACTIONS.PROJECT_AGENT_WRITE,
};

/**
 * Whether listing the entity's directory lists THAT ENTITY's files.
 *
 * A skill owns its directory — `.kortix/opencode/skills/<name>/SKILL.md` plus
 * its own scripts and templates — so the listing is exactly its file tree.
 * An agent is a single file in a SHARED directory
 * (`.kortix/opencode/agents/<name>.md`), so the same listing returns every
 * other agent in the project. Rendering that as "this agent's files" would let
 * a click swap the source pane to a different agent while the modal title,
 * the badges, and the configuration aside all still describe the first one.
 *
 * Single-file kinds therefore drop the file rail entirely: the modal is the
 * entity's own source plus whatever `aside` the caller supplies.
 */
const OWNS_ITS_DIRECTORY: Record<EntityKind, boolean> = {
  skill: true,
  command: true,
  agent: false,
};

/**
 * The skill/command/agent detail modal. Left to right: the file tree (for
 * directory-owning kinds only), the caller's optional settings `aside`, then
 * the selected file's source. Controls precede content — you read toward the
 * source, and the things you act on sit on the edge you start from. One
 * component for every kind; the differences are the write-permission action
 * probed and whether a file rail applies (`OWNS_ITS_DIRECTORY`).
 *
 * `EntityModalBody` is keyed on `entity.path` so switching cards while the
 * modal stays open resets its internal file selection instead of carrying
 * over a path that belongs to the previous entity — without remounting the
 * `Modal`/`ModalContent` itself, which would replay the open animation and
 * drop focus trap continuity.
 */
export function EntityDetailModal({
  projectId,
  entity,
  kind,
  open,
  isResolving = false,
  aside,
  meta,
  onOpenChange,
}: EntityDetailModalProps) {
  // A skill/command with no description renders no `ModalDescription`, so
  // Radix's Dialog can't find one to auto-associate via `aria-describedby`
  // and logs a dev-only "Missing Description" warning. Passing
  // `aria-describedby={undefined}` explicitly (as its own prop key, not just
  // omitting the attribute) is Radix's documented opt-out — the warning
  // message itself names this exact fix. Only applied when there truly is no
  // description; when one exists, `ModalDescription` wires up normally.
  const suppressDescriptionWarning = !entity?.description;

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent
        className="bg-popover space-y-0 lg:max-w-6xl"
        {...(suppressDescriptionWarning ? { 'aria-describedby': undefined } : {})}
      >
        {entity ? (
          <EntityModalBody
            key={entity.path}
            projectId={projectId}
            entity={entity}
            kind={kind}
            aside={aside}
            meta={meta}
          />
        ) : isResolving ? (
          <EntityModalSkeleton kind={kind} />
        ) : null}
      </ModalContent>
    </Modal>
  );
}

/**
 * The shell, while the selected path is being resolved against a config that
 * has not arrived. Shape-matched to `EntityModalBody` — same header, same
 * `lg:w-64` file rail — so the handover fills placeholders in place.
 *
 * `ModalTitle` is real, not decorative: Radix's Dialog requires an accessible
 * name for the whole time it is open, including this window.
 */
function EntityModalSkeleton({ kind }: { kind: EntityKind }) {
  return (
    <>
      <ModalHeader className="border-border/60 space-y-1 border-b pb-4">
        <ModalTitle className="sr-only">Loading {kind}</ModalTitle>
        <Skeleton className="h-5 w-48 rounded-sm" aria-hidden />
      </ModalHeader>

      <ModalBody className="max-h-[70vh] overflow-hidden p-0">
        <div className="flex min-h-0 flex-col lg:h-[70vh] lg:flex-row">
          {/* Same rail rule as the settled body — a placeholder file tree for a
              kind that never gets one is a column that vanishes on handover. */}
          {OWNS_ITS_DIRECTORY[kind] ? (
            <div className="border-border/60 shrink-0 space-y-1.5 border-b p-2 lg:h-full lg:w-64 lg:border-r lg:border-b-0">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-7 w-full rounded-md" />
              ))}
            </div>
          ) : null}
          <div className="min-w-0 flex-1 space-y-3 p-4">
            <Skeleton className="h-4 w-32 rounded-sm" />
            <Skeleton className="h-40 w-full rounded-md" />
          </div>
        </div>
      </ModalBody>
    </>
  );
}

function EntityModalBody({
  projectId,
  entity,
  kind,
  aside,
  meta,
}: {
  projectId: string;
  entity: EntityDetailEntity;
  kind: EntityKind;
  aside?: ReactNode;
  meta?: ReactNode;
}) {
  const configure = useConfigureThread(projectId);
  // `accountId` skips useProjectCan's own getProject and lets the IAM probe
  // run on the first render instead of waiting a round-trip for it.
  const accountId = useProjectAccountId(projectId);
  const canWrite = useProjectCan(projectId, WRITE_ACTION[kind], { accountId }).allowed === true;

  // The real repo path, with any manifest anchor stripped. Agents declared in
  // the manifest rather than as their own file carry one
  // (`kortix.yaml#agents.<name>`), and reading that verbatim is a 404 — the
  // source is `kortix.yaml` itself, which then renders as highlighted YAML
  // because `isMarkdownPath` is false for it. Skills and commands do not carry
  // an anchor in practice. Every file read and the tree's own paths are
  // relative to this.
  const sourcePath = configEntitySourcePath(entity.path);
  const dir = entityDirectory(entity.path);
  const hasFileRail = OWNS_ITS_DIRECTORY[kind];

  const [selectedPath, setSelectedPath] = useState(sourcePath);

  // Not fetched at all for a single-file kind: the listing would be every
  // sibling entity's source, and nothing renders it (see OWNS_ITS_DIRECTORY).
  const filesQuery = useQuery({
    queryKey: ['entity-files', projectId, dir],
    queryFn: () => listProjectFiles(projectId, { path: dir }),
    enabled: hasFileRail && dir !== '',
    staleTime: 30_000,
  });

  const nodes = useMemo(
    () => buildFileTree(filesQuery.data?.map((f) => f.path) ?? [], dir),
    [filesQuery.data, dir],
  );

  const fileQuery = useQuery({
    queryKey: ['entity-file-content', projectId, selectedPath],
    queryFn: () => readProjectFile(projectId, selectedPath),
    staleTime: 30_000,
  });

  // The one write affordance, placed by layout: at the foot of the file rail
  // when there is one, otherwise at the top of the settings aside. Built once
  // so the two placements cannot drift into two different controls.
  //
  // The click does not send the prompt directly — `configure.start` opens a
  // whole new chat, which is a bigger commitment than a pencil icon implies,
  // so an AlertDialog confirms first. The dialog nests inside this modal's
  // React tree on purpose: rendered as a sibling, Radix would read every
  // click in the alert as an outside-click and dismiss the modal underneath
  // (see components/ui/alert-dialog.tsx).
  const editButton = canWrite ? (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="secondary"
          size="sm"
          className="w-full justify-start border"
          disabled={configure.pending}
        >
          {configure.pending ? (
            <Loading className="text-foreground size-3.5 shrink-0" />
          ) : (
            <PencilSimpleIcon className="size-3.5 shrink-0" />
          )}
          Edit source
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Are you sure you want to send?</AlertDialogTitle>
          <AlertDialogDescription>
            This starts a new chat to edit {entity.name}'s source.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => configure.start(editConfigPrompt(kind, entity.name, entity.path))}
          >
            Send
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  ) : null;

  // The aside earns its column when it holds something: the caller's settings,
  // or — for a single-file kind, which has no rail to host it — the edit
  // action. Without this an agent modal viewed by a reader with no write
  // permission would render an empty 320px column.
  const showAside = Boolean(aside) || (!hasFileRail && editButton !== null);

  const fileRail = (
    <div className="border-border/60 flex shrink-0 flex-col border-b p-2 lg:h-full lg:w-64 lg:overflow-hidden lg:border-r lg:border-b-0">
      {/* The tree scrolls INSIDE the rail, not the rail itself.
          `FadedScrollArea` is the scroller — do NOT wrap its children in
          another `overflow-y-auto` div, or the nested scroller wins and the
          edge fades never see a scroll event. `rootClassName` overrides the
          root's default `h-full`: `min-h-0 flex-1` lets it shrink below its
          content height so a long tree (a skill with many files) cannot
          push the edit action below the fold — the same pattern as the easy
          panel's output/context cards. Below `lg` the rail has no fixed
          height, so this grows with content and the modal body scrolls as
          before. `fadeColor` matches the rail's surface (`bg-popover` on
          `ModalContent`), not the `from-sidebar` default. */}
      <FadedScrollArea
        fadeColor="from-popover"
        rootClassName="h-auto min-h-0 flex-1"
        className="overscroll-contain"
      >
        <FileTree title="Files">
          {nodes.length > 0 ? (
            <nav aria-label={`${entity.name} files`} className="space-y-0.5">
              {nodes.map((node) => (
                <button
                  key={node.path}
                  type="button"
                  onClick={() => setSelectedPath(node.path)}
                  aria-current={node.path === selectedPath}
                  style={{ paddingLeft: 8 + node.depth * 12 }}
                  className={cn(
                    'block w-full truncate rounded-md py-1.5 pr-2 text-left text-xs transition-colors',
                    'focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none',
                    node.path === selectedPath
                      ? 'bg-primary/[0.06] text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {node.name}
                </button>
              ))}
            </nav>
          ) : null}
        </FileTree>

        {filesQuery.isError ? (
          <p className="text-muted-foreground mt-4 text-xs text-pretty">
            Couldn’t list the other files here.{' '}
            <button
              type="button"
              onClick={() => void filesQuery.refetch()}
              className="text-foreground underline underline-offset-2"
            >
              Retry
            </button>
          </p>
        ) : null}
      </FadedScrollArea>

      {editButton ? <div className="shrink-0 pt-4">{editButton}</div> : null}
    </div>
  );

  return (
    <>
      {/* Name and its status chips share one line — the chips qualify the name,
          so stacking them read as a second, unlabeled row. The source path sits
          under it as data rather than as a chip: a file path is a value, and
          putting one in a Badge was the "kortix.yaml" pill this replaces.
          `pr-10` clears the close button (absolute, top-3 right-3, size-8). */}
      <ModalHeader className="border-border/60 space-y-1 border-b pr-10 pb-4">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <ModalTitle className="min-w-0 truncate">{entity.name}</ModalTitle>
          {meta}
        </div>
      </ModalHeader>

      <ModalBody className="max-h-[70vh] overflow-hidden p-0">
        <div className="flex min-h-0 flex-col overflow-y-auto lg:h-[70vh] lg:flex-row lg:overflow-hidden">
          {hasFileRail ? fileRail : null}

          {/* Left — the entity's settings, when it has any. Scrolls itself so a
              tall configuration card never pushes the source pane's own scroll
              onto the modal. Ahead of the source: it is the thing you act on,
              and actions belong on the edge you read toward first. */}
          {showAside ? (
            <aside className="border-border/60 flex h-full min-h-0 shrink-0 flex-col justify-between space-y-3 border-b p-4 lg:h-full lg:min-h-0 lg:w-80 lg:overflow-y-auto lg:border-r lg:border-b-0">
              {aside}
              <div className="mt-auto pt-4">{hasFileRail ? null : editButton}</div>
            </aside>
          ) : null}

          {/* Right — the selected file's source. */}
          <div className="bg-popover min-w-0 flex-1 overflow-hidden overflow-y-auto">
            <EntityFilePane
              key={selectedPath}
              path={selectedPath}
              content={fileQuery.data?.content}
              isLoading={fileQuery.isLoading}
              isError={fileQuery.isError}
              error={fileQuery.error}
              onRetry={() => fileQuery.refetch()}
            />
          </div>
        </div>
      </ModalBody>
    </>
  );
}

function EntityFilePane({
  path,
  content,
  isLoading,
  isError,
  error,
  onRetry,
}: {
  path: string;
  content: string | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <>
      {isLoading ? (
        <div className="space-y-2.5 p-4">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-11/12" />
          <Skeleton className="h-4 w-10/12" />
          <Skeleton className="h-4 w-9/12" />
          <Skeleton className="h-4 w-full" />
        </div>
      ) : isError ? (
        <div className="p-4">
          <ErrorState
            size="sm"
            title="Couldn't load file"
            description={
              error instanceof Error
                ? error.message
                : 'You may not have permission to read this file.'
            }
            action={
              <Button variant="outline" size="sm" onClick={onRetry}>
                Retry
              </Button>
            }
          />
        </div>
      ) : isMarkdownPath(path) ? (
        <div className="p-4">
          <MarkdownWithFrontmatter content={content ?? ''} />
        </div>
      ) : (
        <pre
          className={cn(
            'overflow-x-auto p-4',
            'text-foreground font-mono text-sm leading-[1.65]',
            '[&_code]:border-none [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit',
            '[&_.shiki]:!bg-transparent [&_span]:border-none [&_span]:!bg-transparent [&_span]:outline-none',
          )}
        >
          <HighlightedCode code={content ?? ''} language={languageForPath(path)} />
        </pre>
      )}
    </>
  );
}
