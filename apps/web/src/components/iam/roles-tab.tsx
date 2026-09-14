'use client';

import { useTranslations } from '@/i18n/use-translations';
// Roles tab on the account page. ONE list: every role the account has,
// built-in and custom, in the shared `AccessList`/`AccessRow` dialect — plus
// the capability-matrix create/edit dialog (custom roles deactivate
// capabilities by omitting permissions).
//
// This tab DEFINES roles. It no longer assigns them: the "Custom-role
// assignments" table (`policy-assignments.tsx`, deleted 2026-08-18) is gone,
// because a custom role is now just another entry in the ONE `RoleSelect`
// inside `AccessDialog` — so an assignment is made on Members (account scope)
// or Projects (project scope) exactly like a built-in role is, and shows up as
// the row's role there. The muted note under the header points at that.
//
// Built-in roles are read-only; only custom (is_system === false) roles can be
// edited or deleted, and only when canManage is true. Built-ins can be
// duplicated into a new custom role as a starting point. The capability picker
// is `RoleCapabilityMatrix` (§7): areas × View/Edit, with the raw leaf actions
// under an "Advanced" disclosure. The wire format is unchanged — it still sends
// the same leaf strings.

import { invalidatePermissionProbes } from '@kortix/sdk/react';
import {
  CopyIcon as Copy,
  EyeIcon as Eye,
  LockIcon as Lock,
  PencilSimpleIcon,
  PlusIcon as Plus,
  ShieldIcon as Shield,
  TrashIcon as Trash2,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { errorToast, successToast } from '@/components/ui/toast';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import Hint from '@/components/ui/hint';
import { InfoBanner } from '@/components/ui/info-banner';
import { InlineMeta } from '@/components/ui/inline-meta';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import {
  AccessList,
  AccessRow,
  type KebabItem,
  RBAC_UPSELL_MESSAGE,
  builtinRoleDescriptor,
  pluralize,
} from '@/features/workspace/shared/access';
import {
  type IamRole,
  type ResourceType,
  createRole,
  deleteRole,
  getRolePermissions,
  getRoleUsage,
  listPermissions,
  listRoles,
  updateRole,
  updateRolePermissions,
} from '@/lib/iam-client';
import type { AccountRole, ProjectRole } from '@kortix/sdk';
import { RoleCapabilityMatrix } from './role-capability-matrix';

interface RolesTabProps {
  accountId: string;
  canManage: boolean;
  /** Whether the account's tier carries the `rbac` entitlement. Creating or
   * editing custom roles and policy assignments is gated on it server-side
   * (deleting is not — cleanup is always allowed), so those actions are
   * disabled here rather than left to fail with a 402 on submit. */
  rbacEnabled: boolean;
}

/** Prefill payload for opening the create dialog seeded from a built-in role. */
interface RolePrefill {
  name: string;
  resourceType: ResourceType;
  actions: string[];
}

export function RolesTab({ accountId, canManage, rbacEnabled }: RolesTabProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const openDemo = useRequestDemo();
  return (
    <div className="space-y-6">
      {canManage && !rbacEnabled && (
        <InfoBanner
          tone="info"
          title={tI18nComplete.raw('text9d48410d14d3')}
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => openDemo({ source: 'accounts-roles' })}
            >
              {tI18nComplete.raw('text604abea32b49')}
            </Button>
          }
        >
          {RBAC_UPSELL_MESSAGE}
        </InfoBanner>
      )}
      {/* Where the "Custom-role assignments" table used to be. A role is
          defined here and handed out from Members or Projects — say so, so
          nobody hunts for a launcher this tab deliberately no longer has. */}
      <p className="text-muted-foreground text-xs">{tI18nComplete.raw('text019929eebb12')}</p>
      <RolesSection accountId={accountId} canManage={canManage} rbacEnabled={rbacEnabled} />
    </div>
  );
}

// ─── Roles list ────────────────────────────────────────────────────────────

