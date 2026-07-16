'use client';

// Audit-webhook management on the Settings tab. Lets admins ship every
// audit event to a customer-controlled HTTP endpoint (Splunk, Datadog,
// internal SIEM). The secret is shown EXACTLY ONCE at creation so it can
// be pasted into the receiver's signature-verification code.

import { errorToast, successToast, warningToast } from '@/components/ui/toast';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Copy, Plus, Trash2, Webhook } from 'lucide-react';
import { type FormEvent, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InfoBanner } from '@/components/ui/info-banner';
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
  type AuditWebhook,
  type CreatedAuditWebhook,
  createAuditWebhook,
  deleteAuditWebhook,
  listAuditWebhooks,
  updateAuditWebhook,
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
    successToast(ok);
  } catch {
    warningToast('Copy failed — select and copy manually');
  }
}

export function AuditWebhooksCard({ accountId, canManage }: AuditWebhooksCardProps) {
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
    onError: (err: Error) => errorToast(err.message || 'Failed to update webhook'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteAuditWebhook(accountId, id),
    onSuccess: () => {
      successToast('Webhook removed');
      queryClient.invalidateQueries({ queryKey: ['audit-webhooks', accountId] });
      setDeleteTarget(null);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to delete webhook'),
  });

  const hooks = hooksQuery.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <p className="text-foreground text-sm font-medium">Audit webhooks</p>
          <p className="text-muted-foreground text-xs">
            Ship every audit event to your SIEM or generic HTTP endpoint. Payloads are signed
            with HMAC-SHA256.
          </p>
        </div>
        {canManage && (
          <Button
            onClick={() => setCreateOpen(true)}
            size="sm"
            variant="secondary"
            className="shrink-0 gap-1.5"
          >
            <Plus className="size-4 shrink-0" />
            New webhook
          </Button>
        )}
      </div>

      {hooksQuery.isLoading && (
        <div className="space-y-2">
          <Skeleton className="h-12 rounded-md" />
          <Skeleton className="h-12 rounded-md" />
        </div>
      )}

      {!hooksQuery.isLoading && hooks.length === 0 && (
        <div className="border-border text-muted-foreground rounded-md border border-dashed px-4 py-8 text-center text-sm">
          No webhooks configured.
        </div>
      )}

      {!hooksQuery.isLoading && hooks.length > 0 && (
        <ul className="space-y-2">
          {hooks.map((h) => (
            <li
              key={h.webhook_id}
              className="bg-popover flex items-start gap-3 rounded-md border px-4 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium">{h.name}</span>
                  <Badge variant={h.enabled ? 'success' : 'muted'} size="sm">
                    {h.enabled ? 'enabled' : 'disabled'}
                  </Badge>
                  {h.action_prefix && (
                    <Badge
                      variant="outline"
                      size="sm"
                      className="font-mono"
                      title={`Only events with action starting "${h.action_prefix}"`}
                    >
                      {h.action_prefix}
                    </Badge>
                  )}
                </div>
                <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
                  <code className="truncate font-mono">{h.url}</code>
                  <span>·</span>
                  <span>Last delivered {relative(h.last_delivered_at)}</span>
                </div>
                {h.last_error && (
                  <p className="text-kortix-red mt-1 text-xs break-words">
                    {relative(h.last_error_at)}: {h.last_error}
                  </p>
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
                  >
                    {h.enabled ? 'Disable' : 'Enable'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${h.name}`}
                    onClick={() => setDeleteTarget(h)}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="size-3.5 shrink-0" />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

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
        title="Delete webhook"
        description={
          deleteTarget
            ? `Stop sending audit events to "${deleteTarget.name}"? Existing receivers must be reconfigured if you re-create it.`
            : ''
        }
        confirmLabel="Delete webhook"
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget.webhook_id);
        }}
      />
    </div>
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
      // Surface the create-time test delivery so a bad URL is caught now, not
      // after silently dropping real audit events.
      if (hook.test && !hook.test.ok) {
        warningToast(
          `Webhook saved, but the test delivery failed${hook.test.error ? `: ${hook.test.error}` : ''}. Check the URL — events won't arrive until it succeeds.`,
        );
      } else if (hook.test?.ok) {
        successToast('Webhook created — test event delivered successfully.');
      }
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to create webhook'),
  });

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (created || mutation.isPending) return;
    if (!name.trim() || !url.trim()) return;
    mutation.mutate();
  }

  return (
    <Modal open={open} onOpenChange={close}>
      <ModalContent className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle>{created ? 'Webhook created' : 'New audit webhook'}</ModalTitle>
          <ModalDescription>
            {created
              ? 'Save the signing secret now. You will not see it again — to rotate, delete this webhook and create a new one.'
              : 'Each event is POSTed to the URL with an X-Kortix-Signature header (HMAC-SHA256 of the body using the secret).'}
          </ModalDescription>
        </ModalHeader>

        {created ? (
          <>
            <ModalBody className="space-y-4">
              {/* Test-delivery result — reassures on success, and makes a broken
                  URL impossible to miss (the failure mode that silently drops
                  every real audit event). */}
              {created.test &&
                (created.test.ok ? (
                  <InfoBanner tone="success" icon={Check}>
                    Test event delivered — your endpoint is reachable and events will stream
                    here.
                  </InfoBanner>
                ) : (
                  <InfoBanner tone="warning" icon={AlertTriangle}>
                    Test delivery failed{created.test.error ? `: ${created.test.error}` : ''}.
                    Events won&apos;t arrive until the URL responds — fix it, then delete and
                    re-create.
                  </InfoBanner>
                ))}
              <div>
                <Label className="text-xs">Signing secret</Label>
                <div className="mt-1 flex items-center gap-2">
                  <code className="bg-muted/30 min-w-0 flex-1 truncate rounded-md border px-3 py-2 font-mono text-xs">
                    {created.secret}
                  </code>
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Copy secret"
                    onClick={() => copyToClipboard(created.secret, 'Secret copied')}
                  >
                    <Copy className="size-3.5 shrink-0" />
                  </Button>
                </div>
              </div>
              <div>
                <Label className="text-xs">Destination URL</Label>
                <div className="mt-1 flex items-center gap-2">
                  <code className="bg-muted/30 min-w-0 flex-1 truncate rounded-md border px-3 py-2 font-mono text-xs">
                    {created.url}
                  </code>
                </div>
              </div>
            </ModalBody>
            <ModalFooter>
              <Button size="sm" onClick={() => close(false)} className="gap-1.5">
                <Check className="size-3.5 shrink-0" />
                Done
              </Button>
            </ModalFooter>
          </>
        ) : (
          <form onSubmit={submit}>
            <ModalBody className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="hook-name">Name</Label>
                <Input
                  id="hook-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Splunk production"
                  maxLength={128}
                  autoFocus
                  required
                  disabled={mutation.isPending}
                  variant="popover"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="hook-url">Destination URL</Label>
                <Input
                  id="hook-url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://siem.corp.example/kortix/audit"
                  type="url"
                  required
                  disabled={mutation.isPending}
                  variant="popover"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="hook-prefix">
                  Action prefix{' '}
                  <span className="text-muted-foreground text-xs font-normal">(optional)</span>
                </Label>
                <Input
                  id="hook-prefix"
                  value={actionPrefix}
                  onChange={(e) => setActionPrefix(e.target.value)}
                  placeholder="iam."
                  maxLength={128}
                  disabled={mutation.isPending}
                  variant="popover"
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
                      className={`rounded-full border px-2 py-0.5 text-xs transition-colors ${
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
                <p className="text-muted-foreground text-xs">
                  Only deliver events whose action starts with this prefix. Leave blank to
                  deliver everything.
                </p>
              </div>
            </ModalBody>
            <ModalFooter className="sm:justify-between">
              <Button
                type="button"
                variant="outline-ghost"
                size="sm"
                onClick={() => close(false)}
                disabled={mutation.isPending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={!name.trim() || !url.trim() || mutation.isPending}
                className="gap-1.5"
              >
                {mutation.isPending && <Loading className="size-3.5 shrink-0" />}
                Create webhook
              </Button>
            </ModalFooter>
          </form>
        )}
      </ModalContent>
    </Modal>
  );
}
