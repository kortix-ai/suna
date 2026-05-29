'use client';

import { useTranslations } from 'next-intl';
// Audit-webhook management on the Settings tab. Lets admins ship every
// audit event to a customer-controlled HTTP endpoint (Splunk, Datadog,
// internal SIEM). The secret is shown EXACTLY ONCE at creation so it can
// be pasted into the receiver's signature-verification code.

import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Copy, Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from '@/lib/toast';

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
  createAuditWebhook,
  deleteAuditWebhook,
  listAuditWebhooks,
  updateAuditWebhook,
  type AuditWebhook,
  type CreatedAuditWebhook,
} from '@/lib/iam-client';

interface AuditWebhooksCardProps {
  accountId: string;
  canManage: boolean;
}

function relative(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const diffMs = Date.now() - d.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

async function copyToClipboard(value: string, ok = 'Copied') {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(ok);
  } catch {
    toast.warning('Copy failed — select and copy manually');
  }
}

export function AuditWebhooksCard({ accountId, canManage }: AuditWebhooksCardProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AuditWebhook | null>(null);

  const hooksQuery = useQuery({
    queryKey: ['audit-webhooks', accountId],
    queryFn: () => listAuditWebhooks(accountId),
    staleTime: 30_000,
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      updateAuditWebhook(accountId, id, { enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['audit-webhooks', accountId] });
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to update webhook'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteAuditWebhook(accountId, id),
    onSuccess: () => {
      toast.success('Webhook removed');
      queryClient.invalidateQueries({ queryKey: ['audit-webhooks', accountId] });
      setDeleteTarget(null);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to delete webhook'),
  });

  const hooks = hooksQuery.data ?? [];

  return (
    <section className="rounded-xl border border-border/70 bg-card">
      <header className="flex items-center justify-between gap-3 border-b border-border/60 px-6 py-4">
        <div>
          <h2 className="text-base font-semibold text-foreground">{tHardcodedUi.raw('componentsIamAuditWebhooksCard.line101JsxTextAuditWebhooks')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {tHardcodedUi.raw('componentsIamAuditWebhooksCard.line103JsxTextShipEveryAuditEventToYourSIEMOr')}</p>
        </div>
        {canManage && (
          <Button onClick={() => setCreateOpen(true)} size="sm" className="gap-1.5">
            <Plus className="h-4 w-4" />
            {tHardcodedUi.raw('componentsIamAuditWebhooksCard.line110JsxTextNewWebhook')}</Button>
        )}
      </header>

      <div className="px-6 py-4">
        {hooksQuery.isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-12 rounded-md" />
            <Skeleton className="h-12 rounded-md" />
          </div>
        )}

        {!hooksQuery.isLoading && hooks.length === 0 && (
          <p className="rounded-2xl border border-dashed border-border/60 px-3 py-6 text-center text-xs text-muted-foreground">
            {tHardcodedUi.raw('componentsIamAuditWebhooksCard.line125JsxTextNoWebhooksConfigured')}</p>
        )}

        {!hooksQuery.isLoading && hooks.length > 0 && (
          <ul className="space-y-2">
            {hooks.map((h) => (
              <li
                key={h.webhook_id}
                className="rounded-2xl border border-border/60 px-3 py-2.5"
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {h.name}
                      </span>
                      {h.enabled ? (
                        <Badge variant="outline" className="h-4 rounded-md px-1 text-[9px] font-normal">
                          enabled
                        </Badge>
                      ) : (
                        <Badge variant="destructive" className="h-4 rounded-md px-1 text-[9px] font-normal">
                          disabled
                        </Badge>
                      )}
                      {h.action_prefix && (
                        <Badge
                          variant="outline"
                          className="h-4 rounded-md px-1 text-[9px] font-mono font-normal"
                          title={`Only events with action starting "${h.action_prefix}"`}
                        >
                          {h.action_prefix}
                        </Badge>
                      )}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                      <code className="truncate font-mono">{h.url}</code>
                      <span>·</span>
                      <span>{tHardcodedUi.raw('componentsIamAuditWebhooksCard.line164JsxTextLastDelivered')}{' '}{relative(h.last_delivered_at)}</span>
                    </div>
                    {h.last_error && (
                      <div className="mt-1 flex items-start gap-1.5 text-[11px] text-destructive">
                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                        <span className="break-words">
                          {relative(h.last_error_at)}: {h.last_error}
                        </span>
                      </div>
                    )}
                  </div>
                  {canManage && (
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={toggleMutation.isPending}
                        onClick={() =>
                          toggleMutation.mutate({
                            id: h.webhook_id,
                            enabled: !h.enabled,
                          })
                        }
                        className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                      >
                        {h.enabled ? 'Disable' : 'Enable'}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Delete ${h.name}`}
                        onClick={() => setDeleteTarget(h)}
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <CreateAuditWebhookDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        accountId={accountId}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
        title={tHardcodedUi.raw('componentsIamAuditWebhooksCard.line220JsxAttrTitleDeleteWebhook')}
        description={
          deleteTarget
            ? `Stop sending audit events to "${deleteTarget.name}"? Existing receivers must be reconfigured if you re-create it.`
            : ''
        }
        confirmLabel={tHardcodedUi.raw('componentsIamAuditWebhooksCard.line226JsxAttrConfirmLabelDeleteWebhook')}
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget.webhook_id);
        }}
      />
    </section>
  );
}

function CreateAuditWebhookDialog({
  open,
  onOpenChange,
  accountId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  accountId: string;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [actionPrefix, setActionPrefix] = useState('');
  const [created, setCreated] = useState<CreatedAuditWebhook | null>(null);

  function close(next: boolean) {
    if (mutation.isPending) return;
    if (!next) {
      // Wipe everything — especially the plaintext secret which we never
      // want to show twice.
      setName('');
      setUrl('');
      setActionPrefix('');
      setCreated(null);
    }
    onOpenChange(next);
  }

  const mutation = useMutation({
    mutationFn: () =>
      createAuditWebhook(accountId, {
        name: name.trim(),
        url: url.trim(),
        action_prefix: actionPrefix.trim() || undefined,
      }),
    onSuccess: (hook) => {
      setCreated(hook);
      queryClient.invalidateQueries({ queryKey: ['audit-webhooks', accountId] });
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to create webhook'),
  });

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (created || mutation.isPending) return;
    if (!name.trim() || !url.trim()) return;
    mutation.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{created ? 'Webhook created' : 'New audit webhook'}</DialogTitle>
          <DialogDescription>
            {created
              ? 'Save the signing secret now. You will not see it again — to rotate, delete this webhook and create a new one.'
              : 'Each event is POSTed to the URL with an X-Kortix-Signature header (HMAC-SHA256 of the body using the secret).'}
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <div className="space-y-4">
            <div>
              <Label className="text-xs">{tHardcodedUi.raw('componentsIamAuditWebhooksCard.line300JsxTextSigningSecret')}</Label>
              <div className="mt-1 flex items-center gap-2">
                <code className="flex-1 truncate rounded border border-border/60 bg-muted/30 px-3 py-2 font-mono text-xs">
                  {created.secret}
                </code>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={tHardcodedUi.raw('componentsIamAuditWebhooksCard.line308JsxAttrAriaLabelCopySecret')}
                  onClick={() => copyToClipboard(created.secret, 'Secret copied')}
                >
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            <div>
              <Label className="text-xs">{tHardcodedUi.raw('componentsIamAuditWebhooksCard.line316JsxTextDestinationURL')}</Label>
              <div className="mt-1 flex items-center gap-2">
                <code className="flex-1 truncate rounded border border-border/60 bg-muted/30 px-3 py-2 font-mono text-xs">
                  {created.url}
                </code>
              </div>
            </div>
            <DialogFooter>
              <Button onClick={() => close(false)} className="gap-1.5">
                <Check className="h-4 w-4" />
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="hook-name">Name</Label>
              <Input
                id="hook-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={tHardcodedUi.raw('componentsIamAuditWebhooksCard.line338JsxAttrPlaceholderSplunkProduction')}
                maxLength={128}
                autoFocus
                required
                disabled={mutation.isPending}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hook-url">{tHardcodedUi.raw('componentsIamAuditWebhooksCard.line346JsxTextDestinationURL')}</Label>
              <Input
                id="hook-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://siem.corp.example/kortix/audit"
                type="url"
                required
                disabled={mutation.isPending}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hook-prefix">
                {tHardcodedUi.raw('componentsIamAuditWebhooksCard.line359JsxTextActionPrefix')}{' '}
                <span className="text-xs font-normal text-muted-foreground">
                  (optional)
                </span>
              </Label>
              <Input
                id="hook-prefix"
                value={actionPrefix}
                onChange={(e) => setActionPrefix(e.target.value)}
                placeholder="iam."
                maxLength={128}
                disabled={mutation.isPending}
              />
              <div className="flex flex-wrap gap-1.5">
                {(
                  [
                    { label: 'All events', prefix: '' },
                    { label: 'IAM only', prefix: 'iam.' },
                    { label: 'Auth lifecycle', prefix: 'auth.' },
                    { label: 'Failed logins', prefix: 'auth.login.fail' },
                    { label: 'Policies only', prefix: 'iam.policy' },
                    { label: 'Super-admin grants', prefix: 'iam.member.super_admin' },
                    { label: 'Approvals', prefix: 'iam.approval' },
                  ] as const
                ).map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => setActionPrefix(preset.prefix)}
                    className={`rounded-2xl border px-2 py-0.5 text-[11px] transition-colors ${
                      actionPrefix === preset.prefix
                        ? 'border-primary bg-primary/10 text-foreground'
                        : 'border-border/60 text-muted-foreground hover:bg-muted/40'
                    }`}
                    disabled={mutation.isPending}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                {tHardcodedUi.raw('componentsIamAuditWebhooksCard.line400JsxTextOnlyDeliverEventsWhoseActionStartsWithThis')}</p>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => close(false)}
                disabled={mutation.isPending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!name.trim() || !url.trim() || mutation.isPending}
              >
                {mutation.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                {tHardcodedUi.raw('componentsIamAuditWebhooksCard.line418JsxTextCreateWebhook')}</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
