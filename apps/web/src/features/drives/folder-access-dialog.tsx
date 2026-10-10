'use client';

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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { UserAvatar } from '@/components/ui/user-avatar';
import { useAuth } from '@/features/providers/auth-provider';
import { useProjectAgentIdentities } from '@/features/workspace/shared/access/agent-principals';
import {
  EMPTY_PRINCIPAL_SELECTION,
  PrincipalPicker,
  type PrincipalSelection,
} from '@/features/workspace/shared/access/principal-picker';
import { useFolderAccess, useFolderPrincipals, useShareFolder, useUnshareFolder } from '@/hooks/drives/use-drives';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import type { FolderGrant, FolderLevel, FolderPrincipalType } from '@kortix/sdk';
import { LockIcon, RobotIcon, UsersIcon, UsersThreeIcon, XIcon } from '@phosphor-icons/react';
import { type ReactNode, useId, useMemo, useState } from 'react';

import {
  type FolderAccessDraft,
  type FolderAudienceMode,
  type NamedAccess,
  folderAudience,
  namedKey,
  planFolderAccess,
} from './folder-audience';

export const FOLDER_LEVELS: FolderLevel[] = ['read', 'write', 'manage'];

export function folderName(path: string, root: string): string {
  return path === '/' ? root : (path.split('/').filter(Boolean).pop() ?? root);
}

/** A grant's avatar: a person's initials, or the team / agent / project glyph. */
export function GrantAvatar({ type, label }: { type: FolderPrincipalType; label: string }) {
  if (type === 'user') return <UserAvatar email={label} size="sm" />;
  const icon = type === 'group' ? UsersIcon : type === 'agent' ? RobotIcon : UsersThreeIcon;
  return <EntityAvatar icon={icon} label={label} size="sm" />;
}

/** One row of an access list, the same row the agent and account share dialogs draw. */
export function AccessRow({
  avatar,
  label,
  meta,
  action,
  muted = false,
}: {
  avatar: ReactNode;
  label: string;
  meta?: string;
  action?: ReactNode;
  muted?: boolean;
}) {
  return (
    <li className="bg-popover flex items-center gap-2.5 rounded-md border px-3 py-2">
      {avatar}
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate text-sm font-medium', muted ? 'text-muted-foreground' : 'text-foreground')}>
          {label}
        </span>
        {meta ? <span className="text-muted-foreground block truncate text-xs">{meta}</span> : null}
      </span>
      {action}
    </li>
  );
}

