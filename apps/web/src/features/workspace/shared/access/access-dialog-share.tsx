'use client';

// AccessDialog `share` mode — who may use ONE shared connector account.
//
// Same modal, same `PrincipalPicker` as every other mode; no role and no
// agents. The body is who can use the account now (each grant, with a remove
// toggle) and the picker to add people, groups, or everyone in the project.
// Nothing is written until Save.
//
// Save CREATES before it REVOKES. A shared account with no grant is usable by
// everyone in the project, so revoking group A before granting group B would
// open the account to the whole project for the gap between the two writes.
//
// There is no expiry field here on purpose: when the last narrowing grant
// expires, the account silently widens to everyone.

import { Button } from '@/components/ui/button';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { Field, FieldLabel } from '@/components/ui/field';
import { InfoBanner } from '@/components/ui/info-banner';
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
import { UserAvatar } from '@/components/ui/user-avatar';
import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import {
  createAssignment,
  revokeAssignment,
  shareConnection,
  type ConnectionShare,
  type ConnectionSharePrincipal,
} from '@kortix/sdk';
import { invalidatePermissionProbes, qk } from '@kortix/sdk/react';
import { LockIcon, UsersIcon, UsersThreeIcon, XIcon } from '@phosphor-icons/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import type { AccessDialogResult } from './access-dialog';
import {
  EMPTY_PRINCIPAL_SELECTION,
  PrincipalPicker,
  type PrincipalSelection,
} from './principal-picker';

/** The object a `share` dialog narrows. Connections are the one kind today. */
export interface ShareableObject {
  type: 'connection';
  id: string;
  label: string;
  /**
   * Set for the caller's OWN private account. Save then makes it a shared
   * account for the picked audience in one call (`shareConnection`), with the
   * owner kept on it unless they removed themselves.
   */
  privateOwner?: { userId: string; label: string };
}

export interface SharePlan {
  /** Principals to grant, in the canonical assignment vocabulary. */
  add: Array<{ type: 'user' | 'group' | 'project'; id: string }>;
  /** Assignment ids to revoke. */
  revoke: string[];
}

function repicked(grant: ConnectionShare, picked: PrincipalSelection): boolean {
  if (grant.principal_type === 'member') return picked.memberIds.includes(grant.principal_id);
  if (grant.principal_type === 'group') return picked.groupIds.includes(grant.principal_id);
  return picked.everyone === true;
}

/**
 * What Save writes. A principal already granted is never granted twice, and a
 * grant marked for removal but picked again is left alone (neither write).
 */
export function planShare(
  current: readonly ConnectionShare[],
  removed: ReadonlySet<string>,
  picked: PrincipalSelection,
  projectId: string,
): SharePlan {
  const granted = (type: ConnectionShare['principal_type'], id: string) =>
    current.some((grant) => grant.principal_type === type && grant.principal_id === id);
  const add: SharePlan['add'] = [];
  for (const id of picked.memberIds) if (!granted('member', id)) add.push({ type: 'user', id });
  for (const id of picked.groupIds) if (!granted('group', id)) add.push({ type: 'group', id });
  if (picked.everyone && !current.some((grant) => grant.principal_type === 'project')) {
    add.push({ type: 'project', id: projectId });
  }
  const revoke = current
    .filter((grant) => removed.has(grant.grant_id) && !repicked(grant, picked))
    .map((grant) => grant.grant_id);
  return { add, revoke };
}

/**
 * Who a private account is shared with on Save, or `null` when nothing is
 * picked (it stays private). Everyone in the project is the empty audience.
 */
export function planPrivateShare(
  picked: PrincipalSelection,
  keepOwner: boolean,
  ownerId: string,
): ConnectionSharePrincipal[] | null {
  if (picked.everyone) return [];
  const others = [
    ...picked.memberIds
      .filter((id) => id !== ownerId)
      .map((id) => ({ principal_type: 'user' as const, principal_id: id })),
    ...picked.groupIds.map((id) => ({ principal_type: 'group' as const, principal_id: id })),
  ];
  const ownerPicked = picked.memberIds.includes(ownerId);
  if (others.length === 0 && !ownerPicked) return null;
  return keepOwner || ownerPicked
    ? [{ principal_type: 'user', principal_id: ownerId }, ...others]
    : others;
}

/** Grant each principal the use of one shared connector account, in parallel.
 *  The one write both the share dialog and the Add account flow make. */
