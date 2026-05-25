'use client';

import { useTranslations } from 'next-intl';
// Cross-account external grants on the Settings tab. Attach an existing
// Kortix user from outside this account so they show up as a principal
// in the policy editor, without consuming a regular seat. Optional
// auto-revoke timestamp + free-text note.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Briefcase, Loader2, Plus, Trash2 } from 'lucide-react';
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
  type ExternalGrant,
  createExternalGrant,
  listExternalGrants,
  revokeExternalGrant,
} from '@/lib/iam-client';

interface ExternalGrantsCardProps {
  accountId: string;
  canManage: boolean;
}

export function ExternalGrantsCard({ accountId, canManage }: ExternalGrantsCardProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ExternalGrant | null>(null);

  const grantsQuery = useQuery({
    queryKey: ['iam-external-grants', accountId],
    queryFn: () => listExternalGrants(accountId),
    staleTime: 30_000,
  });

  const revokeMutation = useMutation({
    mutationFn: (userId: string) => revokeExternalGrant(accountId, userId),
    onSuccess: () => {
      toast.success('External grant revoked');
      queryClient.invalidateQueries({ queryKey: ['iam-external-grants', accountId] });
      setRevokeTarget(null);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to revoke'),
  });

  const grants = grantsQuery.data ?? [];

  return (
    <section className="rounded-xl border border-border/70 bg-card">
      <header className="border-b border-border/60 px-6 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
              <Briefcase className="h-4 w-4 text-muted-foreground" />
              {tHardcodedUi.raw('componentsIamExternalGrantsCard.line69JsxTextExternalAccess')}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {tHardcodedUi.raw('componentsIamExternalGrantsCard.line72JsxTextGrantAConsultantOrPartnerFromADifferent')}</p>
          </div>
          {canManage && (
            <Button size="sm" onClick={() => setAddOpen(true)} className="gap-1.5">
              <Plus className="h-4 w-4" />
              {tHardcodedUi.raw('componentsIamExternalGrantsCard.line80JsxTextAddExternalUser')}</Button>
          )}
        </div>
      </header>

      <div className="px-6 py-4">
        {grantsQuery.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : grants.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {tHardcodedUi.raw('componentsIamExternalGrantsCard.line91JsxTextNoExternalUsersAttachedUseThisForConsultants')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                <th className="py-2 font-medium">User</th>
                <th className="py-2 font-medium">Expires</th>
                <th className="py-2 font-medium">Note</th>
                <th className="w-12 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {grants.map((g) => (
                <tr key={g.user_id} className="hover:bg-muted/20">
                  <td className="py-2">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-[11px] text-foreground">
                        {g.user_id}
                      </span>
                      {!g.active && (
                        <Badge variant="outline" size="sm" className="text-muted-foreground">
                          expired
                        </Badge>
                      )}
                    </div>
                  </td>
                  <td className="py-2 text-xs text-muted-foreground">
                    {g.expires_at
                      ? new Date(g.expires_at).toLocaleDateString()
                      : '— (no expiry)'}
                  </td>
                  <td className="py-2 text-xs text-muted-foreground">
                    {g.note ?? '—'}
                  </td>
                  <td className="py-2 text-right">
                    {canManage && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                        onClick={() => setRevokeTarget(g)}
                        aria-label={tHardcodedUi.raw('componentsIamExternalGrantsCard.line134JsxAttrAriaLabelRevokeExternalGrant')}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <AddExternalDialog
        accountId={accountId}
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreated={() =>
          queryClient.invalidateQueries({ queryKey: ['iam-external-grants', accountId] })
        }
      />

      <ConfirmDialog
        open={!!revokeTarget}
        onOpenChange={(o) => {
          if (!o) setRevokeTarget(null);
        }}
        title={tHardcodedUi.raw('componentsIamExternalGrantsCard.line161JsxAttrTitleRevokeExternalGrant')}
        description={tHardcodedUi.raw('componentsIamExternalGrantsCard.line162JsxAttrDescriptionTheUserImmediatelyLosesAccessToThisAccount')}
        confirmLabel="Revoke"
        confirmVariant="destructive"
        isPending={revokeMutation.isPending}
        onConfirm={() => {
          if (revokeTarget) revokeMutation.mutate(revokeTarget.user_id);
        }}
      />
    </section>
  );
}

function AddExternalDialog({
  accountId,
  open,
  onOpenChange,
  onCreated,
}: {
  accountId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: () => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [expiresAtISO, setExpiresAtISO] = useState<string>('');

  const mutation = useMutation({
    mutationFn: () =>
      createExternalGrant(accountId, {
        email: email.trim(),
        note: note.trim() || undefined,
        expires_at: expiresAtISO || undefined,
      }),
    onSuccess: () => {
      toast.success('External user attached');
      onCreated();
      setEmail('');
      setNote('');
      setExpiresAtISO('');
      onOpenChange(false);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to add external user'),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{tHardcodedUi.raw('componentsIamExternalGrantsCard.line211JsxTextAttachExternalUser')}</DialogTitle>
          <DialogDescription>
            {tHardcodedUi.raw('componentsIamExternalGrantsCard.line213JsxTextTheUserMustAlreadyHaveAKortixAccount')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Email</Label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={tHardcodedUi.raw('componentsIamExternalGrantsCard.line224JsxAttrPlaceholderAliceConsultancyCom')}
              disabled={mutation.isPending}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label>{tHardcodedUi.raw('componentsIamExternalGrantsCard.line230JsxTextAutoRevokeOptional')}</Label>
            <Input
              type="datetime-local"
              value={expiresAtISO ? expiresAtISO.slice(0, 16) : ''}
              onChange={(e) =>
                setExpiresAtISO(
                  e.target.value ? new Date(e.target.value).toISOString() : '',
                )
              }
              disabled={mutation.isPending}
              className="text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label>{tHardcodedUi.raw('componentsIamExternalGrantsCard.line244JsxTextNoteOptional')}</Label>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={tHardcodedUi.raw('componentsIamExternalGrantsCard.line248JsxAttrPlaceholderQ1AuditContractorFromFooCo')}
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
            disabled={!email.trim() || mutation.isPending}
            className="gap-1.5"
          >
            {mutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Attach
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
