'use client';

import { createProjectSession, type ArtifactType } from '@kortix/sdk';
import { useArtifactMutations, useArtifactTypes } from '@kortix/sdk/react';
import { Button } from '@kortix/ui/button';
import { Modal, ModalBody, ModalContent, ModalDescription, ModalFooter, ModalHeader, ModalTitle } from '@kortix/ui/modal';
import { Textarea } from '@kortix/ui/textarea';
import { SparkleIcon } from '@phosphor-icons/react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { useTranslations } from '@/i18n/use-translations';

import { ARTIFACT_TYPE_ICON, artifactHref } from './artifact-meta';

/** The first prompt of a session that makes an artifact. Agent-facing, so English. */
export function createArtifactPrompt(type: ArtifactType, brief: string): string {
  return [
    `Make a Kortix ${type} artifact. Run \`kortix artifacts types ${type}\` first for its format, then publish it with \`kortix artifacts publish --type ${type}\` and reply with its link.`,
    '',
    brief.trim(),
  ].join('\n');
}

/**
 * "Make something new": describe it and an agent builds it in a new session,
 * or start from the type's blank page and edit it yourself.
 */
export function NewArtifactDialog({
  projectId,
  type,
  onOpenChange,
}: {
  projectId: string;
  type: ArtifactType | null;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('artifacts');
  const router = useRouter();
  const types = useArtifactTypes(type ? projectId : null);
  const { create } = useArtifactMutations(projectId);
  const [brief, setBrief] = useState('');
  const [starting, setStarting] = useState(false);
  const TypeIcon = type ? ARTIFACT_TYPE_ICON[type] : null;
  const starter = types.data?.find((x) => x.type === type)?.starter;

  const withAgent = async () => {
    if (!type || !brief.trim()) return;
    setStarting(true);
    try {
      const session = await createProjectSession(projectId, { initial_prompt: createArtifactPrompt(type, brief) });
      // nav-contract: prefetch-only — the session id exists only after the create call returns.
      router.push(`/projects/${projectId}/sessions/${session.session_id}`);
    } finally {
      setStarting(false);
    }
  };

  const blank = async () => {
    if (!type || !starter) return;
    const a = await create.mutateAsync({ type, title: t('untitled', { type: t(`type.${type}`) }), files: { 'index.html': { content: starter } } });
    router.push(`${artifactHref(projectId, a.artifact_id)}${type === 'doc' ? '' : '?code=1'}`);
  };

  return (
    <Modal open={type !== null} onOpenChange={(open) => { if (!open) setBrief(''); onOpenChange(open); }}>
      <ModalContent className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle className="flex items-center gap-2">
            {TypeIcon ? <TypeIcon className="size-4" /> : null}
            {type ? t('newTitle', { type: t(`type.${type}`) }) : null}
          </ModalTitle>
          <ModalDescription>{type ? t(`typeHint.${type}`) : null}</ModalDescription>
        </ModalHeader>
        <ModalBody>
          <Textarea
            autoFocus
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void withAgent();
            }}
            placeholder={t('newPlaceholder')}
            aria-label={t('newPlaceholder')}
            className="min-h-32"
          />
        </ModalBody>
        <ModalFooter className="sm:justify-between">
          <Button variant="ghost" size="sm" onClick={blank} disabled={!starter || create.isPending}>
            {t('startBlank')}
          </Button>
          <Button size="sm" onClick={withAgent} disabled={!brief.trim() || starting}>
            <SparkleIcon /> {t('createWithAgent')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
