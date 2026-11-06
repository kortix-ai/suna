'use client';

import { useState, type FormEvent } from 'react';

import { Button } from '@kortix/ui/button';
import { InfoBanner } from '@kortix/ui/info-banner';
import { Input } from '@kortix/ui/input';
import { successToast } from '@kortix/ui/toast';
import { invalidateAccountState } from '@kortix/ui/internal/billing/index';
import { useBillingAccountId } from '@kortix/ui/internal/stores/billing-account-context';
import { redeemCreditCode, type RedeemCreditCodeResult } from '@kortix/sdk';
import { dollarsToCredits, formatCredits } from '@kortix/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from '@/i18n/use-translations';

/**
 * Redeem a credit code: one field and one button.
 *
 * The API refuses with a stable `code` (`credit_code_invalid`, `_expired`,
 * `_exhausted`, `_already_redeemed`); each maps to its own sentence here, so
 * the person learns whether to fix the spelling or stop trying. The refusal
 * stays inline under the field. A success re-reads the wallet and reports with
 * a toast, unless the host shows its own result (`onRedeemed`).
 *
 * Hosts: `TopupControls` (folded under "Add credits") and the `/redeem` page.
 * The account is the surface's billing account; outside a
 * `BillingAccountProvider` the API uses the caller's primary account.
 */
export function RedeemCodeForm({
  initialCode = '',
  autoFocus = false,
  size = 'sm',
  onRedeemed,
}: {
  initialCode?: string;
  autoFocus?: boolean;
  size?: 'sm' | 'lg';
  /** Replaces the success toast: the host renders the result itself. */
  onRedeemed?: (result: RedeemCreditCodeResult) => void;
}) {
  const t = useTranslations('billing.redeem');
  const locale = useLocale();
  const accountId = useBillingAccountId();
  const queryClient = useQueryClient();
  const [code, setCode] = useState(initialCode.toUpperCase());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = code.trim();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!trimmed || pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await redeemCreditCode({ code: trimmed, accountId });
      invalidateAccountState(queryClient, true, true, accountId);
      setCode('');
      if (onRedeemed) {
        onRedeemed(result);
      } else {
        successToast(t('redeemed'), {
          description: t('redeemedDescription', {
            credits: formatCredits(dollarsToCredits(result.amount_usd), { locale }),
          }),
        });
      }
    } catch (err) {
      setError(redeemErrorMessage(err, t));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2.5">
      <div className="flex items-center gap-2">
        <Input
          value={code}
          onChange={(e) => {
            setCode(e.target.value.toUpperCase());
            setError(null);
          }}
          aria-label={t('codeLabel')}
          aria-invalid={error ? true : undefined}
          placeholder={t('placeholder')}
          autoFocus={autoFocus}
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          maxLength={64}
          disabled={pending}
          size={size === 'lg' ? 'md' : 'xs'}
          className="font-mono placeholder:font-sans"
        />
        <Button type="submit" size={size} disabled={!trimmed || pending} aria-busy={pending || undefined}>
          {t('action')}
        </Button>
      </div>
      {error ? <InfoBanner tone="destructive">{error}</InfoBanner> : null}
    </form>
  );
}

/** The sentence for a refusal, by the API's stable `code`, then by status. */
export function redeemErrorMessage(err: unknown, t: (key: string) => string): string {
  const e = err as { code?: string; status?: number } | null;
  switch (e?.code) {
    case 'credit_code_invalid':
      return t('invalid');
    case 'credit_code_expired':
      return t('expired');
    case 'credit_code_exhausted':
      return t('exhausted');
    case 'credit_code_already_redeemed':
      return t('alreadyRedeemed');
  }
  if (e?.status === 403) return t('noPermission');
  if (e?.status === 429) return t('rateLimited');
  return t('failed');
}
