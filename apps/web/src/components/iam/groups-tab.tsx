'use client';

import { useTranslations } from 'next-intl';

// Groups tab on the account page. A picker (the list) or, when the hub's
// `?group=<id>` param is set, that group's `GroupAccessPanel` — the exact
// split `AccessProjectsTab` uses for `?project=<id>`. Opening a group used to
// leave the hub for a standalone route, which dropped the left rail and read
// as a different product next to the project panel; now it stays in the pane.
//
// The list is the shared `AccessList`/`AccessRow` — the same row every other
// access surface renders. Only `CreateGroupDialog` stays local: it DEFINES a
// group, it does not grant access, so it is not an `AccessDialog` mode.

import {
  ArrowRightIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  TrashIcon,
  UsersIcon,
} from '@phosphor-icons/react';
import { invalidatePermissionProbes } from '@kortix/sdk/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useMemo, useState } from 'react';

import { GroupAccessPanel } from '@/components/iam/group-access-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import Hint from '@/components/ui/hint';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
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
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import {
  AccessList,
  AccessRow,
  RBAC_UPSELL_MESSAGE,
  pluralize,
} from '@/features/workspace/shared/access';
import { type AccountGroup, createGroup, deleteGroup, listGroups } from '@/lib/iam-client';

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
  const openDemo = useRequestDemo();
  const [createOpen, setCreateOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<AccountGroup | null>(null);

  const groupsQuery = useQuery({
    queryKey: ['account-groups', accountId],
    queryFn: () => listGroups(accountId),
    staleTime: 30_000,
  });

  const deleteMutation = useMutation({
    mutationFn: (groupId: string) => deleteGroup(accountId, groupId),
    onSuccess: () => {
      successToast('Group deleted');
      void invalidatePermissionProbes(queryClient, { accountId });
      queryClient.invalidateQueries({ queryKey: ['account-groups', accountId] });
      setDeleteTarget(null);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to delete group'),
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

  const gated = canCreate && !rbacEnabled;
  const createAction = canCreate ? (
    rbacEnabled ? (
      <Button onClick={() => setCreateOpen(true)} size="sm" variant="secondary" className="gap-1.5">
        <PlusIcon className="size-4" />
        Create a group
      </Button>
    ) : (
      <Hint label={RBAC_UPSELL_MESSAGE} side="top" className="max-w-xs">
        <span className="inline-flex items-center gap-1.5">
          <Button size="sm" variant="secondary" className="gap-1.5" disabled>
            <PlusIcon className="size-4" />
            Create a group
          </Button>
          <Badge variant="outline" size="sm">
            Enterprise
          </Badge>
        </span>
      </Hint>
    )
  ) : null;

  const total = groupsQuery.data?.length ?? 0;
  const settled = !groupsQuery.isLoading && !groupsQuery.isError;

  // Stays in the hub: the account page turns this into
  // `?tab=groups&group=<id>` and mounts `GroupAccessPanel` in this same pane.
  const openGroup = onSelectGroup;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-0.5">
          <p className="text-foreground text-sm font-medium">
            Groups{settled ? ` · ${total}` : ''}
          </p>
          <p className="text-muted-foreground text-xs">
            {tHardcodedUi.raw(
              'autoComponentsIamGroupsTabJsxAttrDescriptionBundleMembersTogether2839aadc',
            )}
          </p>
        </div>
        {createAction}
      </div>

      {gated && (
        <InfoBanner
          tone="info"
          title="Enterprise feature"
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => openDemo({ source: 'accounts-groups' })}
            >
              Contact sales
            </Button>
          }
        >
          {RBAC_UPSELL_MESSAGE}
        </InfoBanner>
      )}

      <InputGroupSearch>
        <InputGroupSearchIcon>
          <MagnifyingGlassIcon />
        </InputGroupSearchIcon>
        <InputGroupSearchInput
          placeholder="Search by user group name"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          variant="popover"
        />
        {search ? <InputGroupSearchClear onClick={() => setSearch('')} /> : null}
      </InputGroupSearch>

      {groupsQuery.isError && (
        <ErrorState
          size="sm"
          title="Failed to load groups"
          description={(groupsQuery.error as Error)?.message}
          action={
            <Button variant="outline" size="sm" onClick={() => groupsQuery.refetch()}>
              Retry
            </Button>
          }
        />
      )}

      {groupsQuery.isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-[58px] w-full rounded-md" />
          ))}
        </div>
      )}

      {settled && filtered.length === 0 && (
        <EmptyState
          icon={UsersIcon}
          size="sm"
          title={search ? 'No groups match your search' : 'No groups yet'}
          description={
            !search && canCreate
              ? rbacEnabled
                ? 'Create a group to bulk-add members to projects.'
                : RBAC_UPSELL_MESSAGE
              : undefined
          }
        />
      )}

      {!groupsQuery.isLoading && filtered.length > 0 && (
        <AccessList>
          {filtered.map((g) => (
            <AccessRow
              key={g.group_id}
              leading={<EntityAvatar icon={UsersIcon} size="md" />}
              title={g.name}
              badges={
                <Badge
                  variant="outline"
                  size="sm"
                  className={g.source === 'scim' ? undefined : 'capitalize'}
                  title={
                    g.source === 'scim'
                      ? 'Pushed by your identity provider via Directory Sync — name and membership are managed there.'
                      : undefined
                  }
                >
                  {g.source === 'scim' ? 'Synced from IdP' : g.source}
                </Badge>
              }
              metaParts={[
                g.description || null,
                pluralize(g.member_count ?? 0, 'member'),
                pluralize(g.project_count ?? 0, 'project'),
              ].filter(Boolean)}
              onClick={() => openGroup(g.group_id)}
              kebabLabel={`Actions for ${g.name}`}
              kebab={[
                {
                  label: 'Open',
                  icon: <ArrowRightIcon className="size-3.5" />,
                  onSelect: () => openGroup(g.group_id),
                },
                ...(canCreate
                  ? [
                      {
                        label: 'Delete group',
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
        </AccessList>
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
        title="Delete group"
        description={
          deleteTarget
            ? `Delete "${deleteTarget.name}"? Any permission policies attached to this group will be removed.`
            : ''
        }
        confirmLabel="Delete group"
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
      successToast('Group created');
      queryClient.invalidateQueries({ queryKey: ['account-groups', accountId] });
      setName('');
      setDescription('');
      onOpenChange(false);
      onCreated(group.group_id);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to create group'),
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
          <ModalTitle>Create a group</ModalTitle>
          <ModalDescription>
            {tHardcodedUi.raw(
              'componentsIamGroupsTab.line311JsxTextGroupsBundleMembersTogetherAttachPermissionPoliciesTo',
            )}
          </ModalDescription>
        </ModalHeader>
        <form onSubmit={handleSubmit}>
          <ModalBody className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="group-name">Group name</Label>
              <Input
                id="group-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Engineering"
                maxLength={128}
                autoFocus
                required
                disabled={createMutation.isPending}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="group-description">
                Description{' '}
                <span className="text-muted-foreground text-xs font-normal">(optional)</span>
              </Label>
              <Input
                id="group-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Engineers shipping the platform"
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
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={!name.trim() || createMutation.isPending}
              className="gap-1.5"
            >
              {createMutation.isPending && <Loading className="size-4 shrink-0" />}
              Create group
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
