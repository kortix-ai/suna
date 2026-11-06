'use client';

/**
 * `/admin/credit-codes` — codes a person redeems for credits (`FRONTIER` →
 * $100). Create one, see how many accounts redeemed it, switch it off.
 *
 * A customer redeems at `/redeem?code=<CODE>` or under Credits → "Redeem a
 * credit code". Each account redeems a code once; the credits are
 * non-expiring (`billing/services/credit-codes.ts`).
 *
 * Staff-only copy is English, like the rest of the admin chrome
 * (`admin-sidebar.tsx`).
 */

import { useState, type FormEvent } from 'react';

import { Badge } from '@kortix/ui/badge';
import { Button } from '@kortix/ui/button';
import { EmptyState } from '@kortix/ui/empty-state';
import { InfoBanner } from '@kortix/ui/info-banner';
import { Input } from '@kortix/ui/input';
import { IconInbox } from '@kortix/ui/kortix-icons';
import { Label } from '@kortix/ui/label';
import { Skeleton } from '@kortix/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@kortix/ui/table';
import { errorToast, successToast } from '@kortix/ui/toast';
import {
  useAdminCreateCreditCode,
  useAdminCreditCodes,
  useAdminSetCreditCodeActive,
  type AdminCreditCode,
} from '@kortix/sdk/react';
import { dollarsToCredits, formatCredits } from '@kortix/shared';

import { AdminPageShell } from '../_components/admin-page-shell';
import { AdminEmptyFrame, AdminPanel, AdminSection, AdminTableFrame } from '../_components/admin-panel';

// Date, time and zone: a code that ends Sunday 23:59 in one zone is Monday in
// UTC, and a bare date reads as the wrong day.
const DATE = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});

function redeemLink(code: string): string {
  return `${window.location.origin}/redeem?${new URLSearchParams({ code })}`;
}

function CreateCodeForm() {
  const create = useAdminCreateCreditCode();
  const [code, setCode] = useState('');
  const [amount, setAmount] = useState('100');
  const [maxRedemptions, setMaxRedemptions] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const amountUsd = Number(amount);
  const max = maxRedemptions.trim() ? Number(maxRedemptions) : null;
  const valid =
    /^[A-Za-z0-9_-]{3,64}$/.test(code.trim()) &&
    Number.isFinite(amountUsd) &&
    amountUsd > 0 &&
    amountUsd <= 10_000 &&
    (max === null || (Number.isInteger(max) && max > 0));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || create.isPending) return;
    setError(null);
    try {
      const created = await create.mutateAsync({
        code: code.trim(),
        amount_usd: amountUsd,
        max_redemptions: max,
        // The code stops working at the end of the chosen day in the admin's
        // own time zone (no `Z`: the browser reads it as local time).
        expires_at: expiresOn ? new Date(`${expiresOn}T23:59:59`).toISOString() : null,
        description: note.trim() || null,
      });
      successToast('Credit code created', { description: `${created.code} · ${redeemLink(created.code)}` });
      setCode('');
      setMaxRedemptions('');
      setExpiresOn('');
      setNote('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the code. Try again.');
    }
  }

  return (
    <AdminPanel>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5">
            <Label htmlFor="credit-code">Code</Label>
            <Input
              id="credit-code"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="FRONTIER"
              autoComplete="off"
              spellCheck={false}
              maxLength={64}
              className="font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="credit-code-amount">Amount (USD)</Label>
            <Input
              id="credit-code-amount"
              type="number"
              inputMode="decimal"
              min={1}
              max={10_000}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="tabular-nums"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="credit-code-max">Max accounts</Label>
            <Input
              id="credit-code-max"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={maxRedemptions}
              onChange={(e) => setMaxRedemptions(e.target.value)}
              placeholder="No limit"
              className="tabular-nums"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="credit-code-expires">Expires after</Label>
            <Input id="credit-code-expires" type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="credit-code-note">Note</Label>
          <Input
            id="credit-code-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What the code is for. Customers never see it."
            maxLength={500}
          />
        </div>
        {error ? <InfoBanner tone="destructive">{error}</InfoBanner> : null}
        <div className="flex items-center justify-between gap-3">
          <p className="text-muted-foreground text-xs tabular-nums">
            {Number.isFinite(amountUsd) && amountUsd > 0
              ? `${formatCredits(dollarsToCredits(amountUsd))} non-expiring credits per account, once per account.`
              : 'Each account redeems a code once.'}
          </p>
          <Button type="submit" size="sm" disabled={!valid || create.isPending} aria-busy={create.isPending || undefined}>
            Create code
          </Button>
        </div>
      </form>
    </AdminPanel>
  );
}

