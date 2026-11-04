'use client';

import type { Artifact, ArtifactVisibility } from '@kortix/sdk';
import { useArtifactMutations } from '@kortix/sdk/react';
import { ShareOption, SubjectPicker } from '@kortix/ui/access/sharing-picker';
import { Button } from '@kortix/ui/button';
import { Input } from '@kortix/ui/input';
import { Label } from '@kortix/ui/label';
import { Modal, ModalBody, ModalContent, ModalDescription, ModalFooter, ModalHeader, ModalTitle } from '@kortix/ui/modal';
import { RadioGroup } from '@kortix/ui/radio-group';
import { successToast } from '@kortix/ui/toast';
import { PROJECT_ACTIONS, useProjectCan } from '@kortix/ui/workspace';
import { CopyIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { useTranslations } from '@/i18n/use-translations';

const MODES: ArtifactVisibility[] = ['private', 'project', 'public'];

/** Who may open an artifact: only the people added, the whole project, or anyone with the link. */
export function ShareArtifactDialog({
  projectId,
  artifact,
  open,
  onOpenChange,
}: {
  projectId: string;
  artifact: Artifact;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('artifacts');
  const { update } = useArtifactMutations(projectId);
  // A public link needs project.artifact.public; one already public stays listed so it can be turned off.
  const canPublic = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_ARTIFACT_PUBLIC).allowed === true;
  const modes = MODES.filter((value) => value !== 'public' || canPublic || artifact.visibility === 'public');
  const [mode, setMode] = useState<ArtifactVisibility>(artifact.visibility);
  const [people, setPeople] = useState<string[]>(artifact.shared_with_user_ids);
  const changed = mode !== artifact.visibility || people.join() !== artifact.shared_with_user_ids.join();
  const link = artifact.visibility === 'public' && mode === 'public' ? artifact.public_url : artifact.web_url;

  const copy = async () => {
    if (!link) return;
    await navigator.clipboard.writeText(link);
    successToast(t('linkCopied'));
  };

  const save = async () => {
    await update.mutateAsync({
      artifactId: artifact.artifact_id,
      visibility: mode,
      shared_with_user_ids: mode === 'private' ? people : [],
    });
    successToast(t('shareSaved'));
    onOpenChange(false);
  };

  return (
    <Modal open={open} onOpenChange={(value) => !update.isPending && onOpenChange(value)}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>{t('shareTitle', { title: artifact.title })}</ModalTitle>
          <ModalDescription>{t('shareHint')}</ModalDescription>
        </ModalHeader>
        <ModalBody className="max-h-[65vh] space-y-4 overflow-y-auto">
          <div className="space-y-2">
            <Label>{t('generalAccess')}</Label>
            <RadioGroup value={mode} onValueChange={(v) => setMode(v as ArtifactVisibility)} className="space-y-2">
              {modes.map((value) => (
                <ShareOption key={value} value={value} label={t(`visibility.${value}`)} desc={t(`visibilityHint.${value}`)} />
              ))}
            </RadioGroup>
          </div>
          {mode === 'private' ? (
            <div className="space-y-2">
              <Label>{t('people')}</Label>
              <SubjectPicker
                projectId={projectId}
                kinds={['member']}
                memberIds={people}
                groupIds={[]}
                excludeUserIds={[artifact.created_by.user_id]}
                onChange={(members) => setPeople(members)}
              />
            </div>
          ) : null}
          <div className="space-y-2">
            <Label>{mode === 'public' && artifact.visibility === 'public' ? t('publicLink') : t('appLink')}</Label>
            <div className="flex gap-2">
              <Input readOnly value={link ?? ''} className="h-8 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
              <Button size="sm" variant="outline" onClick={copy} disabled={!link}>
                <CopyIcon /> {t('copyLink')}
              </Button>
            </div>
            {mode === 'public' && artifact.visibility !== 'public' ? <p className="text-muted-foreground text-xs">{t('publicAfterSave')}</p> : null}
          </div>
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={update.isPending}>
            {t('cancel')}
          </Button>
          <Button size="sm" onClick={save} disabled={!changed || update.isPending}>
            {t('save')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
