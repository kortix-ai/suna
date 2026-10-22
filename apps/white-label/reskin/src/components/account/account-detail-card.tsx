'use client';

import Loading from '@kortix/ui/loading';

import { Badge } from '@kortix/ui/badge';
import { Button } from '@kortix/ui/button';
import { Card } from '@kortix/ui/card';
import { ConfirmDialog } from '@kortix/ui/confirm-dialog';
import { Input } from '@kortix/ui/input';
import { Label } from '@kortix/ui/label';
import { Separator } from '@kortix/ui/separator';
import { Skeleton } from '@kortix/ui/skeleton';
import { kortix } from '@/lib/kortix';
import { relativeTime } from '@/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { errorToast, successToast } from '@kortix/ui/toast';
import { SignOutIcon, UsersIcon } from '@phosphor-icons/react';

/**
 * Account detail header + general settings: `accounts.get` for the detail header,
 * `accounts.updateName` to rename, and `accounts.leave` to leave the account.
 * On leave we invalidate `['accounts']` and tell the parent to reselect.
 */
export function AccountDetailCard({
  accountId,
  onLeft,
}: {
  accountId: string;
  onLeft: () => void;
}) {
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: ['account', accountId],
    queryFn: () => kortix.accounts.get(accountId),
  });

  const data = detail.data;
  const [name, setName] = useState('');
  useEffect(() => {
    if (data?.name != null) setName(String(data.name));
  }, [data?.name]);

  const rename = useMutation({
    mutationFn: () => kortix.accounts.updateName(accountId, name.trim()),
    onSuccess: (updated) => {
      qc.setQueryData(['account', accountId], updated);
      qc.invalidateQueries({ queryKey: ['accounts'] });
      successToast('Account renamed');
    },
    onError: () => errorToast('Could not rename the account'),
  });

  const leave = useMutation({
    mutationFn: () => kortix.accounts.leave(accountId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['accounts'] });
      successToast('You left the account');
      onLeft();
    },
    onError: () => errorToast('Could not leave the account'),
  });

  const role = data?.role;
  const isOwner = role === 'owner';
  const dirty = data?.name != null && name.trim() !== '' && name.trim() !== String(data.name);

  return (
    <Card className="p-5">
      {/* Detail header — accounts.get */}
      {detail.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-64" />
        </div>
      ) : detail.isError ? (
        <p className="text-sm text-destructive">Couldn&apos;t load this account.</p>
      ) : (
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate font-display text-2xl tracking-tight">
                {data?.name ?? 'Account'}
              </h2>
              {role && (
                <Badge variant="secondary" className="capitalize">
                  {role}
                </Badge>
              )}
            </div>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <UsersIcon className="size-3.5" />
                {data?.member_count ?? 0} {(data?.member_count ?? 0) === 1 ? 'member' : 'members'}
              </span>
              <span>{data?.project_count ?? 0} projects</span>
              {data?.created_at && <span>Created {relativeTime(data.created_at)}</span>}
              <span className="font-mono">{accountId}</span>
            </p>
          </div>
        </div>
      )}

      <Separator className="my-5" />

      {/* Rename — accounts.updateName */}
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty) rename.mutate();
        }}
      >
        <Label htmlFor="rename-account">Account name</Label>
        <div className="flex gap-2">
          <Input
            id="rename-account"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={detail.isLoading}
            placeholder="Account name"
          />
          <Button type="submit" variant="outline" disabled={!dirty || rename.isPending}>
            {rename.isPending && <Loading className="size-4" />}
            Save
          </Button>
        </div>
      </form>

      <Separator className="my-5" />

      {/* Leave — accounts.leave */}
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-medium">Leave this account</div>
          <p className="text-xs text-muted-foreground">
            {isOwner
              ? 'Owners may need to transfer ownership before leaving.'
              : 'You will lose access to its projects and members.'}
          </p>
        </div>
        <LeaveAccountDialog
          name={data?.name ?? 'this account'}
          pending={leave.isPending}
          onConfirm={() => leave.mutate()}
        />
      </div>
    </Card>
  );
}

function LeaveAccountDialog({
  name,
  pending,
  onConfirm,
}: {
  name: string;
  pending: boolean;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        className="text-destructive hover:text-destructive"
        onClick={() => setOpen(true)}
      >
        <SignOutIcon className="size-4" /> Leave
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Leave ${name}?`}
        description="You'll immediately lose access to this account's projects and members. You can be re-invited later."
        confirmLabel="Leave account"
        confirmVariant="destructive"
        isPending={pending}
        onConfirm={() => {
          onConfirm();
          setOpen(false);
        }}
      />
    </>
  );
}
