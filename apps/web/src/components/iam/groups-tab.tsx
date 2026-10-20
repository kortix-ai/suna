'use client';

import { useTranslations } from '@/i18n/use-translations';

// Groups tab on the account page. A picker (the list) or, when the hub's
// `?group=<id>` param is set, that group's `GroupAccessPanel` — the exact
// split `AccessProjectsTab` uses for `?project=<id>`. Opening a group used to
// leave the hub for a standalone route, which dropped the left rail and read
// as a different product next to the project panel; now it stays in the pane.
//
// Each row is the shared `AccessRow`, flattened to a Linear list row — the row every other
// access surface renders. Only `CreateGroupDialog` stays local: it DEFINES a
// group, it does not grant access, so it is not an `AccessDialog` mode.

import { contract, invalidatePermissionProbes } from '@kortix/sdk/react';
import {
  ArrowRightIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  TrashIcon,
  UsersIcon,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useMemo, useState } from 'react';

import { EnterpriseUpsell } from '@/components/iam/enterprise-upsell';
import { GroupAccessPanel } from '@/components/iam/group-access-panel';
import { Badge } from '@kortix/ui/badge';
import { Button } from '@kortix/ui/button';
import { ConfirmDialog } from '@kortix/ui/confirm-dialog';
import { EntityAvatar } from '@kortix/ui/entity-avatar';
import Hint from '@kortix/ui/hint';
import { Input } from '@kortix/ui/input';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@kortix/ui/input-group';
import { Label } from '@kortix/ui/label';
import Loading from '@kortix/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@kortix/ui/modal';
import { Skeleton } from '@kortix/ui/skeleton';
import { errorToast, successToast } from '@kortix/ui/toast';
import { EmptyState } from '@kortix/ui/empty-state';
import { ErrorState } from '@kortix/ui/error-state';
import { AccessRow } from '@kortix/ui/access';
import { RBAC_UPSELL_MESSAGE, pluralize } from '@kortix/ui/access/access/index';
import { type AccountGroup, createGroup, deleteGroup, listGroups } from '@/lib/iam-client';

/** A Linear list row: flat on the page, a hover fill, no border or card.
 *  Overrides `AccessRow`'s card dialect through its `className`. */
const FLAT_ROW_CLASS = 'hover:bg-hover rounded-md border-0 bg-transparent px-3 py-2';

interface GroupsTabProps {
  accountId: string;
  /** Drives visibility of the "Create a group" button and the per-row
   * delete option. Sourced from a usePermission(group.create) probe at
   * the page level so plain admins with explicit policies see it too. */
  canCreate: boolean;
  /** Whether the account's tier carries the `rbac` entitlement. Creating a
   * group is gated on it server-side (deleting is not — cleanup is always
   * allowed), so the create action is disabled here rather than left to
   * fail with a 402 on submit. */
  rbacEnabled: boolean;
  /** `role.read` / `policy.read` — the leaves `GET .../iam/roles` and
   * `GET .../iam/policies` assert. Forwarded to `GroupAccessPanel`, which is
   * the only thing here that reads either. PERMISSION, a different axis from
   * the `rbacEnabled` entitlement above: the hub resolves both in its one
   * batched probe, so this thread costs no extra request. */
  canReadRoles: boolean;
  canReadPolicies: boolean;
  /** Group member rows: account name for the role dialog copy. */
  accountName?: string;
  /** Group member rows hide "Edit access" on the caller's own row. */
  currentUserId: string;
  /** `member.update` — group member rows offer "Edit access" (account role). */
  canUpdateRole: boolean;
  /** `member.read` — "View access" on another member's row. */
  canReadMembers: boolean;
  /** Group member rows: "View access" opens that member's panel. */
  onSelectMember: (userId: string) => void;
  /** null = show the group list. A group id = show that group's access panel.
   *  Controlled by the account page's `?group=` param, exactly like
   *  `AccessProjectsTab`'s `?project=`. */
  selectedGroupId: string | null;
  onSelectGroup: (id: string | null) => void;
}

export function GroupsTab({
  accountId,
  canCreate,
  rbacEnabled,
  canReadRoles,
  canReadPolicies,
  accountName,
  currentUserId,
  canUpdateRole,
  canReadMembers,
  onSelectMember,
  selectedGroupId,
  onSelectGroup,
}: GroupsTabProps) {
  if (selectedGroupId) {
    return (
      <GroupAccessPanel
        key={selectedGroupId}
        accountId={accountId}
        groupId={selectedGroupId}
        rbacEnabled={rbacEnabled}
        canReadRoles={canReadRoles}
        canReadPolicies={canReadPolicies}
        accountName={accountName}
        currentUserId={currentUserId}
        canUpdateRole={canUpdateRole}
        canReadMembers={canReadMembers}
        onSelectMember={onSelectMember}
        onBack={() => onSelectGroup(null)}
      />
    );
  }
  return (
    <GroupsList
      accountId={accountId}
      canCreate={canCreate}
      rbacEnabled={rbacEnabled}
      onSelectGroup={onSelectGroup}
    />
  );
}