function LevelSelect({
  value,
  onChange,
  disabled,
  label,
}: {
  value: FolderLevel;
  onChange: (level: FolderLevel) => void;
  disabled?: boolean;
  label: string;
}) {
  const t = useTranslations('drives');
  return (
    <Select value={value} onValueChange={(v) => onChange(v as FolderLevel)} disabled={disabled}>
      <SelectTrigger size="sm" className="w-28 shrink-0" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {FOLDER_LEVELS.map((l) => (
          <SelectItem key={l} value={l}>
            {t(`level.${l}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Who can open one folder of Files, in the same shape as choosing who can use
 * an agent or a connector account: everyone in the project, admins only (in a
 * person's own folder, only them), or specific people, teams and agents, each
 * at view, edit or share. Nothing is written until Save, and the server
 * checks every write: only someone who may share the folder can change it.
 */
export function FolderAccessDialog({
  driveId,
  projectId,
  path,
  open,
  onOpenChange,
}: {
  driveId: string;
  projectId: string;
  path: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('drives');
  const access = useFolderAccess(driveId, path, open);
  const ready = open && !!access.data && access.data.path === path;
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="sm:max-w-lg">
        <ModalHeader>
          <ModalTitle>{t('shareTitle', { name: folderName(path, t('files')) })}</ModalTitle>
          <ModalDescription>{t('folderAccessDescription')}</ModalDescription>
        </ModalHeader>
        {ready ? (
          <FolderAccessForm
            // A fresh draft for every folder and every opening.
            key={`${path}:${access.dataUpdatedAt}`}
            driveId={driveId}
            projectId={projectId}
            path={path}
            grants={access.data!.grants}
            canManage={access.data!.access === 'manage' && access.data!.grantable}
            grantable={access.data!.grantable}
            onDone={() => onOpenChange(false)}
          />
        ) : (
          <ModalBody>
            <Skeleton className="h-40 w-full" />
          </ModalBody>
        )}
      </ModalContent>
    </Modal>
  );
}

function FolderAccessForm({
  driveId,
  projectId,
  path,
  grants,
  canManage,
  grantable,
  onDone,
}: {
  driveId: string;
  projectId: string;
  path: string;
  grants: FolderGrant[];
  canManage: boolean;
  grantable: boolean;
  onDone: () => void;
}) {
  const t = useTranslations('drives');
  const id = useId();
  const { user } = useAuth();
  const current = useMemo(() => folderAudience(grants), [grants]);
  const [draft, setDraft] = useState<FolderAccessDraft>(() => ({
    mode: current.inheritedEveryone ? 'everyone' : current.mode,
    everyoneLevel: current.everyoneLevel,
    named: current.named,
  }));
  const principals = useFolderPrincipals(driveId, canManage);
  const identities = useProjectAgentIdentities(projectId, canManage);
  const share = useShareFolder();
  const unshare = useUnshareFolder();
  const [saving, setSaving] = useState(false);

  const plan = planFolderAccess(current, draft);
  const dirty = plan.put.length + plan.remove.length > 0;
  const locked = !canManage || saving;
  const inheritedEveryone = current.inheritedEveryone;

  const restrictedLabel = current.owner
    ? current.owner.principalId === user?.id
      ? t('audienceOnlyYou')
      : t('audienceOnlyOwner', { name: current.owner.label })
    : t('audienceAdmins');
  const restrictedDescription = current.owner ? t('audienceOwnerDescription') : t('audienceAdminsDescription');

  // New picks join the list at "Can edit"; the picker itself stays empty.
  const onPick = (next: PrincipalSelection) => {
    const have = new Set(draft.named.map(namedKey));
    const added: NamedAccess[] = [];
    const label = (list: Array<{ id: string; label: string }> | undefined, pickedId: string) =>
      list?.find((x) => x.id === pickedId)?.label ?? pickedId;
    for (const memberId of next.memberIds) added.push({ type: 'user', id: memberId, label: label(principals.data?.people, memberId), level: 'write' });
    for (const groupId of next.groupIds) added.push({ type: 'group', id: groupId, label: label(principals.data?.teams, groupId), level: 'write' });
    for (const saId of next.agentIds ?? []) {
      // The picker names an agent by its service account; a folder share names it by the agent's name.
      const name = identities.data?.find((a) => a.service_account_id === saId)?.agent_name;
      if (name) added.push({ type: 'agent', id: name, label: name, level: 'write' });
    }
    const fresh = added.filter((n) => !have.has(namedKey(n)));
    if (fresh.length) setDraft((d) => ({ ...d, mode: d.mode === 'restricted' ? 'specific' : d.mode, named: [...d.named, ...fresh] }));
  };

  const save = async () => {
    setSaving(true);
    try {
      for (const p of plan.put) await share.mutateAsync({ driveId, path, ...p });
      for (const grantId of plan.remove) await unshare.mutateAsync({ driveId, grantId });
      successToast(t('shared'));
      onDone();
    } catch (err) {
      errorToast(err instanceof Error && err.message ? err.message : t('shareFailed'));
    } finally {
      setSaving(false);
    }
  };

  const showNamed = draft.mode !== 'restricted';
  const result =
    draft.mode === 'everyone'
      ? t('resultEveryone')
      : draft.mode === 'restricted' || draft.named.length === 0
        ? current.owner
          ? restrictedLabel
          : t('resultAdmins')
        : t('resultSpecific', { count: draft.named.length });
  const namedMemberIds = draft.named.filter((n) => n.type === 'user').map((n) => n.id);

  return (
    <>
      <ModalBody className="max-h-[60vh] space-y-4 overflow-y-auto">
        {!grantable ? (
          <p className="text-muted-foreground text-sm">{t('notGrantable')}</p>
        ) : (
          <>
            <Field className="gap-1.5">
              <FieldLabel>{t('whoCanAccess')}</FieldLabel>
              <RadioGroup
                value={draft.mode}
                onValueChange={(mode) => setDraft((d) => ({ ...d, mode: mode as FolderAudienceMode }))}
                className="space-y-2"
              >
                <RadioGroupItem
                  value="everyone"
                  id={`${id}-everyone`}
                  label={t('everyoneInProject')}
                  description={t('audienceEveryoneDescription')}
                  size="lg"
                  variant="outline"
                  disabled={locked}
                />
                <RadioGroupItem
                  value="restricted"
                  id={`${id}-restricted`}
                  label={restrictedLabel}
                  description={restrictedDescription}
                  size="lg"
                  variant="outline"
                  disabled={locked || !!inheritedEveryone}
                />
                <RadioGroupItem
                  value="specific"
                  id={`${id}-specific`}
                  label={t('audienceSpecific')}
                  description={t('audienceSpecificDescription')}
                  size="lg"
                  variant="outline"
                  disabled={locked || !!inheritedEveryone}
                />
              </RadioGroup>
              {inheritedEveryone ? (
                <p className="text-muted-foreground text-xs">{t('inheritedEveryoneNote', { path: inheritedEveryone.path })}</p>
              ) : null}
            </Field>

            {draft.mode === 'everyone' && !inheritedEveryone ? (
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm">{t('everyoneCan')}</span>
                <LevelSelect
                  value={draft.everyoneLevel}
                  onChange={(everyoneLevel) => setDraft((d) => ({ ...d, everyoneLevel }))}
                  disabled={locked}
                  label={t('everyoneCan')}
                />
              </div>
            ) : null}

            {showNamed ? (
              <Field className="gap-1.5">
                <FieldLabel>{draft.mode === 'everyone' ? t('alsoNamed') : t('peopleWithAccess')}</FieldLabel>
                {draft.named.length > 0 ? (
                  <ul className="space-y-2">
                    {draft.named.map((n) => (
                      <AccessRow
                        key={namedKey(n)}
                        avatar={<GrantAvatar type={n.type} label={n.label} />}
                        label={n.type === 'agent' ? t('agentLabel', { name: n.label }) : n.label}
                        meta={n.type === 'agent' ? t('agentMountsMeta') : n.type === 'group' ? t('teamMeta') : undefined}
                        action={
                          canManage ? (
                            <div className="flex items-center gap-1">
                              <LevelSelect
                                value={n.level}
                                disabled={locked}
                                label={t('levelFor', { name: n.label })}
                                onChange={(level) =>
                                  setDraft((d) => ({
                                    ...d,
                                    named: d.named.map((x) => (namedKey(x) === namedKey(n) ? { ...x, level } : x)),
                                  }))
                                }
                              />
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="size-8 shrink-0"
                                aria-label={t('removeAccess', { name: n.label })}
                                disabled={locked}
                                onClick={() =>
                                  setDraft((d) => ({ ...d, named: d.named.filter((x) => namedKey(x) !== namedKey(n)) }))
                                }
                              >
                                <XIcon className="size-3.5" />
                              </Button>
                            </div>
                          ) : (
                            <span className="text-muted-foreground shrink-0 text-xs">{t(`level.${n.level}`)}</span>
                          )
                        }
                      />
                    ))}
                  </ul>
                ) : null}
                {canManage ? (
                  <PrincipalPicker
                    scope={{ kind: 'project', projectId }}
                    selection="multi"
                    kinds={['member', 'group', 'agent']}
                    excludeUserIds={namedMemberIds}
                    value={EMPTY_PRINCIPAL_SELECTION}
                    onChange={onPick}
                    disabled={locked}
                    autoFocus={false}
                    searchPlaceholder={t('addAccess')}
                  />
                ) : null}
              </Field>
            ) : null}

            {current.inherited.length > 0 ? (
              <Field className="gap-1.5">
                <FieldLabel>{t('inheritedTitle')}</FieldLabel>
                <ul className="space-y-2">
                  {current.inherited.map((g) => (
                    <AccessRow
                      key={g.grantId}
                      muted
                      avatar={<GrantAvatar type={g.principalType} label={g.label} />}
                      label={g.principalType === 'project' ? t('everyoneInProject') : g.principalType === 'agent' ? t('agentLabel', { name: g.label }) : g.label}
                      meta={t('inheritedFrom', { path: g.path })}
                      action={<span className="text-muted-foreground shrink-0 text-xs">{t(`level.${g.level}`)}</span>}
                    />
                  ))}
                </ul>
              </Field>
            ) : null}

            <InfoBanner tone="neutral" icon={draft.mode === 'everyone' ? UsersThreeIcon : LockIcon}>
              <span data-testid="folder-access-result">{result}</span>
            </InfoBanner>
            {!canManage ? <p className="text-muted-foreground text-xs">{t('viewOnlyAccess')}</p> : null}
          </>
        )}
      </ModalBody>
      <ModalFooter className="sm:justify-between">
        <Button type="button" variant="outline-ghost" size="sm" disabled={saving} onClick={onDone}>
          {t('cancel')}
        </Button>
        {canManage ? (
          <Button type="button" size="sm" className="gap-1.5" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? <Loading className="size-3.5 shrink-0" /> : null}
            {t('save')}
          </Button>
        ) : null}
      </ModalFooter>
    </>
  );
}
