'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { errorToast, successToast } from '@/components/ui/toast';
import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
import { createProjectSkill } from '@kortix/sdk';
import { slugifySlug } from '@kortix/manifest-schema';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from '@/features/icon/icons/plus';
import { qk } from '@kortix/sdk/react';
import { useState } from 'react';

/**
 * The Skills "New" form path: commits `skills/<slug>/SKILL.md` onto the
 * project's default branch — no model needed, unlike "Create in chat".
 *
 * The folder preview derives from the name with the SAME `slugifySlug` the
 * API uses, so it never lies about where the file will land.
 */
export function NewSkillModal({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const slug = slugifySlug(name, 'skill');
  const path = `skills/${slug}/SKILL.md`;

  const mutation = useMutation({
    mutationFn: () =>
      createProjectSkill(projectId, {
        name: name.trim(),
        description: description.trim() || undefined,
      }),
    onSuccess: () => {
      successToast(tI18nComplete.raw('textb25ab5d5e2a5'));
      void queryClient.invalidateQueries({ queryKey: qk.project.detail(projectId) });
      setName('');
      setDescription('');
      onOpenChange(false);
    },
    onError: (error: Error) => errorToast(error.message),
  });

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) mutation.reset();
        onOpenChange(next);
      }}
    >
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>{tI18nComplete.raw('text9bf06a86c934')}</ModalTitle>
          <ModalDescription>
            {tI18nComplete.raw('text38e64d6a8162')}
          </ModalDescription>
        </ModalHeader>
        <form onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) mutation.mutate();
        }}>
          <ModalBody>
            <div className="space-y-1.5">
              <Label htmlFor="new-skill-name">{tI18nComplete.raw('textdcd1d5223f73')}</Label>
              <Input
                id="new-skill-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
              <p className="text-muted-foreground text-xs">
                {tI18nComplete.raw('text74ccd4330384')}:{' '}
                <span className="font-mono">{path}</span>
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-skill-description">
                {tI18nComplete.raw('text526e0087cc3f')}
              </Label>
              <Input
                id="new-skill-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
          </ModalBody>
          <ModalFooter className="sm:justify-between">
            <Button
              type="button"
              variant="outline-ghost"
              onClick={() => onOpenChange(false)}
              disabled={mutation.isPending}
            >
              {tI18nComplete.raw('text19766ed6ccb2')}
            </Button>
            <Button type="submit" className="gap-1.5" disabled={mutation.isPending || !name.trim()}>
              {mutation.isPending ? <Loading /> : <Plus />}
              {tI18nComplete.raw('text1a9030082a20')}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
