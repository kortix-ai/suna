'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import type { GlyphSelection } from '@/components/ui/glyph-picker';
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
import { qk } from '@kortix/sdk/react';

import {
  renameOnError,
  renameOnMutate,
  renameOnSettled,
} from '@/hooks/projects/project-rename-cache';
import { buildProjectEditPatch, summarizeProjectEdit } from './project-edit-patch';
import { ProjectIconField, type ProjectIconValue } from './project-icon-field';

interface EditProjectModalProps {
  projectId: string | null;
  currentName?: string;
  /** The project's saved emoji. `null`/absent means it has none. */
  currentIcon?: string | null;
  /** The project's saved glyph. `null`/absent means it has none. At most one
   *  of `currentIcon` / `currentGlyph` is ever set on a real project — see
   *  `ProjectIconField`'s own union `value`, which this seeds. */
  currentGlyph?: GlyphSelection | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
}

const MAX_NAME_LENGTH = 120;

/** The field's union, seeded from the project's two independent stored
 *  columns. Glyph wins if — despite the server invariant — a stale row
 *  somehow carries both, matching `EntityAvatar`'s own glyph > emoji
 *  precedence rather than inventing a different tiebreak here. */
function toIconValue(icon?: string | null, glyph?: GlyphSelection | null): ProjectIconValue {
  if (glyph) return { glyph };
  if (icon) return { emoji: icon };
  return null;
}

/**
 * Edit a project's name and icon.
 *
 * This was the rename modal. It edits the icon too because a project's icon
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
  currentGlyph,
  open,
  onOpenChange,
  onSaved,
}: EditProjectModalProps) => {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const [name, setName] = useState(currentName ?? '');
  const [icon, setIcon] = useState<ProjectIconValue>(() => toIconValue(currentIcon, currentGlyph));

  // Reseed only while OPEN. The projects page drops its target on close, so the
  // props go undefined during the exit animation; reseeding then would empty
  // the fields in front of the user on the way out.
  useEffect(() => {
    if (!open) return;
    setName(currentName ?? '');
    setIcon(toIconValue(currentIcon, currentGlyph));
  }, [open, currentName, currentIcon, currentGlyph]);

  const edit = buildProjectEditPatch(
    { name: currentName, icon: currentIcon, icon_glyph: currentGlyph },
    { name, icon },
  );

  const saveMutation = useMutation({
    mutationFn: (patch: Partial<ProjectInput>) => {
      if (!projectId) throw new Error('No workspace selected');
      return updateProject(projectId, patch);
    },
    // Paint the new name in the same frame the modal closes, snapshotting
    // what it overwrote so a REJECTED rename can put it back. The rename bug
    // this modal used to cause was not a missing invalidation — it was that
    // the sidebar and the project home title read two different caches, and
    // only one of them (the list) ever got invalidated. `renameOnMutate` /
    // `renameOnError` / `renameOnSettled` are shared with `settings-view.tsx`
    // so the two rename paths cannot drift.
    onMutate: (patch) => renameOnMutate(queryClient, projectId, patch.name),
    // `patch` is the mutation's own variables, not the component's current
    // state: the message has to describe what was SENT, and by the time this
    // runs the draft could already have moved on.
    onSuccess: (updated, patch) => {
      if (projectId) {
        queryClient.setQueryData(qk.project.summary(projectId), updated);
      }
      successToast(summarizeProjectEdit(patch, updated?.name ?? name.trim()));
      onSaved?.();
      onOpenChange(false);
    },
    onError: (err, _patch, context) => {
      renameOnError(queryClient, projectId, context);
      errorToast(err instanceof Error ? err.message : 'Failed to update workspace');
    },
    onSettled: () => renameOnSettled(queryClient, projectId),
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
              onChange={(emoji) => setIcon({ emoji })}
              onGlyphChange={(glyph) => setIcon({ glyph })}
              // Passed HERE and not in the create modal: this project's icon is
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
