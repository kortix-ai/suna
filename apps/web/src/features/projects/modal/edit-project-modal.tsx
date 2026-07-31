'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { updateProject, type ProjectInput } from '@kortix/sdk';

import { buildProjectEditPatch, summarizeProjectEdit } from './project-edit-patch';
import { ProjectIconField } from './project-icon-field';

interface EditProjectModalProps {
  projectId: string | null;
  currentName?: string;
  /** The project's saved emoji. `null`/absent means it has none. */
  currentIcon?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
}

const MAX_NAME_LENGTH = 120;

/**
 * Edit a project's name and icon.
 *
 * This was the rename modal. It edits the emoji too because a project's icon
 * was otherwise write-once: chosen in the create modal and unreachable
 * afterwards, with no way to change it and no way to take it back off.
 *
 * The whole diff — what changed, whether anything did, and what to send — comes
 * from `buildProjectEditPatch`, not from comparisons written here. Two separate
 * derivations is exactly how the old modal ended up with a Save button that
 * only ever watched the name.
 */
export const EditProjectModal = ({
  projectId,
  currentName,
  currentIcon,
  open,
  onOpenChange,
  onSaved,
}: EditProjectModalProps) => {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const [name, setName] = useState(currentName ?? '');
  const [icon, setIcon] = useState<string | null>(currentIcon ?? null);

  // Reseed only while OPEN. The projects page drops its target on close, so the
  // props go undefined during the exit animation; reseeding then would empty
  // the fields in front of the user on the way out.
  useEffect(() => {
    if (!open) return;
    setName(currentName ?? '');
    setIcon(currentIcon ?? null);
  }, [open, currentName, currentIcon]);

  const edit = buildProjectEditPatch({ name: currentName, icon: currentIcon }, { name, icon });

  const saveMutation = useMutation({
    mutationFn: (patch: Partial<ProjectInput>) => {
      if (!projectId) throw new Error('No project selected');
      return updateProject(projectId, patch);
    },
    // `patch` is the mutation's own variables, not the component's current
    // state: the message has to describe what was SENT, and by the time this
    // runs the draft could already have moved on.
    onSuccess: (updated, patch) => {
      if (projectId) {
        queryClient.setQueryData(['project', projectId], updated);
      }
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      successToast(summarizeProjectEdit(patch, updated?.name ?? name.trim()));
      onSaved?.();
      onOpenChange(false);
    },
    onError: (err) => {
      errorToast(err instanceof Error ? err.message : 'Failed to update project');
    },
  });

  // ONE predicate, for the button and for Enter. `status !== 'ready'` covers
  // both "nothing changed" and "the name is empty" — the two states this file
  // used to track as separate booleans, only one of which watched the icon.
  const canSave = !!projectId && !saveMutation.isPending && edit.status === 'ready';

  const submit = () => {
    if (!canSave || edit.status !== 'ready') return;
    saveMutation.mutate(edit.patch);
  };

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!saveMutation.isPending) onOpenChange(o);
      }}
    >
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>
            {tI18nHardcoded.raw(
              'autoFeaturesProjectsModalEditProjectModalJsxTextEditProjecta4dc3833',
            )}
          </ModalTitle>
          <ModalDescription>
            {tI18nHardcoded.raw(
              'autoFeaturesProjectsModalEditProjectModalJsxTextChangeThise7a7a4b7',
            )}
          </ModalDescription>
        </ModalHeader>
        <ModalBody>
          {/* The same row treatment as the create modal's name field: the icon
              trigger is a peer of the input, not a field of its own, because the
              two are one thing — how the project is identified. `items-start`
              aligns them at the top of the row; both are 9 units tall today, so
              it reads as centred and stays correct if the input ever grows. */}
          <div className="flex items-start gap-2">
            <ProjectIconField
              value={icon}
              onChange={setIcon}
              // Passed HERE and not in the create modal: this project's emoji is
              // already saved, so without a way to remove it there is no way to
              // undo one. Nothing is written until Save — Cancel puts it back.
              onClear={() => setIcon(null)}
              disabled={saveMutation.isPending}
            />
            <div className="min-w-0 flex-1">
              <Input
                autoFocus
                value={name}
                maxLength={MAX_NAME_LENGTH}
                placeholder={tI18nHardcoded.raw(
                  'autoFeaturesProjectsModalEditProjectModalJsxAttrPlaceholderProject25498193',
                )}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    submit();
                  }
                }}
              />
            </div>
          </div>
        </ModalBody>
        <ModalFooter className="sm:justify-between">
          <Button
            variant="outline-ghost"
            onClick={() => onOpenChange(false)}
            disabled={saveMutation.isPending}
          >
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSave}>
            {saveMutation.isPending ? <Loading className="size-4 shrink-0" /> : null}
            Save
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
};
