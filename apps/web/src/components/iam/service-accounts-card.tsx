'use client';

import { useTranslations } from 'next-intl';
// Service accounts on the Settings tab. First-class machine identities
// owned by the account itself; policies attach via the standard policy
// editor (pick scope_type='token' principal). One bearer per SA;
// rotation = disable + create new.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  Check,
  Copy,
  ExternalLink,
  Loader2,
  PauseCircle,
  Plus,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
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
  const tHardcodedUi = useTranslations('hardcodedUi');
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
      toast.success('Service account disabled');
      queryClient.invalidateQueries({ queryKey: ['service-accounts', accountId] });
      setDisableTarget(null);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to disable'),
  });

  const deleteMutation = useMutation({
    mutationFn: (saId: string) => deleteServiceAccountApi(accountId, saId),
    onSuccess: () => {
      toast.success('Service account deleted');
      queryClient.invalidateQueries({ queryKey: ['service-accounts', accountId] });
      setDeleteTarget(null);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to delete'),
  });

  const sas = sasQuery.data ?? [];

  return (
    <section className="rounded-xl border border-border/70 bg-card">
      <header className="border-b border-border/60 px-6 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
              <Bot className="h-4 w-4 text-muted-foreground" />
              {tHardcodedUi.raw('componentsIamServiceAccountsCard.line93JsxTextServiceAccounts')}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {tHardcodedUi.raw('componentsIamServiceAccountsCard.line96JsxTextMachineIdentitiesForCICDAndIntegrationsAttach')}</p>
          </div>
          {canManage && (
            <Button size="sm" onClick={() => setCreateOpen(true)} className="gap-1.5">
              <Plus className="h-4 w-4" />
              {tHardcodedUi.raw('componentsIamServiceAccountsCard.line104JsxTextNewServiceAccount')}</Button>
          )}
        </div>
      </header>

      <div className="px-6 py-4">
        {sasQuery.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : sas.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {tHardcodedUi.raw('componentsIamServiceAccountsCard.line115JsxTextNoServiceAccountsYetCreateOneToGet')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                <th className="py-2 font-medium">Name</th>
                <th className="py-2 font-medium">Status</th>
                <th className="py-2 font-medium">{tHardcodedUi.raw('componentsIamServiceAccountsCard.line124JsxTextLastUsed')}</th>
                <th className="w-32 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {sas.map((sa) => (
                <tr key={sa.service_account_id} className="hover:bg-muted/20">
                  <td className="py-2">
                    <div className="font-medium text-foreground">{sa.name}</div>
                    <div className="font-mono text-[10px] text-muted-foreground">
                      {sa.public_prefix}
                    </div>
                    {sa.description && (
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        {sa.description}
                      </div>
                    )}
                  </td>
                  <td className="py-2">
                    <Badge
                      variant="outline"
                      size="sm"
                      className={
                        sa.status === 'active'
                          ? 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300'
                          : 'text-muted-foreground'
                      }
                    >
                      {sa.status}
                    </Badge>
                  </td>
                  <td className="py-2 text-xs text-muted-foreground">
                    {sa.last_used_at ? formatRelative(sa.last_used_at) : 'never'}
                  </td>
                  <td className="py-2 text-right">
                    {canManage && (
                      <div className="flex justify-end gap-1.5">
                        {sa.status === 'active' && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8 text-muted-foreground hover:text-amber-600"
                            onClick={() => setDisableTarget(sa)}
                            aria-label="Disable"
                            title="Disable"
                          >
                            <PauseCircle className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          onClick={() => setDeleteTarget(sa)}
                          aria-label="Delete"
                          title={tHardcodedUi.raw('componentsIamServiceAccountsCard.line179JsxAttrTitleDeletePermanently')}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

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
        title={tHardcodedUi.raw('componentsIamServiceAccountsCard.line216JsxAttrTitleDisableServiceAccount')}
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
        title={tHardcodedUi.raw('componentsIamServiceAccountsCard.line235JsxAttrTitleDeleteServiceAccount')}
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
    </section>
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
  const tHardcodedUi = useTranslations('hardcodedUi');
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
    onError: (err: Error) => toast.error(err.message || 'Failed to create'),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{tHardcodedUi.raw('componentsIamServiceAccountsCard.line287JsxTextNewServiceAccount')}</DialogTitle>
          <DialogDescription>
            {tHardcodedUi.raw('componentsIamServiceAccountsCard.line289JsxTextABearerTokenWillBeShownOnceAfter')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ci-deploy"
              disabled={mutation.isPending}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label>{tHardcodedUi.raw('componentsIamServiceAccountsCard.line306JsxTextDescriptionOptional')}</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={tHardcodedUi.raw('componentsIamServiceAccountsCard.line310JsxAttrPlaceholderGitHubActionsDeployWorker')}
              disabled={mutation.isPending}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={!name.trim() || mutation.isPending}
            className="gap-1.5"
          >
            {mutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ShowBearerDialog({
  accountId,
  bearer,
  onClose,
}: {
  accountId: string;
  bearer: CreatedServiceAccount;
  onClose: () => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(bearer.secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Clipboard unavailable — select and copy manually.');
    }
  }
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{tHardcodedUi.raw('componentsIamServiceAccountsCard.line360JsxTextSaveThisBearerNow')}</DialogTitle>
          <DialogDescription>
            {tHardcodedUi.raw('componentsIamServiceAccountsCard.line362JsxTextThisIsTheOnlyTimeWeLlShow')}<strong>{bearer.name}</strong>{tHardcodedUi.raw('componentsIamServiceAccountsCard.line362JsxTextSSecretStoreItInYourSecretsManager')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-2xl border border-border/60 bg-muted/30 px-3 py-2 font-mono text-xs break-all">
            {bearer.secret}
          </div>
          <div className="flex items-center justify-between gap-2">
            <Button size="sm" variant="outline" onClick={copy} className="gap-1.5">
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <Link
              href={`/accounts/${accountId}/tokens/${bearer.service_account_id}`}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              {tHardcodedUi.raw('componentsIamServiceAccountsCard.line380JsxTextAttachPolicies')}<ExternalLink className="h-3 w-3" />
            </Link>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
