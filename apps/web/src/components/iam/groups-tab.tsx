'use client';

import { useTranslations } from 'next-intl';

// Groups tab on the account page. List + create + delete + navigate to
// detail. Mirrors Cloudflare's "User Groups" surface.

import { toast } from '@/lib/toast';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, MoreHorizontal, Plus, Search, Trash2, Users } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { Label } from '@/components/ui/label';
import { List, ListRow } from '@/components/ui/list';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/features/layout/section/empty-state';
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
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tHardcodedUi = useTranslations('hardcodedUi');
  const router = useRouter();
  const queryClient = useQueryClient();
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
      toast.success('Group deleted');
      queryClient.invalidateQueries({ queryKey: ['account-groups', accountId] });
      setDeleteTarget(null);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to delete group'),
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
      <Button onClick={() => setCreateOpen(true)} size="sm" className="gap-1.5">
        <Plus className="h-4 w-4" />
        {tHardcodedUi.raw('componentsIamGroupsTab.line92JsxTextCreateAGroup')}
      </Button>
    ) : (
      <Hint label={RBAC_UPSELL_MESSAGE} side="top" className="max-w-xs">
        <span className="inline-flex items-center gap-1.5">
          <Button size="sm" className="gap-1.5" disabled>
            <Plus className="h-4 w-4" />
            {tHardcodedUi.raw('componentsIamGroupsTab.line92JsxTextCreateAGroup')}
          </Button>
          <Badge variant="outline" size="sm">
            Enterprise
          </Badge>
        </span>
      </Hint>
    )
  ) : null;

  return (
    <SectionCard
      title="Groups"
      description={tI18nHardcoded.raw(
        'autoComponentsIamGroupsTabJsxAttrDescriptionBundleMembersTogether2839aadc',
      )}
      action={createAction}
      flush
    >
      {gated && (
        <div className="border-border/60 border-b px-6 py-4">
          <InfoBanner
            tone="info"
            title="Enterprise feature"
            action={
              <Button asChild variant="outline" size="sm">
                <Link href="/enterprise">Contact sales</Link>
              </Button>
            }
          >
            {RBAC_UPSELL_MESSAGE}
          </InfoBanner>
        </div>
      )}

      <div className="border-border/60 border-b px-6 py-3">
        <div className="relative max-w-sm">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={tHardcodedUi.raw(
              'componentsIamGroupsTab.line104JsxAttrPlaceholderSearchByUserGroupName',
            )}
            className="h-9 pl-9"
          />
        </div>
      </div>

      {groupsQuery.isError && (
        <div className="px-6 py-5">
          <InfoBanner
            tone="destructive"
            title={tHardcodedUi.raw('componentsIamGroupsTab.line114JsxAttrTitleFailedToLoadGroups')}
            action={
              <Button variant="outline" size="sm" onClick={() => groupsQuery.refetch()}>
                Retry
              </Button>
            }
          >
            {(groupsQuery.error as Error)?.message}
          </InfoBanner>
        </div>
      )}

      {groupsQuery.isLoading && (
        <List>
          {Array.from({ length: 2 }).map((_, i) => (
            <li key={i} className="flex items-center gap-3 px-6 py-3">
              <Skeleton className="size-8 rounded-md" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-40" />
                <Skeleton className="h-3 w-56" />
              </div>
            </li>
          ))}
        </List>
      )}

      {!groupsQuery.isLoading && !groupsQuery.isError && filtered.length === 0 && (
        <EmptyState
          icon={Users}
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
        <List>
          {filtered.map((g) => {
            const memberCount = g.member_count ?? 0;
            const projectCount = g.project_count ?? 0;
            return (
              <ListRow
                key={g.group_id}
                onClick={() => router.push(`/accounts/${accountId}/groups/${g.group_id}`)}
                leading={<EntityAvatar icon={Users} />}
                title={g.name}
                badges={
                  <Badge variant="outline" size="sm" className="capitalize">
                    {g.source}
                  </Badge>
                }
                subtitle={
                  <InlineMeta>
                    {g.description || null}
                    {`${memberCount} member${memberCount === 1 ? '' : 's'}`}
                    {`${projectCount} project${projectCount === 1 ? '' : 's'}`}
                  </InlineMeta>
                }
                trailing={
                  canCreate ? (
                    <div onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-muted-foreground hover:text-foreground h-7 w-7"
                            aria-label={`Actions for ${g.name}`}
                          >
                            <MoreHorizontal className="h-3.5 w-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuItem onSelect={() => setDeleteTarget(g)} className="gap-2">
                            <Trash2 className="h-3.5 w-3.5" />
                            {tHardcodedUi.raw('componentsIamGroupsTab.line219JsxTextDeleteGroup')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  ) : undefined
                }
              />
            );
          })}
        </List>
      )}

      <CreateGroupDialog open={createOpen} onOpenChange={setCreateOpen} accountId={accountId} />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={tHardcodedUi.raw('componentsIamGroupsTab.line243JsxAttrTitleDeleteGroup')}
        description={
          deleteTarget
            ? `Delete "${deleteTarget.name}"? Any permission policies attached to this group will be removed.`
            : ''
        }
        confirmLabel={tHardcodedUi.raw(
          'componentsIamGroupsTab.line249JsxAttrConfirmlabelDeleteGroup',
        )}
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget.group_id);
        }}
      />
    </SectionCard>
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
      toast.success('Group created');
      queryClient.invalidateQueries({ queryKey: ['account-groups', accountId] });
      setName('');
      setDescription('');
      onOpenChange(false);
      router.push(`/accounts/${accountId}/groups/${group.group_id}`);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to create group'),
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || createMutation.isPending) return;
    createMutation.mutate();
  }

  return (
    <Dialog
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
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="border-border/60 border-b px-6 pt-6 pb-4">
          <DialogTitle className="text-lg font-semibold tracking-tight">
            {tHardcodedUi.raw('componentsIamGroupsTab.line308JsxTextCreateAGroup')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground text-sm">
            {tHardcodedUi.raw(
              'componentsIamGroupsTab.line311JsxTextGroupsBundleMembersTogetherAttachPermissionPoliciesTo',
            )}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="space-y-4 px-6 py-5">
            <div className="space-y-1.5">
              <Label htmlFor="group-name">
                {tHardcodedUi.raw('componentsIamGroupsTab.line318JsxTextGroupName')}
              </Label>
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
                placeholder={tHardcodedUi.raw(
                  'componentsIamGroupsTab.line339JsxAttrPlaceholderEngineersShippingThePlatform',
                )}
                maxLength={256}
                disabled={createMutation.isPending}
              />
            </div>
          </div>
          <div className="border-border/60 bg-muted/30 flex items-center justify-end gap-2 border-t px-6 py-3">
            <Button
              type="button"
              variant="ghost"
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
              {createMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {tHardcodedUi.raw('componentsIamGroupsTab.line360JsxTextCreateGroup')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
