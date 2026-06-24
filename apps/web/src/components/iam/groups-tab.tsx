'use client';

import { useTranslations } from 'next-intl';

// Groups tab on the account page. List + create + delete + navigate to
// detail. Mirrors Cloudflare's "User Groups" surface.

import { toast } from '@/lib/toast';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, MoreHorizontal, Plus, Search, Trash2, Users } from 'lucide-react';
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
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { List } from '@/components/ui/list';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/features/layout/section/empty-state';
import { type AccountGroup, createGroup, deleteGroup, listGroups } from '@/lib/iam-client';

interface GroupsTabProps {
  accountId: string;
  /** Drives visibility of the "Create a group" button and the per-row
   * delete option. Sourced from a usePermission(group.create) probe at
   * the page level so plain admins with explicit policies see it too. */
  canCreate: boolean;
}

export function GroupsTab({ accountId, canCreate }: GroupsTabProps) {
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

  return (
    <SectionCard
      title="Groups"
      description={tI18nHardcoded.raw(
        'autoComponentsIamGroupsTabJsxAttrDescriptionBundleMembersTogether2839aadc',
      )}
      action={
        canCreate && (
          <Button onClick={() => setCreateOpen(true)} size="sm" className="gap-1.5">
            <Plus className="h-4 w-4" />
            {tHardcodedUi.raw('componentsIamGroupsTab.line92JsxTextCreateAGroup')}
          </Button>
        )
      }
      flush
    >
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
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-40" />
                <Skeleton className="h-3 w-24" />
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
            !search && canCreate ? 'Create a group to bulk-add members to projects.' : undefined
          }
        />
      )}

      {!groupsQuery.isLoading && filtered.length > 0 && (
        <div className="overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-border/60 bg-muted/20 text-muted-foreground border-b text-left text-xs font-medium tracking-wider uppercase">
                <th className="px-6 py-2.5 font-medium">Name</th>
                <th className="px-3 py-2.5 font-medium">Source</th>
                <th className="px-3 py-2.5 font-medium">Members</th>
                <th className="px-3 py-2.5 font-medium">Projects</th>
                <th className="w-12 px-3 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-border divide-y">
              {filtered.map((g) => (
                <tr
                  key={g.group_id}
                  className="hover:bg-muted/30 cursor-pointer transition-colors"
                  onClick={() => router.push(`/accounts/${accountId}/groups/${g.group_id}`)}
                >
                  <td className="text-foreground px-6 py-3 font-medium">
                    <div className="flex flex-col gap-0.5">
                      <span>{g.name}</span>
                      {g.description && (
                        <span className="text-muted-foreground text-xs font-normal">
                          {g.description}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="text-muted-foreground px-3 py-3">
                    <Badge variant="outline" size="sm" className="font-normal capitalize">
                      {g.source}
                    </Badge>
                  </td>
                  <td className="text-muted-foreground px-3 py-3">{g.member_count ?? 0}</td>
                  <td className="text-muted-foreground px-3 py-3">{g.project_count ?? 0}</td>
                  <td className="px-3 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                    {canCreate && (
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
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
