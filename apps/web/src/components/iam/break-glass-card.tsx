'use client';

import { useTranslations } from 'next-intl';
// Break-glass emergency access card on the Settings tab. A privileged
// member can self-activate a time-bounded super-admin promotion (with
// mandatory reason) for incident response. Auto-expires; everything's
// audit-logged.

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Flame, Loader2, X } from 'lucide-react';
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
  type BreakGlassGrant,
  activateBreakGlass,
  listBreakGlassGrants,
  revokeBreakGlass,
} from '@/lib/iam-client';
import { listAccountMembers } from '@/lib/projects-client';

interface BreakGlassCardProps {
  accountId: string;
  currentUserId: string;
  canManage: boolean;
}

export function BreakGlassCard({
  accountId,
  currentUserId,
  canManage,
}: BreakGlassCardProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const [activateOpen, setActivateOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<BreakGlassGrant | null>(null);

  const grantsQuery = useQuery({
    queryKey: ['iam-break-glass', accountId],
    queryFn: () => listBreakGlassGrants(accountId),
    refetchInterval: 30_000,
  });

  const membersQuery = useQuery({
    queryKey: ['account-members', accountId],
    queryFn: () => listAccountMembers(accountId),
    staleTime: 60_000,
  });

  const emailByUserId = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of membersQuery.data ?? []) {
      if (m.email) map.set(m.user_id, m.email);
    }
    return map;
  }, [membersQuery.data]);

  const revokeMutation = useMutation({
    mutationFn: (grantId: string) => revokeBreakGlass(accountId, grantId),
    onSuccess: () => {
      toast.success('Break-glass grant revoked');
      queryClient.invalidateQueries({ queryKey: ['iam-break-glass', accountId] });
      // Permission verdicts depend on actor super-admin state; bust caches.
      queryClient.invalidateQueries({ queryKey: ['iam-permission'] });
      queryClient.invalidateQueries({ queryKey: ['iam-permission-batch'] });
      setRevokeTarget(null);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to revoke grant'),
  });

  const grants = grantsQuery.data ?? [];
  const active = grants.filter((g) => g.active);
  const history = grants.filter((g) => !g.active);
  const ownActive = active.find((g) => g.user_id === currentUserId);

  return (
    <section className="rounded-xl border border-border/70 bg-card">
      <header className="border-b border-border/60 px-6 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
              <Flame className="h-4 w-4 text-amber-600" />
              {tHardcodedUi.raw('componentsIamBreakGlassCard.line95JsxTextBreakGlassEmergencyAccess')}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {tHardcodedUi.raw('componentsIamBreakGlassCard.line98JsxTextSelfActivateTemporarySuperAdminForIncidentResponse')}</p>
          </div>
          {canManage && (
            <Button
              variant={ownActive ? 'outline' : 'default'}
              onClick={() => {
                if (ownActive) setRevokeTarget(ownActive);
                else setActivateOpen(true);
              }}
              size="sm"
              className="gap-1.5"
            >
              {ownActive ? (
                <>
                  <X className="h-3.5 w-3.5" />
                  {tHardcodedUi.raw('componentsIamBreakGlassCard.line116JsxTextRevokeMyGrant')}</>
              ) : (
                <>
                  <Flame className="h-3.5 w-3.5" />
                  Activate
                </>
              )}
            </Button>
          )}
        </div>
      </header>

      <div className="px-6 py-4">
        {grantsQuery.isLoading ? (
          <Skeleton className="h-12 w-full" />
        ) : active.length === 0 && history.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {tHardcodedUi.raw('componentsIamBreakGlassCard.line134JsxTextNoBreakGlassGrantsOnFileActivateOne')}</p>
        ) : (
          <div className="space-y-3">
            {active.length > 0 && (
              <div>
                <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-amber-700 dark:text-amber-400">
                  {tHardcodedUi.raw('componentsIamBreakGlassCard.line142JsxTextActive')}{active.length})
                </h3>
                <ul className="space-y-2">
                  {active.map((g) => (
                    <GrantRow
                      key={g.grant_id}
                      grant={g}
                      email={emailByUserId.get(g.user_id) ?? g.user_id}
                      active
                      canRevoke={canManage}
                      onRevoke={() => setRevokeTarget(g)}
                    />
                  ))}
                </ul>
              </div>
            )}
            {history.length > 0 && (
              <details className="rounded-md border border-border/60 px-3 py-2 text-xs">
                <summary className="cursor-pointer text-muted-foreground">
                  {tHardcodedUi.raw('componentsIamBreakGlassCard.line161JsxTextHistory')}{history.length})
                </summary>
                <ul className="mt-3 space-y-2">
                  {history.slice(0, 25).map((g) => (
                    <GrantRow
                      key={g.grant_id}
                      grant={g}
                      email={emailByUserId.get(g.user_id) ?? g.user_id}
                      active={false}
                      canRevoke={false}
                      onRevoke={() => {}}
                    />
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>

      <ActivateBreakGlassDialog
        accountId={accountId}
        open={activateOpen}
        onOpenChange={setActivateOpen}
        onActivated={() => {
          queryClient.invalidateQueries({ queryKey: ['iam-break-glass', accountId] });
          queryClient.invalidateQueries({ queryKey: ['iam-permission'] });
          queryClient.invalidateQueries({ queryKey: ['iam-permission-batch'] });
        }}
      />

      <ConfirmDialog
        open={!!revokeTarget}
        onOpenChange={(o) => {
          if (!o) setRevokeTarget(null);
        }}
        title={tHardcodedUi.raw('componentsIamBreakGlassCard.line197JsxAttrTitleRevokeBreakGlassGrant')}
        description={
          revokeTarget
            ? `Ends the grant for ${emailByUserId.get(revokeTarget.user_id) ?? revokeTarget.user_id} immediately. They lose super-admin on their next request.`
            : ''
        }
        confirmLabel="Revoke"
        confirmVariant="destructive"
        isPending={revokeMutation.isPending}
        onConfirm={() => {
          if (revokeTarget) revokeMutation.mutate(revokeTarget.grant_id);
        }}
      />
    </section>
  );
}

// ─── Activate dialog ──────────────────────────────────────────────────────

function ActivateBreakGlassDialog({
  accountId,
  open,
  onOpenChange,
  onActivated,
}: {
  accountId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onActivated: () => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState('60');

  const mutation = useMutation({
    mutationFn: () =>
      activateBreakGlass(accountId, {
        reason: reason.trim(),
        minutes: parseInt(minutes, 10) || 60,
      }),
    onSuccess: () => {
      toast.success('Break-glass activated — you have temporary super-admin');
      onActivated();
      setReason('');
      setMinutes('60');
      onOpenChange(false);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to activate'),
  });

  const parsedMinutes = parseInt(minutes, 10);
  const valid =
    reason.trim().length > 0 &&
    Number.isInteger(parsedMinutes) &&
    parsedMinutes > 0 &&
    parsedMinutes <= 480;

  return (
    <Dialog open={open} onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{tHardcodedUi.raw('componentsIamBreakGlassCard.line257JsxTextActivateBreakGlass')}</DialogTitle>
          <DialogDescription>
            {tHardcodedUi.raw('componentsIamBreakGlassCard.line259JsxTextYouLlGetFullSuperAdminUntilThe')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <p>
              {tHardcodedUi.raw('componentsIamBreakGlassCard.line269JsxTextUseOnlyDuringARealIncidentActivationIs')}</p>
          </div>

          <div className="space-y-1.5">
            <Label>Reason</Label>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={tHardcodedUi.raw('componentsIamBreakGlassCard.line279JsxAttrPlaceholderEGP0BillingPipelineStuckNeedTo')}
              disabled={mutation.isPending}
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label>{tHardcodedUi.raw('componentsIamBreakGlassCard.line286JsxTextDurationMinutes')}</Label>
            <Input
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
              inputMode="numeric"
              placeholder="60"
              disabled={mutation.isPending}
            />
            <p className="text-[11px] text-muted-foreground">
              {tHardcodedUi.raw('componentsIamBreakGlassCard.line295JsxTextMax4808HoursDefaultIs60Minutes')}</p>
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
            disabled={!valid || mutation.isPending}
            className="gap-1.5"
          >
            {mutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Activate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Row ──────────────────────────────────────────────────────────────────

function GrantRow({
  grant,
  email,
  active,
  canRevoke,
  onRevoke,
}: {
  grant: BreakGlassGrant;
  email: string;
  active: boolean;
  canRevoke: boolean;
  onRevoke: () => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const remainingMs = active ? new Date(grant.expires_at).getTime() - Date.now() : 0;
  const remainingLabel =
    remainingMs > 0
      ? `${Math.max(1, Math.round(remainingMs / 60_000))}m remaining`
      : 'expired';
  return (
    <li className="rounded-md border border-border/60 px-3 py-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="font-medium text-foreground">{email}</span>
            {active ? (
              <Badge
                variant="outline"
                size="sm"
                className="border-amber-500/40 text-amber-700 dark:text-amber-300"
              >
                {remainingLabel}
              </Badge>
            ) : grant.revoked_at ? (
              <Badge variant="outline" size="sm" className="text-muted-foreground">
                revoked
              </Badge>
            ) : (
              <Badge variant="outline" size="sm" className="text-muted-foreground">
                expired
              </Badge>
            )}
          </div>
          <p className="mt-1 italic text-muted-foreground">{tHardcodedUi.raw('componentsIamBreakGlassCard.line366JsxTextText')}{grant.reason}{tHardcodedUi.raw('componentsIamBreakGlassCard.line366JsxTextText')}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Activated {new Date(grant.activated_at).toLocaleString()}
          </p>
        </div>
        {active && canRevoke && (
          <Button
            size="sm"
            variant="outline"
            onClick={onRevoke}
            className="shrink-0 gap-1.5 text-destructive hover:text-destructive"
          >
            <X className="h-3.5 w-3.5" />
            Revoke
          </Button>
        )}
      </div>
    </li>
  );
}
