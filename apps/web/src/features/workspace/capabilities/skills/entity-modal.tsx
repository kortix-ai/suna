'use client';

import { useMemo, useState } from 'react';

import { MarkdownWithFrontmatter } from '@/components/markdown/markdown-frontmatter';
import { Button } from '@/components/ui/button';
import { CodeBlockCode } from '@/components/ui/code-block';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
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

import { buildFileTree, entityDirectory, isMarkdownPath, languageForPath } from './skill-files';

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
 * The skill/command detail modal: an `About` blurb + file tree on the left,
 * the selected file's rendered content on the right. One component for both
 * kinds — the only difference is the write-permission action probed and the
 * `/name` slash treatment in the title.
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
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-4xl">
        {entity ? (
          <EntityModalBody
            key={entity.path}
            projectId={projectId}
            entity={entity}
            kind={kind}
          />
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
      <ModalHeader>
        <ModalTitle className="flex items-center gap-1">
          {isCommand ? <span className="text-muted-foreground/40">/</span> : null}
          {entity.name}
        </ModalTitle>
        {entity.description ? <ModalDescription>{entity.description}</ModalDescription> : null}
      </ModalHeader>

      <ModalBody className="max-h-[70vh] overflow-hidden p-0">
        <div className="flex min-h-0 flex-col overflow-y-auto lg:h-[70vh] lg:flex-row lg:overflow-hidden">
          {/* Left — About + file tree. Always present; the tree portion below
              it only renders once there is more than one file to pick from. */}
          <div className="border-border/60 shrink-0 space-y-4 border-b px-4 py-3.5 lg:w-64 lg:overflow-y-auto lg:border-r lg:border-b-0">
            <div className="space-y-1.5">
              <p className="text-muted-foreground/60 text-[11px] font-medium tracking-wide uppercase">
                About
              </p>
              <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
                {entity.description ?? 'No description.'}
              </p>
              <p className="text-muted-foreground/50 truncate font-mono text-[11px]">
                {sourcePath}
              </p>
            </div>

            {nodes.length > 1 ? (
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
          </div>

          {/* Right — the selected file's content. */}
          <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
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

      {canWrite ? (
        <ModalFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => configure.start(editConfigPrompt(kind, entity.name, entity.path))}
            disabled={configure.pending}
          >
            {configure.pending ? (
              <Loading className="size-3.5 shrink-0" />
            ) : (
              <PencilSimpleIcon className="size-3.5 shrink-0" />
            )}
            Edit
          </Button>
        </ModalFooter>
      ) : null}
    </>
  );
}

/**
 * The right pane's content for one file. Dispatches on file type, not on a
 * single "always markdown" assumption — a skill/command directory routinely
 * carries `.py` scripts and `.xml` templates alongside its `SKILL.md` (e.g.
 * the `docx` skill), and running those through a markdown renderer mangles
 * them instead of rendering them as code.
 */
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
  if (isLoading) {
    return (
      <div className="space-y-2.5">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-10/12" />
        <Skeleton className="h-4 w-9/12" />
        <Skeleton className="h-4 w-full" />
      </div>
    );
  }

  if (isError) {
    // A plain member without `project.file.read` legitimately 403s here —
    // this renders inline, never a global toast (the SDK's `readProjectFile`
    // suppresses that sink for this exact gate, same as `listProjectFiles`).
    return (
      <ErrorState
        size="sm"
        title="Couldn't load file"
        description={
          error instanceof Error ? error.message : 'You may not have permission to read this file.'
        }
        action={
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        }
      />
    );
  }

  const raw = content ?? '';

  if (isMarkdownPath(path)) {
    return <MarkdownWithFrontmatter content={raw} />;
  }

  return (
    <CodeBlockCode
      code={raw}
      language={languageForPath(path)}
      className="[&_pre]:rounded-none [&_pre]:!bg-transparent [&_pre]:!px-0 [&_pre]:!pb-4 [&_pre]:!text-[13px]"
    />
  );
}
