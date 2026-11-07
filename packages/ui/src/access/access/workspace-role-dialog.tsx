'use client';

/**
 * Change a person's one role in a workspace (design.md C3):
 * `PATCH /v1/workspaces/:id/members/:userId {role}`. The ladder is Owner >
 * Admin > Manager > Member; the server writes the storage each rung needs, and
 * only an owner can make an owner.
 */

import { updateWorkspaceMemberRole, type WorkspaceRole } from '@kortix/sdk';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';

import { useTranslations } from '../../i18n';
import { Button } from '../../primitives/button';
import { Field, FieldLabel } from '../../primitives/field';
import Loading from '../../primitives/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '../../primitives/modal';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../primitives/select';
import { errorToast, successToast } from '../../primitives/toast';

/** The ladder, highest first. */
export const WORKSPACE_ROLE_LADDER: readonly WorkspaceRole[] = ['owner', 'admin', 'manager', 'member'];

/** The roles a caller may give: Owner only by an owner; Admin only with `member.update`. */
export function assignableWorkspaceRoles(input: { viewerIsOwner: boolean; canGrantAdmin: boolean }): WorkspaceRole[] {
  return WORKSPACE_ROLE_LADDER.filter(
    (role) => (role !== 'owner' || input.viewerIsOwner) && (role !== 'admin' || input.canGrantAdmin),
  );
}

export interface WorkspaceRoleDialogProps {
  workspaceId: string;
  target: { userId: string; label: string; role: WorkspaceRole } | null;
  onOpenChange: (open: boolean) => void;
  viewerIsOwner: boolean;
  canGrantAdmin: boolean;
  onDone?: () => void;
}

export function WorkspaceRoleDialog({
  workspaceId,
  target,
  onOpenChange,
  viewerIsOwner,
  canGrantAdmin,
  onDone,
}: WorkspaceRoleDialogProps) {
  const t = useTranslations('workspaces.roleDialog');
  const tRoles = useTranslations('workspaces.roles');
  const [picked, setPicked] = useState<WorkspaceRole | null>(null);
  const role = picked ?? target?.role ?? 'member';
  const roles = assignableWorkspaceRoles({ viewerIsOwner, canGrantAdmin });

  const save = useMutation({
    mutationFn: () => updateWorkspaceMemberRole(workspaceId, target!.userId, role),
    onSuccess: () => {
      successToast(t('savedToast', { name: target?.label ?? '', role: tRoles(`${role}.label`) }));
      setPicked(null);
      onOpenChange(false);
      onDone?.();
    },
    onError: (error: Error) => errorToast(error.message || t('saveFailed')),
  });

  return (
    <Modal
      open={target !== null}
      onOpenChange={(open) => {
        if (save.isPending) return;
        if (!open) setPicked(null);
        onOpenChange(open);
      }}
    >
      <ModalContent className="sm:max-w-md">
        <ModalHeader>
          <ModalTitle>{t('title', { name: target?.label ?? '' })}</ModalTitle>
          <ModalDescription>{t('description')}</ModalDescription>
        </ModalHeader>
        <ModalBody>
          <Field className="gap-1.5">
            <FieldLabel htmlFor="workspace-role">{t('roleLabel')}</FieldLabel>
            <Select value={role} onValueChange={(value) => setPicked(value as WorkspaceRole)} disabled={save.isPending}>
              <SelectTrigger id="workspace-role" size="md" className="w-full">
                <SelectValue>{tRoles(`${role}.label`)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {roles.map((value) => (
                  <SelectItem key={value} value={value} textValue={tRoles(`${value}.label`)}>
                    <span className="flex flex-col gap-0.5">
                      <span>{tRoles(`${value}.label`)}</span>
                      <span className="text-muted-foreground text-xs">{tRoles(`${value}.blurb`)}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </ModalBody>
        <ModalFooter>
          <Button variant="outline-ghost" size="sm" disabled={save.isPending} onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button
            size="sm"
            className="gap-1.5"
            disabled={save.isPending || role === target?.role}
            onClick={() => save.mutate()}
          >
            {save.isPending ? <Loading className="size-4 shrink-0" /> : null}
            {t('save')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
