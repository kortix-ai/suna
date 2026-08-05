'use client';

import { useMemo, useState } from 'react';

import { HighlightedCode } from '@/components/markdown/code';
import { MarkdownWithFrontmatter } from '@/components/markdown/markdown-frontmatter';
import { Button } from '@/components/ui/button';
import { FileTree } from '@/components/ui/file-tree';
import Loading from '@/components/ui/loading';
import { Modal, ModalBody, ModalContent, ModalHeader, ModalTitle } from '@/components/ui/modal';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/features/layout/section/error-state';
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

import { buildFileTree, entityDirectory, isMarkdownPath, languageForPath } from './entity-files';

export type EntityKind = 'skill' | 'command';

export interface EntityDetailEntity {
  name: string;
  path: string;
  description: string | null;
}

export interface EntityDetailModalProps {
  projectId: string;
  /** The skill/command to show. `null` while nothing is selected — callers
   *  should keep `open` false in that case; the modal renders nothing until
   *  both are set. Selecting a different card while `open` stays `true` swaps
   *  the content in place (no close/reopen). */
  entity: EntityDetailEntity | null;
  kind: EntityKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const WRITE_ACTION: Record<EntityKind, string> = {
  skill: PROJECT_ACTIONS.PROJECT_SKILL_WRITE,
  command: PROJECT_ACTIONS.PROJECT_COMMAND_WRITE,
};

/**
 * The skill/command detail modal: source path, edit action, and file tree on
 * the left; the selected file's content in a filename-headed card on the
 * right. One component for both kinds — the only difference is the
 * write-permission action probed and the `/name` slash treatment in the
 * title.
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
        className="space-y-0 lg:max-w-7xl bg-popover"
        {...(suppressDescriptionWarning ? { 'aria-describedby': undefined } : {})}
      >
        {entity ? (
          <EntityModalBody key={entity.path} projectId={projectId} entity={entity} kind={kind} />
        ) : null}
      </ModalContent>
    </Modal>
  );
}

function EntityModalBody({
  projectId,
  entity,
  kind,
}: {
  projectId: string;
  entity: EntityDetailEntity;
  kind: EntityKind;
}) {
  const configure = useConfigureThread(projectId);
  const canWrite = useProjectCan(projectId, WRITE_ACTION[kind]).allowed === true;

  // The real repo path, with any manifest anchor (`kortix.yaml#agents.x`)
  // stripped — skills/commands never carry one in practice, but this stays
  // correct if that ever changes. Every file read and the tree's own paths
  // are relative to this.
  const sourcePath = configEntitySourcePath(entity.path);
  const dir = entityDirectory(entity.path);

  const [selectedPath, setSelectedPath] = useState(sourcePath);

  const filesQuery = useQuery({
    queryKey: ['entity-files', projectId, dir],
    queryFn: () => listProjectFiles(projectId, { path: dir }),
    enabled: dir !== '',
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

  const isCommand = kind === 'command';

  return (
    <>
      <ModalHeader className="border-border/60 space-y-1 border-b pb-4">
        <ModalTitle>
          {isCommand ? <span className="text-muted-foreground/40">/</span> : null}
          {entity.name}
        </ModalTitle>
      </ModalHeader>

      <ModalBody className="max-h-[70vh] overflow-hidden p-0">
        <div className="flex min-h-0 flex-col overflow-y-auto lg:h-[70vh] lg:flex-row lg:overflow-hidden">
          <div className="border-border/60 flex shrink-0 flex-col border-b p-2 lg:h-full lg:w-64 lg:overflow-y-auto lg:border-r lg:border-b-0">
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

            {canWrite ? (
              <div className="mt-auto pt-4">
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full justify-start border"
                  onClick={() => configure.start(editConfigPrompt(kind, entity.name, entity.path))}
                  disabled={configure.pending}
                >
                  {configure.pending ? (
                    <Loading className="text-foreground size-3.5 shrink-0" />
                  ) : (
                    <PencilSimpleIcon className="size-3.5 shrink-0" />
                  )}
                  Edit source
                </Button>
              </div>
            ) : null}
          </div>

          {/* Right — the selected file's card. */}
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
