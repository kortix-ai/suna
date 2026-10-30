'use client';

import { removeProjectSkill } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { TrashIcon } from '@phosphor-icons/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { useTranslations } from '../../i18n';
import { Button } from '../../primitives/button';
import { ConfirmDialog } from '../../primitives/confirm-dialog';
import { errorToast, successToast } from '../../primitives/toast';
import { entityDirectory } from '../shared/entity/entity-files';

/**
 * The folder `POST /skills/remove` takes for the skill at `path`, or null when
 * the API refuses it: a platform `kortix-*` skill, or a SKILL.md at the root.
 */
export function removableSkillFolder(path: string): string | null {
  const folder = entityDirectory(path);
  const name = folder.split('/').at(-1) ?? '';
  return folder && !name.startsWith('kortix-') ? folder : null;
}

/**
 * Removes a project skill: its whole folder, edits included, and its entry on
 * every agent, in one commit on the default branch (KRTX-2821). The click only
 * opens the confirmation. On success the project config is refetched; it no
 * longer lists the skill, so the detail modal around this button closes itself.
 */
export function RemoveSkillButton({
  projectId,
  name,
  folder,
}: {
  projectId: string;
  name: string;
  folder: string;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () => removeProjectSkill(projectId, { folder, confirm: true }),
    onSuccess: () => {
      setConfirming(false);
      successToast(tI18nComplete.raw('text5f6ba69d66d1'));
      void queryClient.invalidateQueries({ queryKey: qk.project.detail(projectId) });
    },
    onError: (error: Error) => errorToast(error.message),
  });

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="w-full justify-start gap-1.5"
        disabled={remove.isPending}
        onClick={() => setConfirming(true)}
      >
        <TrashIcon className="size-3.5 shrink-0" />
        {tI18nComplete.raw('textc3812fc4acb8')}
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={tI18nComplete('textbc43ab815937', { value0: name })}
        description={
          <>
            {tI18nComplete.raw('text0c044575853f')} <code className="font-mono">{folder}</code>
            {tI18nComplete.raw('textcb8d6b0c94c9')}
          </>
        }
        confirmLabel={tI18nComplete.raw('texta8597db6f24b')}
        confirmVariant="destructive"
        confirmIcon={<TrashIcon className="size-4 shrink-0" />}
        isPending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </>
  );
}
