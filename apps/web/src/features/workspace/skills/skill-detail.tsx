'use client';

/**
 * Skill / command detail — ux-references/perplexity/09-skill-detail.png.
 *
 * A MODAL, not a rail nested inside the page: left is About + Files, right is
 * the file itself (frontmatter, then the rendered markdown). The old screen put
 * this in the middle column of a master-detail split, which is why the list had
 * to be a 264px sidebar of truncated names.
 *
 * Editing is unchanged — project config is repo-owned and read-only from the
 * UI, so "Edit" still seeds a configure session that opens a change request.
 */

import { useQuery } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
import { useMemo } from 'react';

import { UnifiedMarkdown } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import Hint from '@/components/ui/hint';
import { InfoBanner } from '@/components/ui/info-banner';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { splitFrontmatter } from '@/features/workspace/customize/shared/utils';
import {
  editConfigPrompt,
  useConfigureThread,
} from '@/features/workspace/customize/use-configure-thread';
import { readProjectFile } from '@kortix/sdk';
import { Pencil } from '@mynaui/icons-react';

import { SkillDetailPanes } from './skill-detail-panes';
import { SKILL_KINDS, type SkillEntity, type SkillKind, skillDisplayName } from './skill-entities';

export interface SkillDetailModalProps {
  projectId: string;
  kind: SkillKind;
  /** Null closes the modal — the caller clears its selection. */
  entity: SkillEntity | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canWrite: boolean;
}

export function SkillDetailModal({
  projectId,
  kind,
  entity,
  open,
  onOpenChange,
  canWrite,
}: SkillDetailModalProps) {
  const meta = SKILL_KINDS[kind];
  const configure = useConfigureThread(projectId);

  const fileQuery = useQuery({
    queryKey: ['project-file-source', projectId, entity?.path],
    queryFn: () => readProjectFile(projectId, entity?.path ?? ''),
    enabled: open && !!entity?.path,
    staleTime: 30_000,
  });

  const content = fileQuery.data?.content ?? '';
  const { frontmatter, body } = useMemo(() => splitFrontmatter(content), [content]);

  if (!entity) return null;

  const name = skillDisplayName(kind, entity);

  const onCopy = async () => {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      successToast('Source copied');
    } catch {
      errorToast('Copy failed');
    }
  };

  const rendered = fileQuery.isLoading ? (
    <div className="space-y-2.5">
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-11/12" />
      <Skeleton className="h-4 w-10/12" />
      <Skeleton className="h-4 w-9/12" />
    </div>
  ) : fileQuery.isError ? (
    <InfoBanner
      tone="destructive"
      title="Couldn't load source"
      action={
        <Button variant="outline" size="sm" onClick={() => fileQuery.refetch()}>
          Retry
        </Button>
      }
    >
      {(fileQuery.error as Error)?.message ?? 'Failed to read source'}
    </InfoBanner>
  ) : body.trim() ? (
    <UnifiedMarkdown content={body} allowHtml={false} />
  ) : (
    <p className="text-muted-foreground/60 text-sm italic">{meta.emptyBodyLabel}</p>
  );

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent
        variant="base"
        /* flex-col + a bounded height at EVERY size. The lg-only variants left
           the modal a plain block below 1024px while `overflow-hidden` had
           already stripped the base `overflow-y-auto`, so nothing in the
           subtree scrolled and a long SKILL.md was simply clipped. */
        className="flex max-h-[85vh] flex-col space-y-0 overflow-hidden p-0 lg:h-[min(82vh,760px)] lg:max-w-5xl"
      >
        <ModalHeader className="border-border/60 shrink-0 flex-row items-center justify-between gap-3 border-b px-5 py-3">
          <div className="min-w-0">
            <ModalTitle className="truncate">{name}</ModalTitle>
            <ModalDescription className="sr-only">
              {entity.description ?? `Source of the ${name} ${meta.noun}.`}
            </ModalDescription>
          </div>
          <ButtonGroup className="mr-9 shrink-0">
            {canWrite ? (
              <Hint label={`Edit this ${meta.noun}`}>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={configure.pending}
                  onClick={() => configure.start(editConfigPrompt(kind, entity.name, entity.path))}
                >
                  {configure.pending ? (
                    <Loading className="size-3.5 shrink-0" />
                  ) : (
                    <Pencil className="size-3.5 shrink-0" />
                  )}
                  Edit
                </Button>
              </Hint>
            ) : null}
            <Hint label="Copy source">
              <Button variant="outline" size="icon" onClick={onCopy} disabled={!content}>
                <Copy className="size-3.5 shrink-0" />
              </Button>
            </Hint>
          </ButtonGroup>
        </ModalHeader>

        <SkillDetailPanes kind={kind} entity={entity} frontmatter={frontmatter} body={rendered} />
      </ModalContent>
    </Modal>
  );
}

export default SkillDetailModal;
