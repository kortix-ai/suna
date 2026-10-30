'use client';

import type { UiTranslator } from '@/i18n/translator';
import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
import { useId, useState } from 'react';

import { Badge } from '@kortix/ui/badge';
import { Button } from '@kortix/ui/button';
import { ConfirmDialog } from '@kortix/ui/confirm-dialog';
import { Input } from '@kortix/ui/input';
import Loading from '@kortix/ui/loading';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@kortix/ui/select';
import { errorToast, successToast } from '@kortix/ui/toast';
import { useSetEnterpriseDemo } from '@kortix/sdk/react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useAdminCreateEnterpriseContract,
  useAdminEndEnterpriseContract,
  useAdminEnterpriseContracts,
  useAdminEnterpriseOfferLink,
  useAdminWithdrawEnterpriseOffer,
  type AdminAccount,
  type AdminContractCollection,
  type AdminEnterpriseContract,
} from '@/hooks/admin/use-admin-accounts';

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

const COLLECTION_VALUES: AdminContractCollection[] = ['checkout', 'invoice', 'manual'];

const MAX_TERM_MONTHS_STRIPE = 12;
const MAX_TERM_MONTHS_MANUAL = 60;

function collectionLabel(t: UiTranslator, value: string): string {
  switch (value) {
    case 'checkout':
      return t.raw('text0343c2d42a0c');
    case 'invoice':
      return t.raw('textce90ae653d94');
    case 'manual':
      return t.raw('text47f091076cdf');
    default:
      return value;
  }
}