export async function grantConnectionAccess(
  accountId: string,
  projectId: string,
  connectionId: string,
  principals: SharePlan['add'],
): Promise<void> {
  await Promise.all(
    principals.map((principal) =>
      createAssignment(accountId, {
        principal,
        roleKey: 'agent-user',
        scope: { type: 'project', id: projectId },
        object: { type: 'connection', id: connectionId },
      }),
    ),
  );
}

/** After Save, may everyone in the project use the account? No grant left, or
 *  a grant to the project, means yes. */
export function sharedWithEveryoneAfter(
  current: readonly ConnectionShare[],
  removed: ReadonlySet<string>,
  picked: PrincipalSelection,
): boolean {
  if (picked.everyone) return true;
  const kept = current.filter((grant) => !removed.has(grant.grant_id) || repicked(grant, picked));
  if (kept.some((grant) => grant.principal_type === 'project')) return true;
  return kept.length === 0 && picked.memberIds.length + picked.groupIds.length === 0;
}

export function ShareAccessBody({
  open,
  onOpenChange,
  accountId,
  projectId,
  projectName,
  object,
  current,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
  projectId: string;
  projectName: string;
  object: ShareableObject;
  current: readonly ConnectionShare[];
  onDone?: (result: AccessDialogResult) => void;
}) {
  const t = useI18nTranslations('accessSharing');
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const queryClient = useQueryClient();

  const [picked, setPicked] = useState<PrincipalSelection>(EMPTY_PRINCIPAL_SELECTION);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set());
  // A private account: the owner stays on it unless they remove themselves.
  const [keepOwner, setKeepOwner] = useState(true);
  const privateOwner = object.privateOwner;
  // Re-seed on every closed → open transition, the same pattern as the grant
  // body: no draft from a previous opening survives a reopen.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setPicked(EMPTY_PRINCIPAL_SELECTION);
      setRemoved(new Set());
      setKeepOwner(true);
    }
  }

  const plan = planShare(current, removed, picked, projectId);
  const privatePlan = privateOwner ? planPrivateShare(picked, keepOwner, privateOwner.userId) : null;
  const dirty = privateOwner ? privatePlan !== null : plan.add.length + plan.revoke.length > 0;
  const everyoneAfter = privateOwner
    ? picked.everyone === true
    : sharedWithEveryoneAfter(current, removed, picked);
  const everyoneLabel = t('everyone', { project: projectName });

  function invalidate() {
    void invalidatePermissionProbes(queryClient, { accountId });
    queryClient.invalidateQueries({ queryKey: ['connections', projectId] });
    queryClient.invalidateQueries({ queryKey: qk.project.scope(projectId) });
  }

  const save = useMutation({
    mutationFn: async () => {
      if (privateOwner) {
        // Grants and the switch to shared in one server call, so the account
        // is never open to the whole project in between.
        if (privatePlan) await shareConnection(projectId, object.id, privatePlan);
        return;
      }
      await grantConnectionAccess(accountId, projectId, object.id, plan.add);
      await Promise.all(plan.revoke.map((assignmentId) => revokeAssignment(accountId, assignmentId)));
    },
    onSuccess: () => {
      successToast(t('saved'));
      invalidate();
      onOpenChange(false);
      onDone?.({ failedPrincipalIds: [] });
    },
    onError: (error: Error) => {
      // A partial write already changed the audience: show what is true now.
      invalidate();
      errorToast(error.message || t('saveFailed'));
    },
  });

  const toggleRemoved = (grantId: string) =>
    setRemoved((prev) => {
      const next = new Set(prev);
      if (next.has(grantId)) next.delete(grantId);
      else next.add(grantId);
      return next;
    });

  const grantedMemberIds = privateOwner
    ? [privateOwner.userId]
    : current
        .filter((grant) => grant.principal_type === 'member' && !removed.has(grant.grant_id))
        .map((grant) => grant.principal_id);

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (save.isPending) return;
        onOpenChange(next);
      }}
    >
      <ModalContent className="sm:max-w-md">
        <ModalHeader>
          <ModalTitle>{t('shareTitle', { label: object.label })}</ModalTitle>
          <ModalDescription>
            {privateOwner ? t('sharePrivateDescription') : t('shareDescription')}
          </ModalDescription>
        </ModalHeader>

        <ModalBody className="max-h-[60vh] space-y-4 overflow-y-auto">
          <Field className="gap-1.5">
            <FieldLabel>{t('whoCanUse')}</FieldLabel>
            <ul className="space-y-2" data-testid="share-audience">
              {privateOwner ? (
                <AudienceRow
                  avatar={<UserAvatar email={privateOwner.label} size="sm" />}
                  label={privateOwner.label}
                  meta={keepOwner ? t('ownerMeta') : t('removedMeta')}
                  removed={!keepOwner}
                  action={
                    keepOwner ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8 shrink-0"
                        aria-label={t('remove', { name: privateOwner.label })}
                        disabled={save.isPending}
                        onClick={() => setKeepOwner(false)}
                      >
                        <XIcon className="size-3.5" />
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={save.isPending}
                        onClick={() => setKeepOwner(true)}
                      >
                        {t('keep')}
                      </Button>
                    )
                  }
                />
              ) : current.length === 0 ? (
                <AudienceRow
                  avatar={<EntityAvatar icon={UsersThreeIcon} label={everyoneLabel} size="sm" />}
                  label={everyoneLabel}
                  meta={t('everyoneDefaultMeta')}
                />
              ) : (
                current.map((grant) => {
                  const isRemoved = removed.has(grant.grant_id);
                  const label =
                    grant.principal_type === 'project' ? everyoneLabel : grant.label;
                  return (
                    <AudienceRow
                      key={grant.grant_id}
                      avatar={
                        grant.principal_type === 'member' ? (
                          <UserAvatar email={grant.label} size="sm" />
                        ) : (
                          <EntityAvatar
                            icon={grant.principal_type === 'group' ? UsersIcon : UsersThreeIcon}
                            label={label}
                            size="sm"
                          />
                        )
                      }
                      label={label}
                      meta={
                        isRemoved
                          ? t('removedMeta')
                          : grant.principal_type === 'group'
                            ? t('groupMeta')
                            : grant.principal_type === 'member'
                              ? t('memberMeta')
                              : t('everyoneMeta')
                      }
                      removed={isRemoved}
                      action={
                        isRemoved ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={save.isPending}
                            onClick={() => toggleRemoved(grant.grant_id)}
                          >
                            {t('keep')}
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-8 shrink-0"
                            aria-label={t('remove', { name: label })}
                            disabled={save.isPending}
                            onClick={() => toggleRemoved(grant.grant_id)}
                          >
                            <XIcon className="size-3.5" />
                          </Button>
                        )
                      }
                    />
                  );
                })
              )}
            </ul>
          </Field>

          <Field className="gap-1.5">
            <FieldLabel>{t('add')}</FieldLabel>
            <PrincipalPicker
              scope={{ kind: 'project', projectId }}
              selection="multi"
              kinds={['member', 'group']}
              everyone={{ label: everyoneLabel }}
              excludeUserIds={grantedMemberIds}
              value={picked}
              onChange={setPicked}
              disabled={save.isPending}
              autoFocus={false}
              emptyLabel={tI18nComplete.raw('textd2600c68a9ff')}
              allExcludedLabel={tI18nComplete.raw('textf68d7561db3d')}
            />
          </Field>

          <InfoBanner tone="neutral" icon={everyoneAfter ? UsersThreeIcon : LockIcon}>
            <span data-testid="share-result">
              {everyoneAfter
                ? t('resultEveryone', { project: projectName })
                : privateOwner && !privatePlan
                  ? t('onlyYouDescription')
                  : t('resultNarrowed')}
            </span>
          </InfoBanner>
        </ModalBody>

        <ModalFooter className="sm:justify-between">
          <Button
            type="button"
            variant="outline-ghost"
            size="sm"
            disabled={save.isPending}
            onClick={() => onOpenChange(false)}
          >
            {tI18nComplete.raw('text19766ed6ccb2')}
          </Button>
          <Button
            type="button"
            size="sm"
            className="gap-1.5"
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
            {t('save')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

function AudienceRow({
  avatar,
  label,
  meta,
  removed = false,
  action,
}: {
  avatar: React.ReactNode;
  label: string;
  meta: string;
  removed?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <li className="bg-popover flex items-center gap-2.5 rounded-md border px-3 py-2">
      {avatar}
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'block truncate text-sm font-medium',
            removed ? 'text-muted-foreground' : 'text-foreground',
          )}
        >
          {label}
        </span>
        <span className="text-muted-foreground block truncate text-xs">{meta}</span>
      </span>
      {action}
    </li>
  );
}
