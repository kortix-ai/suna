'use client';

import { useFirm } from '@/components/access';
import { isAdmin, PLAN_LABEL } from '@/lib/roles';
import { errorText } from '@/lib/utils';
import { api } from '@convex/_generated/api';
import { Badge } from '@kortix/ui/badge';
import { Button } from '@kortix/ui/button';
import { Input } from '@kortix/ui/input';
import { Label } from '@kortix/ui/label';
import Loading from '@kortix/ui/loading';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@kortix/ui/select';
import { Skeleton } from '@kortix/ui/skeleton';
import { errorToast } from '@kortix/ui/toast';
import { useAction, useQuery } from 'convex/react';
import { useState } from 'react';

const STATUS: Record<string, string> = { none: 'No subscription', active: 'Active', past_due: 'Payment due', canceled: 'Canceled' };

export default function BillingPage() {
  const firm = useFirm();
  const s = useQuery(api.billing.summary, { firmId: firm._id });
  const admin = isAdmin(firm.role);
  if (!s) return <Skeleton className="h-40 rounded-xl" />;
  const used = s.used + s.pending;

  return (
    <div className="max-w-2xl space-y-6">
      <section className="grid grid-cols-3 divide-x divide-border rounded-xl border border-border bg-card">
        <div className="p-5">
          <p className="text-xs text-muted-foreground">Plan</p>
          <p className="mt-1 font-display text-2xl">{PLAN_LABEL[s.plan]}</p>
        </div>
        <div className="p-5">
          <p className="text-xs text-muted-foreground">Seats used</p>
          <p className="mt-1 font-mono text-2xl" data-testid="billing-seats">
            {used} / {s.seats}
          </p>
          {s.pending > 0 && <p className="text-xs text-muted-foreground">{s.pending} pending invitation{s.pending > 1 ? 's' : ''}</p>}
        </div>
        <div className="p-5">
          <p className="text-xs text-muted-foreground">Status</p>
          <p className="mt-1.5">
            <Badge variant={s.billingStatus === 'past_due' ? 'warning' : 'outline'}>{STATUS[s.billingStatus]}</Badge>
          </p>
          {s.trialEndsAt && s.plan === 'trial' && (
            <p className="mt-1 text-xs text-muted-foreground">Trial ends {new Date(s.trialEndsAt).toLocaleDateString()}</p>
          )}
        </div>
      </section>

      {s.mode === 'off' ? (
        <p className="text-sm text-muted-foreground">Billing is not configured on this deployment.</p>
      ) : admin ? (
        <StripeControls hasCustomer={s.hasCustomer} seats={Math.max(s.seats, used)} />
      ) : (
        <p className="text-sm text-muted-foreground">An owner or admin manages the plan.</p>
      )}
    </div>
  );
}

function StripeControls({ hasCustomer, seats: initialSeats }: { hasCustomer: boolean; seats: number }) {
  const firm = useFirm();
  const checkout = useAction(api.billing.checkout);
  const portal = useAction(api.billing.portal);
  const [plan, setPlan] = useState<'solo' | 'team' | 'firm'>('team');
  const [seats, setSeats] = useState(String(initialSeats));
  const [pending, setPending] = useState(false);

  async function go(fn: () => Promise<string>) {
    setPending(true);
    try {
      window.location.assign(await fn());
    } catch (err) {
      setPending(false);
      errorToast('Could not open billing', { description: errorText(err) });
    }
  }

  return (
    <section className="space-y-4 rounded-xl border border-border bg-card p-5">
      <h2 className="text-sm font-medium">Change plan</h2>
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1.5">
          <Label>Plan</Label>
          <Select value={plan} onValueChange={(p) => setPlan(p as typeof plan)}>
            <SelectTrigger aria-label="Plan" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="solo">Solo</SelectItem>
              <SelectItem value="team">Team</SelectItem>
              <SelectItem value="firm">Firm</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="seat-count">Seats</Label>
          <Input id="seat-count" type="number" min={1} max={10000} value={seats} onChange={(e) => setSeats(e.target.value)} className="w-24 font-mono" />
        </div>
        <Button disabled={pending} onClick={() => go(() => checkout({ firmId: firm._id, plan, seats: Number(seats) }))}>
          {pending && <Loading className="size-4" />} Upgrade
        </Button>
        {hasCustomer && (
          <Button variant="secondary" disabled={pending} onClick={() => go(() => portal({ firmId: firm._id }))}>
            Manage billing
          </Button>
        )}
      </div>
    </section>
  );
}