function status(code: AdminCreditCode): { label: string; variant: 'secondary' | 'outline' | 'destructive' } {
  if (!code.active) return { label: 'Off', variant: 'outline' };
  if (code.expires_at && new Date(code.expires_at).getTime() <= Date.now()) return { label: 'Expired', variant: 'outline' };
  if (code.max_redemptions !== null && code.redemption_count >= code.max_redemptions) {
    return { label: 'Used up', variant: 'outline' };
  }
  return { label: 'Active', variant: 'secondary' };
}

function CodesTable() {
  const { data: codes, isLoading, isFetching, error } = useAdminCreditCodes();
  const setActive = useAdminSetCreditCodeActive();

  if (isLoading) return <Skeleton className="h-40 w-full rounded-md" />;
  if (error) return <InfoBanner tone="destructive">Could not load the credit codes. {error.message}</InfoBanner>;
  if (!codes?.length) {
    return (
      <AdminEmptyFrame>
        <EmptyState icon={IconInbox} size="sm" title="Credit codes you create will show up here" />
      </AdminEmptyFrame>
    );
  }

  async function copyLink(code: string) {
    await navigator.clipboard.writeText(redeemLink(code));
    successToast('Link copied');
  }

  async function toggle(code: AdminCreditCode) {
    try {
      await setActive.mutateAsync({ codeId: code.code_id, active: !code.active });
      successToast(code.active ? `${code.code} switched off` : `${code.code} switched on`);
    } catch (err) {
      errorToast(err instanceof Error ? err.message : 'Could not change the code');
    }
  }

  return (
    <AdminTableFrame busy={isFetching}>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Code</TableHead>
            <TableHead>Amount</TableHead>
            <TableHead>Redeemed</TableHead>
            <TableHead>Expires</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {codes.map((code) => {
            const s = status(code);
            return (
              <TableRow key={code.code_id}>
                <TableCell>
                  <div className="font-mono text-sm">{code.code}</div>
                  {code.description ? <div className="text-muted-foreground text-xs">{code.description}</div> : null}
                </TableCell>
                <TableCell className="tabular-nums">
                  ${code.amount_usd.toLocaleString('en-US')}
                  <span className="text-muted-foreground"> · {formatCredits(dollarsToCredits(code.amount_usd))} credits</span>
                </TableCell>
                <TableCell className="tabular-nums">
                  {code.redemption_count}
                  {code.max_redemptions !== null ? ` / ${code.max_redemptions}` : ''}
                </TableCell>
                <TableCell className="tabular-nums">{code.expires_at ? DATE.format(new Date(code.expires_at)) : 'Never'}</TableCell>
                <TableCell>
                  <Badge variant={s.variant}>{s.label}</Badge>
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1.5">
                    <Button size="xs" variant="outline" onClick={() => void copyLink(code.code)}>
                      Copy link
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={setActive.isPending}
                      onClick={() => void toggle(code)}
                    >
                      {code.active ? 'Switch off' : 'Switch on'}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </AdminTableFrame>
  );
}

export default function AdminCreditCodesPage() {
  return (
    <AdminPageShell
      width="wide"
      title="Credit codes"
      description="A code adds credits to an account's balance. Each account redeems a code once, and the credits never expire."
    >
      <AdminSection title="New code">
        <CreateCodeForm />
      </AdminSection>
      <AdminSection title="Codes">
        <CodesTable />
      </AdminSection>
    </AdminPageShell>
  );
}