function GroupsList({
  accountId,
  canCreate,
  rbacEnabled,
  onSelectGroup,
}: {
  accountId: string;
  canCreate: boolean;
  rbacEnabled: boolean;
  onSelectGroup: (id: string) => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<AccountGroup | null>(null);

  const groupsQuery = useQuery({
    queryKey: ['account-groups', accountId],
    queryFn: () => listGroups(accountId),
    ...contract('directory'),
  });

  const deleteMutation = useMutation({
    mutationFn: (groupId: string) => deleteGroup(accountId, groupId),
    onSuccess: () => {
      successToast(tHardcodedUi.raw('i18nComplete.textff2857a72bfa'));
      void invalidatePermissionProbes(queryClient, { accountId });
      queryClient.invalidateQueries({ queryKey: ['account-groups', accountId] });
      setDeleteTarget(null);
    },
    onError: (err: Error) =>
      errorToast(err.message || tHardcodedUi.raw('i18nComplete.text7924ed958d5b')),
  });

  const filtered = useMemo(() => {
    const all = groupsQuery.data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (g) =>
        g.name.toLowerCase().includes(q) || (g.description?.toLowerCase().includes(q) ?? false),
    );
  }, [groupsQuery.data, search]);

  const total = groupsQuery.data?.length ?? 0;
  const settled = !groupsQuery.isLoading && !groupsQuery.isError;
  // A tier without `rbac` and no groups has nothing to manage here: the page
  // is the Enterprise upsell alone, never an empty "No groups yet" list.
  // Groups that already exist (made before a downgrade, or synced) still list,
  // so they can be opened and cleaned up — deleting is never gated.
  const upsellOnly = settled && !rbacEnabled && total === 0;

  const createAction =
    canCreate && settled && !upsellOnly ? (
      rbacEnabled ? (
        <Button onClick={() => setCreateOpen(true)} size="sm" variant="secondary" className="gap-1.5">
          <PlusIcon className="size-4" />
          {tHardcodedUi.raw('i18nComplete.texte3c4877576de')}
        </Button>
      ) : (
        <Hint label={RBAC_UPSELL_MESSAGE} side="top" className="max-w-xs">
          <span className="inline-flex">
            <Button size="sm" variant="secondary" className="gap-1.5" disabled>
              <PlusIcon className="size-4" />
              {tHardcodedUi.raw('i18nComplete.texte3c4877576de')}
            </Button>
          </span>
        </Hint>
      )
    ) : null;

  // Stays in the hub: the account page turns this into
  // `?tab=groups&group=<id>` and mounts `GroupAccessPanel` in this same pane.
  const openGroup = onSelectGroup;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-0.5">
          <p className="text-foreground text-sm font-medium">
            {tHardcodedUi.raw('i18nComplete.text39bbb719fa2b')}
          </p>
          <p className="text-muted-foreground text-xs">
            {tHardcodedUi.raw(
              'autoComponentsIamGroupsTabJsxAttrDescriptionBundleMembersTogether2839aadc',
            )}
          </p>
        </div>
        {createAction}
      </div>

      {upsellOnly ? <EnterpriseUpsell feature="groups" accountId={accountId} /> : null}

      {/* Search narrows a list. With no groups there is nothing to narrow. */}
      {settled && total > 0 ? (
        <InputGroupSearch>
          <InputGroupSearchIcon>
            <MagnifyingGlassIcon />
          </InputGroupSearchIcon>
          <InputGroupSearchInput
            placeholder={tHardcodedUi.raw('i18nComplete.textd16be1a95200')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search ? <InputGroupSearchClear onClick={() => setSearch('')} /> : null}
        </InputGroupSearch>
      ) : null}

      {groupsQuery.isError && (
        <ErrorState
          size="sm"
          title={tHardcodedUi.raw('i18nComplete.textab76ead329cc')}
          description={(groupsQuery.error as Error)?.message}
          action={
            <Button variant="outline" size="sm" onClick={() => groupsQuery.refetch()}>
              {tHardcodedUi.raw('i18nComplete.text942087cc2d41')}
            </Button>
          }
        />
      )}

      {groupsQuery.isLoading && (
        <div className="space-y-1">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-11 w-full rounded-md" />
          ))}
        </div>
      )}

      {settled && !upsellOnly && filtered.length === 0 && (
        <EmptyState
          size="sm"
          title={
            search
              ? tHardcodedUi.raw('i18nComplete.text912c257cf5b2')
              : tHardcodedUi.raw('i18nComplete.text07514d065adb')
          }
          description={
            !search && canCreate ? tHardcodedUi.raw('i18nComplete.texte268202ba9f5') : undefined
          }
        />
      )}

      {settled && filtered.length > 0 && (
        // Linear-style list: flat rows on the page, a hover fill, no card per row.
        <ul className="-mx-2 flex flex-col gap-px">
          {filtered.map((g) => (
            <AccessRow
              key={g.group_id}
              className={FLAT_ROW_CLASS}
              leading={<EntityAvatar icon={UsersIcon} size="sm" />}
              title={g.name}
              badges={
                g.source === 'scim' ? (
                  <Badge
                    variant="outline"
                    size="sm"
                    title={tHardcodedUi.raw('i18nComplete.text2aa5f5cc5cac')}
                  >
                    {tHardcodedUi.raw('i18nComplete.text2d83971aa73e')}
                  </Badge>
                ) : null
              }
              metaParts={[g.description || null].filter(Boolean)}
              trailing={
                <span className="tabular-nums">
                  {[
                    pluralize(g.member_count ?? 0, 'member'),
                    pluralize(g.project_count ?? 0, 'project'),
                  ].join(' · ')}
                </span>
              }
              onClick={() => openGroup(g.group_id)}
              kebabLabel={tHardcodedUi('i18nComplete.text33da220b1a34', { value0: g.name })}
              kebab={[
                {
                  label: tHardcodedUi.raw('i18nComplete.texted077f3d8125'),
                  icon: <ArrowRightIcon className="size-3.5" />,
                  onSelect: () => openGroup(g.group_id),
                },
                ...(canCreate
                  ? [
                      {
                        label: tHardcodedUi.raw('i18nComplete.text3f7374ac08ea'),
                        icon: <TrashIcon className="size-3.5" />,
                        variant: 'destructive' as const,
                        separated: true,
                        onSelect: () => setDeleteTarget(g),
                      },
                    ]
                  : []),
              ]}
            />
          ))}
        </ul>
      )}

      <CreateGroupDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        accountId={accountId}
        onCreated={onSelectGroup}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={tHardcodedUi.raw('i18nComplete.text3f7374ac08ea')}
        description={
          deleteTarget
            ? tHardcodedUi('i18nComplete.text44db009e7d12', { value0: deleteTarget.name })
            : ''
        }
        confirmLabel={tHardcodedUi.raw('i18nComplete.text3f7374ac08ea')}
        confirmVariant="destructive"
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget.group_id);
        }}
      />
    </div>
  );
}

