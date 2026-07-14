'use client';

// Service accounts on the Settings tab. First-class machine identities
// owned by the account itself; policies attach via the standard policy
// editor (pick scope_type='token' principal). One bearer per SA;
// rotation = disable + create new.

import { errorToast, successToast } from '@/components/ui/toast';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, ExternalLink, MoreHorizontal, PauseCircle, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  type CreatedServiceAccount,
  type ServiceAccount,
  createServiceAccountApi,
  deleteServiceAccountApi,
  disableServiceAccountApi,
  listServiceAccountsApi,
} from '@/lib/iam-client';

interface ServiceAccountsCardProps {
  accountId: string;
  canManage: boolean;
}

export function ServiceAccountsCard({ accountId, canManage }: ServiceAccountsCardProps) {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [createdBearer, setCreatedBearer] = useState<CreatedServiceAccount | null>(null);
  const [disableTarget, setDisableTarget] = useState<ServiceAccount | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ServiceAccount | null>(null);

  const sasQuery = useQuery({
    queryKey: ['service-accounts', accountId],
    queryFn: () => listServiceAccountsApi(accountId),
    staleTime: 30_000,
  });

  const disableMutation = useMutation({
    mutationFn: (saId: string) => disableServiceAccountApi(accountId, saId),
    onSuccess: () => {
      successToast('Service account disabled');
      queryClient.invalidateQueries({ queryKey: ['service-accounts', accountId] });
      setDisableTarget(null);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to disable'),
  });

  const deleteMutation = useMutation({
    mutationFn: (saId: string) => deleteServiceAccountApi(accountId, saId),
    onSuccess: () => {
      successToast('Service account deleted');
      queryClient.invalidateQueries({ queryKey: ['service-accounts', accountId] });
      setDeleteTarget(null);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to delete'),
  });

  const sas = sasQuery.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <p className="text-foreground text-sm font-medium">Service accounts</p>
          <p className="text-muted-foreground text-xs">
            Machine identities for CI/CD and integrations. Attach policies just like a member —
            pick the service account as the principal when creating a policy.
          </p>
        </div>
        {canManage && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setCreateOpen(true)}
            className="shrink-0 gap-1.5"
          >
            <Plus className="size-4 shrink-0" />
            New service account
          </Button>
        )}
      </div>

      {sasQuery.isLoading ? (
        <Skeleton className="h-16 w-full rounded-md" />
      ) : sas.length === 0 ? (
        <div className="border-border text-muted-foreground rounded-md border border-dashed px-4 py-8 text-center text-sm">
          No service accounts yet. Create one to get a bearer token for your CI and automations.
        </div>
      ) : (
        <Table className="overflow-hidden rounded-md">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead className="w-[52px]">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sas.map((sa) => (
              <TableRow key={sa.service_account_id}>
                <TableCell className="max-w-[280px] align-top whitespace-normal">
                  <div className="min-w-0">
                    <p className="text-foreground truncate text-sm font-medium">{sa.name}</p>
                    <p className="text-muted-foreground truncate font-mono text-xs">
                      {sa.public_prefix}
                    </p>
                    {sa.description && (
                      <p className="text-muted-foreground mt-0.5 text-xs">{sa.description}</p>
                    )}
                  </div>
                </TableCell>
                <TableCell className="align-top whitespace-normal">
                  <Badge variant={sa.status === 'active' ? 'success' : 'muted'} size="sm">
                    {sa.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground align-top text-xs whitespace-normal">
                  {sa.last_used_at ? formatRelative(sa.last_used_at) : 'never'}
                </TableCell>
                <TableCell className="align-top">
                  {canManage && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="icon" variant="ghost" aria-label="Actions">
                          <MoreHorizontal className="size-3.5 shrink-0" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48">
                        {sa.status === 'active' && (
                          <DropdownMenuItem onClick={() => setDisableTarget(sa)}>
                            <PauseCircle className="size-3.5 shrink-0" />
                            Disable
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem
                          onClick={() => setDeleteTarget(sa)}
                          variant="destructive"
                        >
                          <Trash2 className="size-3.5 shrink-0" />
                          Delete permanently
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <CreateServiceAccountDialog
        accountId={accountId}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(sa) => {
          queryClient.invalidateQueries({ queryKey: ['service-accounts', accountId] });
          setCreatedBearer(sa);
        }}
      />

      {createdBearer && (
        <ShowBearerDialog
          accountId={accountId}
          bearer={createdBearer}
          onClose={() => setCreatedBearer(null)}
        />
      )}

      <ConfirmDialog
        open={!!disableTarget}
        onOpenChange={(o) => {
          if (!o) setDisableTarget(null);
        }}
        title="Disable service account?"
        description={
          disableTarget
            ? `"${disableTarget.name}" will start failing auth on its next request. Its bearer becomes unusable but the account row is preserved for audit. Re-enable by deleting + creating a new one.`
            : ''
        }
        confirmLabel="Disable"
        confirmVariant="destructive"
        isPending={disableMutation.isPending}
        onConfirm={() => {
          if (disableTarget) disableMutation.mutate(disableTarget.service_account_id);
        }}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
        title="Delete service account?"
        description={
          deleteTarget
            ? `Permanently removes "${deleteTarget.name}" and revokes its bearer. Any IAM policies attached to it are also dropped.`
            : ''
        }
        confirmLabel="Delete"
        confirmVariant="destructive"
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget.service_account_id);
        }}
      />
    </div>
  );
}

// ─── Create dialog ────────────────────────────────────────────────────────

function CreateServiceAccountDialog({
  accountId,
  open,
  onOpenChange,
  onCreated,
}: {
  accountId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (sa: CreatedServiceAccount) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const mutation = useMutation({
    mutationFn: () =>
      createServiceAccountApi(accountId, {
        name: name.trim(),
        description: description.trim() || undefined,
      }),
    onSuccess: (sa) => {
      onCreated(sa);
      setName('');
      setDescription('');
      onOpenChange(false);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to create'),
  });

  return (
    <Modal open={open} onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}>
      <ModalContent className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle>New service account</ModalTitle>
          <ModalDescription>
            A bearer token will be shown once after creation. Attach policies to it from the
            member detail view (it appears under the Token principal type).
          </ModalDescription>
        </ModalHeader>
        <ModalBody className="space-y-4">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ci-deploy"
              disabled={mutation.isPending}
              autoFocus
              variant="popover"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Description (optional)</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="GitHub Actions deploy worker"
              disabled={mutation.isPending}
              variant="popover"
            />
          </div>
        </ModalBody>
        <ModalFooter className="sm:justify-between">
          <Button
            type="button"
            variant="outline-ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => mutation.mutate()}
            disabled={!name.trim() || mutation.isPending}
            className="gap-1.5"
          >
            {mutation.isPending && <Loading className="size-3.5 shrink-0" />}
            Create
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

function ShowBearerDialog({
  bearer,
  onClose,
  accountId,
}: {
  accountId: string;
  bearer: CreatedServiceAccount;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(bearer.secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      errorToast('Clipboard unavailable — select and copy manually.');
    }
  }
  return (
    <Modal open onOpenChange={onClose}>
      <ModalContent className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle>Save this bearer now</ModalTitle>
          <ModalDescription>
            This is the only time we&apos;ll show <strong>{bearer.name}</strong>&apos;s secret.
            Store it in your secrets manager — we can&apos;t recover it if you lose it.
          </ModalDescription>
        </ModalHeader>
        <ModalBody className="space-y-3">
          <div className="bg-muted/30 rounded-md border px-3 py-2 font-mono text-xs break-all">
            {bearer.secret}
          </div>
          <div className="flex items-center justify-between gap-2">
            <Button size="sm" variant="outline" onClick={copy} className="gap-1.5">
              {copied ? <Check className="size-3.5 shrink-0" /> : <Copy className="size-3.5 shrink-0" />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <Link
              href={`/accounts/${accountId}/tokens/${bearer.service_account_id}`}
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
            >
              Attach policies
              <ExternalLink className="size-3 shrink-0" />
            </Link>
          </div>
        </ModalBody>
        <ModalFooter>
          <Button size="sm" onClick={onClose}>
            Done
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

function formatRelative(iso: string): string {
  const date = new Date(iso);
  const diff = Date.now() - date.getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return date.toLocaleDateString();
}