function day(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function errorMessage(error: unknown, t: UiTranslator): string {
  return error instanceof Error ? error.message : t.raw('textada37a724fca');
}

function statusVariant(status: string): React.ComponentProps<typeof Badge>['variant'] {
  switch (status) {
    case 'active':
      return 'success';
    case 'offered':
      return 'info';
    case 'withdrawn':
      return 'warning';
    default:
      return 'muted';
  }
}

/** The account's Enterprise state. The list row sends it; an older API omits it. */
type EnterpriseState = NonNullable<AdminAccount['enterprise']>;

function enterpriseStateOf(account: AdminAccount): EnterpriseState {
  return account.enterprise ?? 'off';
}

/**
 * One line of Enterprise state for the list and the sheet header: Demo or
 * Licensed, and the SSO grace date after a license ended. Renders nothing for
 * an account with neither.
 */
export function AccountPlanState({ account }: { account: AdminAccount }) {
  const t = useI18nTranslations('hardcodedUi.i18nComplete');
  const enterprise = enterpriseStateOf(account);
  const parts: string[] = [];
  if (enterprise === 'demo') parts.push(t.raw('textd6ea513221b7'));
  if (enterprise === 'licensed') parts.push(t.raw('text5a22403ec082'));
  if (account.graceEndsAt) parts.push(t('text06bdc1c507f1', { date: day(account.graceEndsAt) }));
  if (parts.length === 0) return null;
  return (
    <div className="text-muted-foreground mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-xs">
      {parts.map((text) => (
        <span key={text}>{text}</span>
      ))}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="px-3 py-2.5">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="mt-0.5 text-sm font-medium">{value}</div>
    </div>
  );
}

function ContractFacts({ contract }: { contract: AdminEnterpriseContract }) {
  const t = useI18nTranslations('hardcodedUi.i18nComplete');
  return (
    <div className="border-border divide-border grid grid-cols-1 divide-y rounded-md border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
      <Fact label={t.raw('text73035f159d4d')} value={usd.format(contract.licenseUsd)} />
      <Fact label={t.raw('text7b790708ff1b')} value={collectionLabel(t, contract.collection)} />
      <Fact
        label={t.raw('textc6f3bfd45614')}
        value={
          <>
            {day(contract.startsAt)} –{' '}
            {contract.endsAt ? day(contract.endsAt) : t.raw('text764fcd0f142e')}
            <span className="text-muted-foreground font-normal">
              {' · '}
              {contract.autoRenews ? t.raw('text432cc3b6c5df') : t.raw('text6b0bb7175ca2')}
            </span>
          </>
        }
      />
    </div>
  );
}

/**
 * Enterprise for one account: its state (off, demo or licensed), the demo
 * switch, the active license, an open offer, and a form to create the next
 * license. A license carries no credits. All writes go through SDK hooks.
 */
export function EnterpriseContractCard({ account }: { account: AdminAccount }) {
  const t = useI18nTranslations('hardcodedUi.i18nComplete');
  const accountId = account.accountId;
  const contractsQuery = useAdminEnterpriseContracts(accountId);
  const create = useAdminCreateEnterpriseContract();
  const end = useAdminEndEnterpriseContract();
  const withdraw = useAdminWithdrawEnterpriseOffer();
  const offerLink = useAdminEnterpriseOfferLink();

  const queryClient = useQueryClient();
  const setDemo = useSetEnterpriseDemo();
  const enterprise = enterpriseStateOf(account);

  const [license, setLicense] = useState('');
  const [termMonths, setTermMonths] = useState('12');
  const termMonthsId = useId();
  const [collection, setCollection] = useState<AdminContractCollection>('invoice');
  const [note, setNote] = useState('');
  const [confirmEnd, setConfirmEnd] = useState(false);

  const contracts = contractsQuery.data?.contracts ?? [];
  const active = contracts.find((c) => c.status === 'active') ?? null;
  const offer = contracts.find((c) => c.status === 'offered') ?? null;

  const licenseUsd = Number(license);
  const term = Number(termMonths);
  const maxTerm = collection === 'manual' ? MAX_TERM_MONTHS_MANUAL : MAX_TERM_MONTHS_STRIPE;
  const amountsValid = license.trim() !== '' && Number.isFinite(licenseUsd) && licenseUsd > 0;
  const termValid = Number.isInteger(term) && term >= 1 && term <= maxTerm;
  const blockedReason = offer
    ? t.raw('text02b242fd11cd')
    : active && collection !== 'checkout'
      ? t.raw('text451c4b7d695d')
      : null;
  const canCreate = amountsValid && termValid && !blockedReason && !create.isPending;

  async function handleCreate() {
    if (!canCreate) return;
    try {
      await create.mutateAsync({
        accountId,
        licenseUsd,
        // The API ignores it: a license carries no credits.
        termMonths: term,
        collection,
        note: note.trim() === '' ? undefined : note.trim(),
      });
      const title =
        collection === 'checkout' ? t.raw('textaf5ea967932c') : t.raw('text4dd5a8e422e2');
      successToast(title, {
        description: t('textef57f290a967', {
          amount: usd.format(licenseUsd),
          collection: collectionLabel(t, collection),
        }),
      });
      setLicense('');
      setNote('');
    } catch (error) {
      errorToast(t.raw('text8efbc35160bd'), { description: errorMessage(error, t) });
    }
  }

  function handleDemo(enabled: boolean) {
    setDemo.mutate(
      { accountId, enabled },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ['admin', 'accounts'] });
          successToast(enabled ? t.raw('text431a97929d7e') : t.raw('text139479653231'));
        },
        onError: (error) => errorToast(t.raw('text111b159de1cc'), { description: errorMessage(error, t) }),
      },
    );
  }

  async function handleCopyLink() {
    try {
      const { checkout_url } = await offerLink.mutateAsync({ accountId });
      await navigator.clipboard.writeText(checkout_url);
      successToast(t.raw('texte370bc1075ed'), { description: t.raw('text3151f4aabaf9') });
    } catch (error) {
      errorToast(t.raw('textf4dcf59e57b6'), { description: errorMessage(error, t) });
    }
  }

  async function handleWithdraw() {
    try {
      await withdraw.mutateAsync({ accountId });
      successToast(t.raw('text5e092b95c558'));
    } catch (error) {
      errorToast(t.raw('text457a8260d2aa'), { description: errorMessage(error, t) });
    }
  }

  async function handleEnd() {
    try {
      await end.mutateAsync({ accountId });
      successToast(t.raw('textb25add33108b'), { description: t.raw('text3e844e06677f') });
    } catch (error) {
      errorToast(t.raw('text8c1ca123b5ca'), { description: errorMessage(error, t) });
    } finally {
      setConfirmEnd(false);
    }
  }

  return (
    <div className="border-border bg-popover space-y-4 rounded-md border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-foreground text-sm font-medium">{t.raw('text3fbe5ed156f1')}</div>
          <p className="text-muted-foreground mt-0.5 max-w-prose text-xs">
            {t.raw('textc3371113b9c5')}
          </p>
        </div>
        <Badge
          variant={enterprise === 'licensed' ? 'success' : enterprise === 'demo' ? 'info' : 'muted'}
          size="sm"
        >
          {enterprise === 'licensed'
            ? t.raw('text87feb882165d')
            : enterprise === 'demo'
              ? t.raw('text8a2cc0673b1c')
              : t.raw('textca7981b46ecf')}
        </Badge>
      </div>

      {/* The self-serve demo: an operator withdraws or grants it. A license
          already turns every feature on, so there is no switch then. */}
      {enterprise !== 'licensed' && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-muted-foreground text-xs">
            {enterprise === 'demo' ? t.raw('text125c03898a7c') : t.raw('textefcb797dc60f')}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => handleDemo(enterprise !== 'demo')}
            disabled={setDemo.isPending}
          >
            {setDemo.isPending && <Loading className="h-3.5 w-3.5" />}
            {enterprise === 'demo' ? t.raw('text17b21758b477') : t.raw('texta7d2d086e1ae')}
          </Button>
        </div>
      )}

      {contractsQuery.error && (
        <p className="text-kortix-red text-xs">{contractsQuery.error.message}</p>
      )}

      {active && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-sm font-medium">
              {t.raw('text07b0835cfecc')}
              <Badge variant="success" size="xs">
                {t.raw('text96879611650f')}
              </Badge>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmEnd(true)}
              disabled={end.isPending}
            >
              {t.raw('textaec55b18cb80')}
            </Button>
          </div>
          <ContractFacts contract={active} />
          {active.note && (
            <p className="text-muted-foreground border-border border-l-2 pl-3 text-xs">
              {active.note}
            </p>
          )}
        </div>
      )}

      {offer && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-sm font-medium">
              {t.raw('text95926a1a9cfb')}
              <Badge variant="info" size="xs">
                {t.raw('textf9baa17c9775')}
              </Badge>
            </div>
            <div className="flex gap-2">
              {offer.collection === 'checkout' && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCopyLink}
                  disabled={offerLink.isPending}
                  className="gap-1.5"
                >
                  {offerLink.isPending && <Loading className="h-3.5 w-3.5" />}
                  {t.raw('text0907fc71c60e')}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={handleWithdraw}
                disabled={withdraw.isPending}
                className="gap-1.5"
              >
                {withdraw.isPending && <Loading className="h-3.5 w-3.5" />}
                {t.raw('text164546a9c548')}
              </Button>
            </div>
          </div>
          <ContractFacts contract={offer} />
        </div>
      )}

      <div className="border-border space-y-3 border-t pt-4">
        <div className="text-foreground text-sm font-medium">{t.raw('text68a61092dbb3')}</div>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <label className="text-muted-foreground text-xs">{t.raw('textd4264846a915')}</label>
            <Input
              type="number"
              min={0}
              step={1}
              value={license}
              onChange={(e) => setLicense(e.target.value)}
              placeholder="40000"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor={termMonthsId} className="text-muted-foreground text-xs">
              {t('text3569eff22740', { max: maxTerm })}
            </label>
            <Input
              id={termMonthsId}
              type="number"
              min={1}
              max={maxTerm}
              step={1}
              value={termMonths}
              onChange={(e) => setTermMonths(e.target.value)}
              aria-invalid={!termValid}
            />
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <label className="text-muted-foreground text-xs">{t.raw('text7b790708ff1b')}</label>
            <Select
              value={collection}
              onValueChange={(v) => setCollection(v as AdminContractCollection)}
            >
              <SelectTrigger className="w-full" aria-label={t.raw('text7b790708ff1b')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COLLECTION_VALUES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {collectionLabel(t, value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-muted-foreground text-xs">{t.raw('textd8da2c49df39')}</label>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t.raw('text3a53c039a116')}
              maxLength={2000}
            />
          </div>
        </div>
        <p className="text-muted-foreground text-xs">
          {t.rich(
            collection === 'checkout'
              ? 'textcd396e78ef17'
              : collection === 'invoice'
                ? 'textd4a1b2d64d7f'
                : 'text8f55a25f086f',
            {
              amount: usd.format(amountsValid ? licenseUsd : 0),
              total: (chunks) => (
                <span className="text-foreground font-medium tabular-nums">{chunks}</span>
              ),
            },
          )}
        </p>
        {blockedReason && <p className="text-kortix-red text-xs">{blockedReason}</p>}
        <Button onClick={handleCreate} disabled={!canCreate} className="gap-1.5">
          {create.isPending && <Loading className="h-3.5 w-3.5" />}
          {collection === 'checkout' ? t.raw('text6dbbdcbd4300') : t.raw('text7e21e0469d75')}
        </Button>
      </div>

      {contracts.length > 0 && (
        <div className="border-border space-y-2 border-t pt-4">
          <div className="text-foreground text-sm font-medium">{t.raw('text0e7696009337')}</div>
          <div className="border-border divide-border divide-y rounded-md border text-xs">
            {contracts.map((c) => (
              <div
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <Badge variant={statusVariant(c.status)} size="xs">
                    {c.status}
                  </Badge>
                  <span className="tabular-nums">{usd.format(c.licenseUsd)}</span>
                  <span className="text-muted-foreground">{collectionLabel(t, c.collection)}</span>
                </div>
                <span className="text-muted-foreground">
                  {c.startsAt
                    ? `${day(c.startsAt)} – ${day(c.endsAt)}`
                    : t('text99d5771338b8', { date: day(c.createdAt) })}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmEnd}
        onOpenChange={setConfirmEnd}
        title={t.raw('textaec55b18cb80')}
        description={<p className="text-sm">{t.raw('text75ed3342a7ba')}</p>}
        confirmLabel={t.raw('textaec55b18cb80')}
        onConfirm={handleEnd}
        isPending={end.isPending}
      />
    </div>
  );
}
