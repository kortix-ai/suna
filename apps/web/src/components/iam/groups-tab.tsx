'use client';

import { useTranslations } from 'next-intl';

// Groups tab on the account page. List + create + delete + navigate to
// detail. Mirrors Cloudflare's "User Groups" surface.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, Plus, Search, Trash2, Users } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { FormEvent, useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import Hint from '@/components/ui/hint';
import { InfoBanner } from '@/components/ui/info-banner';
import { InlineMeta } from '@/components/ui/inline-meta';
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
import { type AccountGroup, createGroup, deleteGroup, listGroups } from '@/lib/iam-client';

// Same wording the backend's requireEntitlement('rbac') 402 uses — keep it in
// sync with apps/api/src/accounts/iam/helpers.ts ENTITLEMENT_LABEL.rbac.
const RBAC_UPSELL_MESSAGE =
  'Custom roles, policies, and groups are available on the Enterprise plan. Contact sales to enable it.';

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
}

export function GroupsTab({ accountId, canCreate, rbacEnabled }: GroupsTabProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const router = useRouter();
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
      <Button
        onClick={() => setCreateOpen(true)}
        size="sm"
        variant="secondary"
        className="gap-1.5"
      >
        <Plus className="size-4" />
        Create a group
      </Button>
    ) : (
      <Hint label={RBAC_UPSELL_MESSAGE} side="top" className="max-w-xs">
        <span className="inline-flex items-center gap-1.5">
          <Button size="sm" variant="secondary" className="gap-1.5" disabled>
            <Plus className="size-4" />
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
          <Search />
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
          icon={Users}
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
        <ul className="space-y-2">
          {filtered.map((g) => {
            const memberCount = g.member_count ?? 0;
            const projectCount = g.project_count ?? 0;
            return (
              <li
                key={g.group_id}
                onClick={() => router.push(`/accounts/${accountId}/groups/${g.group_id}`)}
                className="bg-popover hover:bg-popover-foreground/5 flex cursor-pointer items-center gap-3 rounded-md border px-4 py-2.5 transition-colors"
              >
                <EntityAvatar icon={Users} size="md" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-foreground truncate text-sm font-medium">
                      {g.name}
                    </span>
                    <Badge variant="outline" size="sm" className="capitalize">
                      {g.source}
                    </Badge>
                  </div>
                  <span className="text-muted-foreground text-xs">
                    <InlineMeta>
                      {g.description || null}
                      <span>
                        {memberCount} member{memberCount === 1 ? '' : 's'}
                      </span>
                      <span>
                        {projectCount} project{projectCount === 1 ? '' : 's'}
                      </span>
                    </InlineMeta>
                  </span>
                </div>
                {canCreate ? (
                  <div onClick={(e) => e.stopPropagation()} className="shrink-0">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-muted-foreground hover:text-foreground size-7"
                          aria-label={`Actions for ${g.name}`}
                        >
                          <MoreHorizontal className="size-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-44">
                        <DropdownMenuItem onSelect={() => setDeleteTarget(g)} className="gap-2">
                          <Trash2 className="size-3.5" />
                          Delete group
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <CreateGroupDialog open={createOpen} onOpenChange={setCreateOpen} accountId={accountId} />

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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const router = useRouter();
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
      router.push(`/accounts/${accountId}/groups/${group.group_id}`);
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
      <ModalContent className="lg:max-w-md">
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
              onClick={() => onOpenChange(false)}
              disabled={createMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
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
