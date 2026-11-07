'use client';

/**
 * `/admin/credit-codes` — codes a person redeems for credits (`FRONTIER` →
 * $100). Create one, see how many accounts redeemed it, switch it off.
 *
 * A customer redeems at `/redeem?code=<CODE>` or under Credits → "Redeem a
 * credit code". Each account redeems a code once; the credits are
 * non-expiring (`billing/services/credit-codes.ts`).
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

import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';

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

type Translate = ReturnType<typeof useI18nTranslations>;

function CreateCodeForm() {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
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
      successToast(tI18nComplete.raw('text3bd428ea044b'), { description: `${created.code} · ${redeemLink(created.code)}` });
      setCode('');
      setMaxRedemptions('');
      setExpiresOn('');
      setNote('');
    } catch (err) {
      setError(err instanceof Error ? err.message : tI18nComplete.raw('textb61216face35'));
    }
  }

  return (
    <AdminPanel>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5">
            <Label htmlFor="credit-code">{tI18nComplete.raw('text340f463033e0')}</Label>
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
            <Label htmlFor="credit-code-amount">{tI18nComplete.raw('text24f52bfeb8a8')}</Label>
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
            <Label htmlFor="credit-code-max">{tI18nComplete.raw('textcd7767866963')}</Label>
            <Input
              id="credit-code-max"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={maxRedemptions}
              onChange={(e) => setMaxRedemptions(e.target.value)}
              placeholder={tI18nComplete.raw('textf7fcff0d8fea')}
              className="tabular-nums"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="credit-code-expires">{tI18nComplete.raw('texta5e4b9f547aa')}</Label>
            <Input id="credit-code-expires" type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="credit-code-note">{tI18nComplete.raw('textd8da2c49df39')}</Label>
          <Input
            id="credit-code-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={tI18nComplete.raw('text58d661beb649')}
            maxLength={500}
          />
        </div>
        {error ? <InfoBanner tone="destructive">{error}</InfoBanner> : null}
        <div className="flex items-center justify-between gap-3">
          <p className="text-muted-foreground text-xs tabular-nums">
            {Number.isFinite(amountUsd) && amountUsd > 0
              ? tI18nComplete('textb26f2162f0be', { value0: formatCredits(dollarsToCredits(amountUsd)) })
              : tI18nComplete.raw('text730bcc003693')}
          </p>
          <Button type="submit" size="sm" disabled={!valid || create.isPending} aria-busy={create.isPending || undefined}>
            {tI18nComplete.raw('text231db95a3c8d')}
          </Button>
        </div>
      </form>
    </AdminPanel>
  );
}

function status(code: AdminCreditCode, tI18nComplete: Translate): { label: string; variant: 'secondary' | 'outline' | 'destructive' } {
  if (!code.active) return { label: tI18nComplete.raw('textca7981b46ecf'), variant: 'outline' };
  if (code.expires_at && new Date(code.expires_at).getTime() <= Date.now()) return { label: tI18nComplete.raw('text424a2551d356'), variant: 'outline' };
  if (code.max_redemptions !== null && code.redemption_count >= code.max_redemptions) {
    return { label: tI18nComplete.raw('textcc2a6d1c6f5a'), variant: 'outline' };
  }
  return { label: tI18nComplete.raw('text92340695899b'), variant: 'secondary' };
}

function CodesTable() {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const { data: codes, isLoading, isFetching, error } = useAdminCreditCodes();
  const setActive = useAdminSetCreditCodeActive();

  if (isLoading) return <Skeleton className="h-40 w-full rounded-md" />;
  if (error) return <InfoBanner tone="destructive">{tI18nComplete('text285d1fb4c107', { value0: error.message })}</InfoBanner>;
  if (!codes?.length) {
    return (
      <AdminEmptyFrame>
        <EmptyState icon={IconInbox} size="sm" title={tI18nComplete.raw('text300726143d4d')} />
      </AdminEmptyFrame>
    );
  }

  async function copyLink(code: string) {
    await navigator.clipboard.writeText(redeemLink(code));
    successToast(tI18nComplete.raw('textd12860c21e78'));
  }

  async function toggle(code: AdminCreditCode) {
    try {
      await setActive.mutateAsync({ codeId: code.code_id, active: !code.active });
      successToast(
        tI18nComplete(code.active ? 'text98e6acfa20a3' : 'text471313d05b7c', { value0: code.code }),
      );
    } catch (err) {
      errorToast(err instanceof Error ? err.message : tI18nComplete.raw('text220cf152984e'));
    }
  }

  return (
    <AdminTableFrame busy={isFetching}>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>{tI18nComplete.raw('text340f463033e0')}</TableHead>
            <TableHead>{tI18nComplete.raw('text49e96d7cdf58')}</TableHead>
            <TableHead>{tI18nComplete.raw('texte3ca364bc6c1')}</TableHead>
            <TableHead>{tI18nComplete.raw('textf6725f3af08a')}</TableHead>
            <TableHead>{tI18nComplete.raw('text920e413c7d41')}</TableHead>
            <TableHead className="text-right">{tI18nComplete.raw('textff8059dc6752')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {codes.map((code) => {
            const s = status(code, tI18nComplete);
            return (
              <TableRow key={code.code_id}>
                <TableCell>
                  <div className="font-mono text-sm">{code.code}</div>
                  {code.description ? <div className="text-muted-foreground text-xs">{code.description}</div> : null}
                </TableCell>
                <TableCell className="tabular-nums">
                  ${code.amount_usd.toLocaleString('en-US')}
                  <span className="text-muted-foreground">
                    {' · '}
                    {tI18nComplete('text8dcda9f17257', { value0: formatCredits(dollarsToCredits(code.amount_usd)) })}
                  </span>
                </TableCell>
                <TableCell className="tabular-nums">
                  {code.redemption_count}
                  {code.max_redemptions !== null ? ` / ${code.max_redemptions}` : ''}
                </TableCell>
                <TableCell className="tabular-nums">{code.expires_at ? DATE.format(new Date(code.expires_at)) : tI18nComplete.raw('text6300ef800bb8')}</TableCell>
                <TableCell>
                  <Badge variant={s.variant}>{s.label}</Badge>
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1.5">
                    <Button size="xs" variant="outline" onClick={() => void copyLink(code.code)}>
                      {tI18nComplete.raw('textdbf362d4f210')}
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={setActive.isPending}
                      onClick={() => void toggle(code)}
                    >
                      {tI18nComplete.raw(code.active ? 'text73b18d522cce' : 'text6d30f5727722')}
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
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  return (
    <AdminPageShell
      width="wide"
      title={tI18nComplete.raw('textb80e926c97f3')}
      description={tI18nComplete.raw('textd9dbfe1691b9')}
    >
      <AdminSection title={tI18nComplete.raw('text3edce074d607')}>
        <CreateCodeForm />
      </AdminSection>
      <AdminSection title={tI18nComplete.raw('texte0d1d308a679')}>
        <CodesTable />
      </AdminSection>
    </AdminPageShell>
  );
}