function RolesSection({ accountId, canManage, rbacEnabled }: RolesTabProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [createOpen, setCreateOpen] = useState(false);
  const [createPrefill, setCreatePrefill] = useState<RolePrefill | null>(null);
  const [editTarget, setEditTarget] = useState<IamRole | null>(null);
  const [viewTarget, setViewTarget] = useState<IamRole | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<IamRole | null>(null);

  const rolesQuery = useQuery({
    queryKey: ['iam-roles', accountId],
    queryFn: () => listRoles(accountId),
    staleTime: 30_000,
  });

  // Member and Manager are the only project roles (owner decision 2026-08-18);
  // the engine no longer has an `editor` built-in, so the API list is the list.
  const roles = rolesQuery.data ?? [];

  function openCreate(prefill: RolePrefill | null) {
    setCreatePrefill(prefill);
    setCreateOpen(true);
  }

  const newRoleButton =
    canManage &&
    (rbacEnabled ? (
      <Button size="sm" variant="secondary" onClick={() => openCreate(null)} className="gap-1.5">
        <Plus className="size-4" />
        {tI18nComplete.raw('text500f2f9d3956')}
      </Button>
    ) : (
      <Hint label={RBAC_UPSELL_MESSAGE} side="top" className="max-w-xs">
        <span className="inline-flex items-center gap-1.5">
          <Button size="sm" variant="secondary" className="gap-1.5" disabled>
            <Plus className="size-4" />
            {tI18nComplete.raw('text500f2f9d3956')}
          </Button>
          <Badge variant="outline" size="sm">
            {tI18nComplete.raw('text3fbe5ed156f1')}
          </Badge>
        </span>
      </Hint>
    ));

  // One header — "Roles · N" + New role — in every state, so the primary
  // action never disappears while the list loads or fails. Non-row states
  // ride inside the list as a single item rather than duplicating the header
  // markup around them.
  const settled = !rolesQuery.isLoading && !rolesQuery.isError;

  return (
    <div className="space-y-4">
      <AccessList
        header={{
          title: tI18nComplete.raw('textc25337055464'),
          count: settled ? roles.length : undefined,
          actions: newRoleButton || undefined,
        }}
      >
        {rolesQuery.isError ? (
          <li>
            <ErrorState
              size="sm"
              title={tI18nComplete.raw('text9813c7409f4b')}
              description={(rolesQuery.error as Error)?.message}
              action={
                <Button variant="outline" size="sm" onClick={() => rolesQuery.refetch()}>
                  {tI18nComplete.raw('text942087cc2d41')}
                </Button>
              }
            />
          </li>
        ) : rolesQuery.isLoading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <li key={i}>
              <Skeleton className="h-[58px] w-full rounded-md" />
            </li>
          ))
        ) : roles.length === 0 ? (
          <li>
            <EmptyState
              icon={Shield}
              size="sm"
              title={tI18nComplete.raw('text7ff860eb111a')}
              description={tI18nComplete.raw('text8ae419f2b5b1')}
              action={newRoleButton}
            />
          </li>
        ) : (
          roles.map((role) => (
            <RoleRow
              key={role.role_id}
              accountId={accountId}
              role={role}
              canManage={canManage}
              rbacEnabled={rbacEnabled}
              onEdit={() => setEditTarget(role)}
              onView={() => setViewTarget(role)}
              onDelete={() => setDeleteTarget(role)}
              onDuplicate={(prefill) => openCreate(prefill)}
            />
          ))
        )}
      </AccessList>

      {createOpen && (
        <RoleDialog
          accountId={accountId}
          mode="create"
          prefill={createPrefill}
          open={createOpen}
          onOpenChange={(o) => {
            setCreateOpen(o);
            if (!o) setCreatePrefill(null);
          }}
        />
      )}

      {editTarget && (
        <RoleDialog
          accountId={accountId}
          mode="edit"
          role={editTarget}
          open={!!editTarget}
          onOpenChange={(o) => {
            if (!o) setEditTarget(null);
          }}
        />
      )}

      {viewTarget && (
        <RoleDialog
          accountId={accountId}
          mode="view"
          role={viewTarget}
          open={!!viewTarget}
          onOpenChange={(o) => {
            if (!o) setViewTarget(null);
          }}
        />
      )}

      {deleteTarget && (
        <DeleteRoleConfirm
          accountId={accountId}
          role={deleteTarget}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}

function RoleRow({
  accountId,
  role,
  canManage,
  rbacEnabled,
  onEdit,
  onView,
  onDelete,
  onDuplicate,
}: {
  accountId: string;
  role: IamRole;
  canManage: boolean;
  rbacEnabled: boolean;
  onEdit: () => void;
  onView: () => void;
  onDelete: () => void;
  onDuplicate: (prefill: RolePrefill) => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const isCustom = !role.is_system;
  const queryClient = useQueryClient();
  const [duplicating, setDuplicating] = useState(false);

  const usageQuery = useQuery({
    queryKey: ['iam-role-usage', accountId, role.role_id],
    queryFn: () => getRoleUsage(accountId, role.role_id),
    staleTime: 30_000,
    enabled: isCustom,
  });

  // "You will see what they can do and what they can't" — at a glance, not
  // just after opening Edit. Fetched for every role, built-in included (the
  // same call `handleDuplicate` below already proves works for both); shares
  // its cache key with the edit/view dialog's own `permsQuery`, so opening
  // either after this resolves is instant, not a second round-trip.
  const permsQuery = useQuery({
    queryKey: ['iam-role-permissions', accountId, role.role_id],
    queryFn: () => getRolePermissions(accountId, role.role_id),
    staleTime: 30_000,
  });

  async function handleDuplicate() {
    setDuplicating(true);
    try {
      const perms = await queryClient.fetchQuery({
        queryKey: ['iam-role-permissions', accountId, role.role_id],
        queryFn: () => getRolePermissions(accountId, role.role_id),
        staleTime: 30_000,
      });
      onDuplicate({
        name: `${role.name} copy`,
        resourceType: role.resource_type,
        actions: perms.actions,
      });
    } catch (err) {
      errorToast((err as Error)?.message || tI18nComplete.raw('textb641eac15b51'));
    } finally {
      setDuplicating(false);
    }
  }

  // "What can this role do?" never requires permission to change it, so
  // View capabilities is the one item everybody gets. Everything that writes
  // sits behind `canManage`, and behind `rbacEnabled` on top of that when the
  // backend would 402 (delete is never entitlement-gated — cleanup is always
  // allowed).
  const kebab: KebabItem[] = [
    {
      label: tI18nComplete.raw('text08138c207246'),
      icon: <Eye className="size-3.5" />,
      onSelect: onView,
    },
  ];
  if (canManage && isCustom) {
    kebab.push({
      label: tI18nComplete.raw('text464c4ffd019e'),
      icon: <PencilSimpleIcon className="size-3.5" />,
      onSelect: onEdit,
      disabled: !rbacEnabled,
      hint: rbacEnabled ? undefined : RBAC_UPSELL_MESSAGE,
    });
    kebab.push({
      label: tI18nComplete.raw('textac18d11a2f26'),
      icon: <Trash2 className="size-3.5" />,
      onSelect: onDelete,
      variant: 'destructive',
      separated: true,
    });
  }
  if (canManage && !isCustom) {
    // "Duplicate" is the documented path to "manager minus X".
    kebab.push({
      label: tI18nComplete.raw('text02cdaabfca80'),
      icon: <Copy className="size-3.5" />,
      onSelect: handleDuplicate,
      disabled: !rbacEnabled,
      hint: rbacEnabled ? undefined : RBAC_UPSELL_MESSAGE,
    });
  }

  const capabilityLabel = permsQuery.isError
    ? '— capabilities'
    : permsQuery.isLoading
      ? '… capabilities'
      : pluralize(permsQuery.data?.actions.length ?? 0, 'capability', 'capabilities');

  // A built-in role is described by the SHARED descriptor, not by whatever
  // prose the API row happens to carry — the Roles list, the role Select and
  // the Help page must read identically. (`user` is the project floor role's
  // API key; the descriptor calls it `member`.)
  const descriptor = isCustom
    ? undefined
    : builtinRoleDescriptor(
        role.resource_type === 'account' ? 'account' : 'project',
        (role.key === 'user' ? 'member' : role.key) as AccountRole | ProjectRole,
        tI18nComplete,
      );
  // Same rule for the NAME: the API calls the project floor role
  // "Member (read + run)", the select and the Help page call it "Member".
  // One name per role, everywhere.
  const title = descriptor?.label ?? role.name;
  const description = isCustom ? role.description : (descriptor?.summary ?? role.description);

  const usageLabel = !isCustom
    ? null
    : usageQuery.isError
      ? 'used by —'
      : usageQuery.isLoading
        ? 'used by …'
        : `used by ${usageQuery.data?.policy_count ?? 0}`;

  return (
    <AccessRow
      leading={<EntityAvatar icon={Shield} label={title} size="sm" />}
      title={title}
      badges={
        role.is_system ? (
          <Hint label={tI18nComplete.raw('textc333cb48148a')} side="top">
            <span className="inline-flex">
              <Badge variant="muted" size="sm" className="gap-1 font-normal">
                <Lock className="size-3" />
                {tI18nComplete.raw('text1f43948106d1')}
              </Badge>
            </span>
          </Hint>
        ) : (
          <Badge variant="outline" size="sm" className="font-normal">
            {tI18nComplete.raw('text494ca78f7374')}
          </Badge>
        )
      }
      meta={
        <div className="space-y-0.5">
          <InlineMeta>
            <span className="font-mono">{role.key}</span>
            <span>{role.resource_type === 'account' ? 'Account' : 'Project'}</span>
            <span>{capabilityLabel}</span>
            {usageLabel ? <span>{usageLabel}</span> : null}
          </InlineMeta>
          {description ? (
            <p className="text-muted-foreground truncate text-xs">{description}</p>
          ) : null}
        </div>
      }
      kebab={kebab}
      kebabLabel={tI18nComplete('text33da220b1a34', { value0: title })}
      pending={duplicating}
    />
  );
}

// ─── Create / edit dialog (capability matrix) ───────────────────────────────

const KEY_RE = /^[a-z0-9_]{2,64}$/;

function slugifyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

function RoleDialog({
  accountId,
  mode,
  role,
  prefill,
  open,
  onOpenChange,
}: {
  accountId: string;
  /** 'view' is read-only — everyone gets it (including non-managers and on
   *  built-in roles), not just people who can edit. "What can this role
   *  actually do?" should never require permission to change it. */
  mode: 'create' | 'edit' | 'view';
  role?: IamRole;
  prefill?: RolePrefill | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const queryClient = useQueryClient();
  const isView = mode === 'view';
  const isEdit = mode === 'edit' && !!role;
  // Both edit and view load the role's existing grant set into the matrix —
  // view just never lets it change.
  const hasExistingRole = (mode === 'edit' || mode === 'view') && !!role;

  const [name, setName] = useState(role?.name ?? prefill?.name ?? '');
  const [keyValue, setKeyValue] = useState(role?.key ?? (prefill ? slugifyKey(prefill.name) : ''));
  const [keyTouched, setKeyTouched] = useState(isEdit);
  const [description, setDescription] = useState(role?.description ?? '');
  const [resourceType, setResourceType] = useState<ResourceType>(
    role?.resource_type ?? prefill?.resourceType ?? 'project',
  );
  const [selected, setSelected] = useState<Set<string>>(() => new Set(prefill?.actions ?? []));

  // The permission CATALOG — action, area, level, implies, delegable. The
  // matrix builds its whole table from this; nothing about the grouping or the
  // implication rules lives in the client any more.
  const actionsQuery = useQuery({
    queryKey: ['iam-permissions', accountId],
    queryFn: () => listPermissions(accountId),
    staleTime: 30_000,
  });

  // Pre-fill the matrix selection for an edit OR a view — both read the
  // role's existing grant set, view just never writes it back.
  const permsQuery = useQuery({
    queryKey: ['iam-role-permissions', accountId, role?.role_id],
    queryFn: () => getRolePermissions(accountId, role!.role_id),
    staleTime: 30_000,
    enabled: hasExistingRole,
  });

  // Seed selected from loaded permissions once the query resolves. Keyed on
  // the resolved data so we never toggle against a not-yet-seeded set.
  useEffect(() => {
    if (hasExistingRole && permsQuery.data) {
      setSelected(new Set(permsQuery.data.actions));
    }
  }, [hasExistingRole, permsQuery.data]);

  const keyValid = KEY_RE.test(keyValue);
  const nameValid = name.trim().length > 0;

  function handleNameChange(value: string) {
    setName(value);
    if (!isEdit && !keyTouched) {
      setKeyValue(slugifyKey(value));
    }
  }

  const createMutation = useMutation({
    mutationFn: () =>
      createRole(accountId, {
        key: keyValue,
        name: name.trim(),
        description: description.trim() || undefined,
        resourceType,
        actions: [...selected],
      }),
    onSuccess: () => {
      successToast(tI18nComplete.raw('text4b36ce9864db'));
      queryClient.invalidateQueries({ queryKey: ['iam-roles', accountId] });
      onOpenChange(false);
    },
    onError: (err: Error) => errorToast(err.message || tI18nComplete.raw('textc49c15ddba4b')),
  });

  const updateMutation = useMutation({
    mutationFn: async () => {
      const nameChanged = name.trim() !== role!.name;
      const descChanged = (description.trim() || null) !== (role!.description ?? null);
      if (nameChanged || descChanged) {
        await updateRole(accountId, role!.role_id, {
          name: name.trim(),
          description: description.trim() || null,
        });
      }
      await updateRolePermissions(accountId, role!.role_id, [...selected]);
    },
    onSuccess: () => {
      successToast(tI18nComplete.raw('texta172f7fb3563'));
      // A role's PERMISSION SET changed, so every verdict for every principal
      // holding it moved. Nothing here can enumerate them — bust the account.
      void invalidatePermissionProbes(queryClient, { accountId });
      queryClient.invalidateQueries({ queryKey: ['iam-roles', accountId] });
      queryClient.invalidateQueries({
        queryKey: ['iam-role-permissions', accountId, role!.role_id],
      });
      onOpenChange(false);
    },
    onError: (err: Error) => errorToast(err.message || tI18nComplete.raw('texte4143613f121')),
  });

  const mutation = isEdit ? updateMutation : createMutation;
  const isPending = mutation.isPending;
  const matrixLoading = actionsQuery.isLoading || (hasExistingRole && permsQuery.isLoading);
  const matrixError = actionsQuery.isError || (hasExistingRole && permsQuery.isError);
  // The matrix only mounts once the catalog AND (in edit/view) the role's own
  // grant set have resolved, so an admin never toggles against a not-yet-seeded
  // set. View mode renders it disabled.

  const submitDisabled =
    isPending || !nameValid || (!isEdit && !keyValid) || matrixLoading || matrixError;

  return (
    <Modal open={open} onOpenChange={(o) => !isPending && onOpenChange(o)}>
      <ModalContent className="max-h-[90vh] lg:max-h-[85vh] lg:max-w-2xl">
        <ModalHeader>
          <ModalTitle>
            {isView
              ? tI18nComplete.raw('text3dc32dfa31f9')
              : isEdit
                ? tI18nComplete.raw('texte2afdd4eef04')
                : tI18nComplete.raw('text500f2f9d3956')}
          </ModalTitle>
          <ModalDescription>
            {isView
              ? tI18nComplete('text749f923c962d', {
                  value0: role?.name ?? tI18nComplete.raw('texte73679634b64'),
                })
              : tI18nComplete.raw('text7c30649a46d8')}
          </ModalDescription>
        </ModalHeader>

        <ModalBody className="max-h-[65vh] space-y-4 overflow-y-auto">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="role-name">{tI18nComplete.raw('textdcd1d5223f73')}</Label>
              <Input
                id="role-name"
                value={name}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder={tI18nComplete.raw('text5cb975ae5c6b')}
                disabled={isPending || isView}
                autoFocus={!isView}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="role-key">{tI18nComplete.raw('text99a52df3ff3d')}</Label>
              <Input
                id="role-key"
                value={keyValue}
                onChange={(e) => {
                  setKeyTouched(true);
                  setKeyValue(e.target.value);
                }}
                placeholder={tI18nComplete.raw('textb96d63115850')}
                disabled={isPending || isEdit || isView}
                className="font-mono"
              />
              {!isEdit && keyValue.length > 0 && !keyValid && (
                <p className="text-destructive text-xs">{tI18nComplete.raw('textc949fc224fb5')}</p>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="role-description">{tI18nComplete.raw('textf6cbe2f0c1f8')}</Label>
            <Textarea
              id="role-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={tI18nComplete.raw('text979f4dd1cea4')}
              disabled={isPending || isView}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="role-resource-type">{tI18nComplete.raw('text6687458beee5')}</Label>
            <Select
              value={resourceType}
              onValueChange={(v) => {
                setResourceType(v as ResourceType);
                if (!isEdit) setSelected(new Set());
              }}
              disabled={isPending || isEdit || isView}
            >
              <SelectTrigger id="role-resource-type" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="project">{tI18nComplete.raw('text985959785319')}</SelectItem>
                <SelectItem value="account">{tI18nComplete.raw('text7e1b0d5641f2')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {matrixError ? (
            <div className="space-y-2">
              <Label>{tI18nComplete.raw('text9460f16ac9b5')}</Label>
              <div className="bg-popover rounded-md border px-4 py-3">
                <ErrorState
                  size="sm"
                  title={tI18nComplete.raw('text72934bcb9486')}
                  description={((actionsQuery.error || permsQuery.error) as Error)?.message}
                  action={
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        actionsQuery.refetch();
                        if (hasExistingRole) permsQuery.refetch();
                      }}
                    >
                      {tI18nComplete.raw('text942087cc2d41')}
                    </Button>
                  }
                />
              </div>
            </div>
          ) : matrixLoading ? (
            <div className="space-y-2">
              <Label>{tI18nComplete.raw('text9460f16ac9b5')}</Label>
              <Skeleton className="h-64 w-full rounded-md" />
            </div>
          ) : (
            <RoleCapabilityMatrix
              scope={resourceType === 'account' ? 'account' : 'project'}
              permissions={actionsQuery.data}
              selected={selected}
              onChange={setSelected}
              disabled={isView || isPending}
            />
          )}
        </ModalBody>

        <ModalFooter className={isView ? undefined : 'sm:justify-between'}>
          <Button
            type="button"
            variant="outline-ghost"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            {isView ? 'Close' : 'Cancel'}
          </Button>
          {!isView && (
            <Button onClick={() => mutation.mutate()} disabled={submitDisabled} className="gap-1.5">
              {isPending && <Loading className="size-4 shrink-0" />}
              {isEdit
                ? tI18nComplete.raw('textdd0ae7a5cbcf')
                : tI18nComplete.raw('text221163d6e73f')}
            </Button>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

// ─── Delete ─────────────────────────────────────────────────────────────────

function DeleteRoleConfirm({
  accountId,
  role,
  onClose,
}: {
  accountId: string;
  role: IamRole;
  onClose: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const queryClient = useQueryClient();

  const usageQuery = useQuery({
    queryKey: ['iam-role-usage', accountId, role.role_id],
    queryFn: () => getRoleUsage(accountId, role.role_id),
    staleTime: 30_000,
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteRole(accountId, role.role_id),
    onSuccess: () => {
      successToast(tI18nComplete.raw('textccc3a7846d02'));
      void invalidatePermissionProbes(queryClient, { accountId });
      queryClient.invalidateQueries({ queryKey: ['iam-roles', accountId] });
      onClose();
    },
    onError: (err: Error) => errorToast(err.message || tI18nComplete.raw('texta96e1f43f497')),
  });

  const count = usageQuery.data?.policy_count ?? 0;
  const policies = count === 1 ? 'policy' : 'policies';

  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={tI18nComplete.raw('textac18d11a2f26')}
      description={tI18nComplete('text8295f8601ed8', { value0: count, value1: policies })}
      confirmLabel={tI18nComplete.raw('texte2d0a54968ea')}
      confirmVariant="destructive"
      isPending={deleteMutation.isPending}
      onConfirm={() => deleteMutation.mutate()}
    />
  );
}