function CreateGroupDialog({
  open,
  onOpenChange,
  accountId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
  /** Opens the brand-new group's panel in the hub — no route change. */
  onCreated: (groupId: string) => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const createMutation = useMutation({
    mutationFn: () =>
      createGroup(accountId, { name: name.trim(), description: description.trim() || undefined }),
    onSuccess: (group) => {
      successToast(tHardcodedUi.raw('i18nComplete.textda74d185ef7c'));
      queryClient.invalidateQueries({ queryKey: ['account-groups', accountId] });
      setName('');
      setDescription('');
      onOpenChange(false);
      onCreated(group.group_id);
    },
    onError: (err: Error) =>
      errorToast(err.message || tHardcodedUi.raw('i18nComplete.text8848db900667')),
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || createMutation.isPending) return;
    createMutation.mutate();
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (createMutation.isPending) return;
        if (!next) {
          setName('');
          setDescription('');
        }
        onOpenChange(next);
      }}
    >
      <ModalContent className="sm:max-w-md">
        <ModalHeader>
          <ModalTitle>{tHardcodedUi.raw('i18nComplete.texte3c4877576de')}</ModalTitle>
          <ModalDescription>
            {tHardcodedUi.raw(
              'componentsIamGroupsTab.line311JsxTextGroupsBundleMembersTogetherAttachPermissionPoliciesTo',
            )}
          </ModalDescription>
        </ModalHeader>
        <form onSubmit={handleSubmit}>
          <ModalBody className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="group-name">
                {tHardcodedUi.raw('i18nComplete.text762ebb70ef0e')}
              </Label>
              <Input
                id="group-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={tHardcodedUi.raw('i18nComplete.text729bb48d0f86')}
                maxLength={128}
                autoFocus
                required
                disabled={createMutation.isPending}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="group-description">
                {tHardcodedUi.raw('i18nComplete.text526e0087cc3f')}{' '}
                <span className="text-muted-foreground text-xs font-normal">
                  {tHardcodedUi.raw('i18nComplete.text0059798b7f70')}
                </span>
              </Label>
              <Input
                id="group-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={tHardcodedUi.raw('i18nComplete.text8ddb6af74aaf')}
                maxLength={256}
                disabled={createMutation.isPending}
              />
            </div>
          </ModalBody>
          <ModalFooter className="sm:justify-between">
            <Button
              type="button"
              variant="outline-ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={createMutation.isPending}
            >
              {tHardcodedUi.raw('i18nComplete.text19766ed6ccb2')}
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={!name.trim() || createMutation.isPending}
              className="gap-1.5"
            >
              {createMutation.isPending && <Loading className="size-4 shrink-0" />}
              {tHardcodedUi.raw('i18nComplete.text35be9c541d68')}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
