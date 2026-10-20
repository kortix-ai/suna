'use client';

/**
 * `provider-accordion.tsx` — the Providers section of the QUICK Models dialog
 * (`llm-provider-modal.tsx`). Paper boards PM01 (accordion rows) and AK01
 * (Add key morphs into an inline field), page p-2O-0.
 *
 * The Models PAGE keeps its list + SplitSheet (`provider-connect.tsx` +
 * `provider-sheet.tsx`). A 900px dialog has no room for a second column, so
 * here a provider opens IN PLACE:
 *
 *  - **An API-key provider without a key** — "Add key" turns the row itself
 *    into a field with Save and ×. Enter saves, Esc cancels. A provider that
 *    needs several fields (Bedrock, Azure, Vertex) has no room on one row, so
 *    it expands to the same multi-field form the sheet uses.
 *  - **A connected provider** — the row expands into a card: its connections
 *    (key, or ChatGPT sign-in and key for OpenAI), each with its own action,
 *    and the "Enable {name} for this project" switch.
 *
 * Every write reuses the sheet's hooks (`useProviderKey`,
 * `useSubscriptionSignIn`, `RemoveKeyDialog`), so the dialog and the page
 * save, remove and sign in through the same code.
 *
 * The pieces under `// ─── View` are pure (props only) so they render under
 * `renderToStaticMarkup`; `ProviderAccordion` owns every hook.
 */

import {
  ArrowSquareOutIcon,
  CaretDownIcon,
  MagnifyingGlassIcon,
  XIcon,
} from '@phosphor-icons/react';
import { type KeyboardEvent, type ReactNode, useMemo, useState } from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import Loading from '@/components/ui/loading';
import { Switch } from '@/components/ui/switch';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import {
  FIRST_CLASS_PROVIDER_IDS,
  PROVIDER_PAGE_SIZE,
  ProviderLogoStatus,
  type ProviderListRow,
  type ProviderStatus,
  connectedVia,
  providerMethod,
  supportsPooledProviderKey,
  useManagedProvider,
  usePooledProviderIds,
  useProviderMeta,
} from '@/features/providers/provider-connect';
import {
  DeviceCode,
  ProviderKeyForm,
  RemoveKeyDialog,
  SUBSCRIPTION_BY_PROVIDER,
  useProviderKey,
} from '@/features/providers/provider-sheet';
import {
  ChatGptSubscriptionConnect,
  useSubscriptionSignIn,
} from '@/features/workspace/customize/sections/llm-provider/chatgpt-subscription-connect';
import { useConnectedProviders } from '@/features/workspace/customize/sections/llm-provider/use-connected-providers';
import {
  useLiveLlmProviderCatalog,
  useLlmProviderCatalogRevision,
} from '@/features/workspace/customize/sections/llm-provider/use-live-catalog';
import { orderProviderRows } from '@/features/workspace/customize/sections/llm-provider/utils';
import { AccountSecretResourcesPanel } from '@/features/workspace/customize/sections/view/account-secret-resources-panel';
import { useTranslations } from '@/i18n/use-translations';
import { LLM_PROVIDERS, LLM_PROVIDER_BY_ID, type LlmProviderEntry } from '@/lib/llm-providers';
import { cn } from '@/lib/utils';
import { useModelAccess } from '@kortix/sdk/react';

// ─── View ────────────────────────────────────────────────────────────────────

/** "In use · 3" / "Available" — the group label row, with an optional action. */
export function AccordionGroupLabel({
  label,
  action,
  className,
}: {
  label: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    // `px-3.5`: the same inset as the rows, so the group label starts on the
    // logo tiles' left edge.
    <div className={cn('flex items-center justify-between px-3.5 pb-1.5', className)}>
      <span className="text-muted-foreground text-xs tabular-nums">{label}</span>
      {action}
    </div>
  );
}

/** One line inside an expanded card: text on the left, its action on the right. */
export function AccordionSubRow({
  children,
  action,
  emphasis = false,
}: {
  children: ReactNode;
  action?: ReactNode;
  /** The switch row reads as a setting (ink), the rest as state (muted). */
  emphasis?: boolean;
}) {
  return (
    <div
      data-accordion-subrow=""
      className="border-border flex min-h-10 shrink-0 items-center justify-between gap-3 border-t"
    >
      <span
        className={cn(
          'min-w-0 truncate text-xs',
          emphasis ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        {children}
      </span>
      {action}
    </div>
  );
}

export interface InlineKeyFieldProps {
  providerId: string;
  envVar: string;
  value: string;
  onValueChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  error?: string | null;
}

/**
 * AK01's field: masked input, Save, ×. Enter saves, Esc cancels, Save stays
 * off until there is something to save.
 */
export function InlineKeyField({
  providerId,
  envVar,
  value,
  onValueChange,
  onSave,
  onCancel,
  saving,
  error,
}: InlineKeyFieldProps) {
  const t = useTranslations('providerSheet');
  const canSave = value.trim().length > 0 && !saving;
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (canSave) onSave();
    }
    if (event.key === 'Escape') {
      // Esc belongs to the field first, the dialog second.
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  };
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3" data-inline-key-field={providerId}>
      <Input
        type="password"
        autoFocus
        autoComplete="off"
        spellCheck={false}
        data-1p-ignore=""
        data-lpignore="true"
        data-form-type="other"
        aria-label={envVar}
        aria-invalid={error ? true : undefined}
        placeholder={envVar}
        value={value}
        disabled={saving}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={onKeyDown}
        className="h-8 min-w-0 flex-1 font-mono text-xs"
      />
      <Button type="button" size="xs" disabled={!canSave} onClick={onSave} className="gap-1.5">
        {saving ? <Loading className="size-3.5 shrink-0" /> : null}
        {t('save')}
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={t('cancel')}
        disabled={saving}
        onClick={onCancel}
        className="text-muted-foreground shrink-0"
      >
        <XIcon className="size-3.5" />
      </Button>
    </div>
  );
}

export interface AccordionRowHeaderProps {
  row: ProviderListRow;
  meta: string;
  expanded: boolean;
  /** Collapsed, available, single-key row: hovering shows "Add key". */
  addKeyHint: boolean;
  onToggle: () => void;
}

/** The row's own line: logo, name, meta, chevron. A button with aria-expanded. */
export function AccordionRowHeader({
  row,
  meta,
  expanded,
  addKeyHint,
  onToggle,
}: AccordionRowHeaderProps) {
  const t = useTranslations('providerSheet');
  return (
    <button
      type="button"
      aria-expanded={expanded}
      data-accordion-row={row.id}
      onClick={onToggle}
      className="group/row flex w-full items-center gap-3 text-left outline-none"
    >
      <ProviderLogoStatus providerId={row.id} label={row.label} status={row.status} size="medium" />
      <span className="min-w-0 flex-1">
        <span className="text-foreground block truncate text-sm font-medium">{row.label}</span>
        <span className="text-muted-foreground block truncate text-xs">{meta}</span>
      </span>
      {row.disabled ? (
        <span className="text-muted-foreground shrink-0 text-xs">{t('turnedOff')}</span>
      ) : null}
      {addKeyHint ? (
        <>
          {/* The board's hovered row: "Add key" takes the chevron's place.
              Presentational — the whole row is the button. */}
          <span
            aria-hidden
            className="bg-surface border-border hidden shrink-0 rounded-sm border px-2.5 py-1 text-xs font-medium group-hover/row:inline-flex group-focus-visible/row:inline-flex"
          >
            {t('addKeyShort')}
          </span>
          <CaretDownIcon className="text-muted-foreground size-3.5 shrink-0 group-hover/row:hidden group-focus-visible/row:hidden" />
        </>
      ) : (
        <CaretDownIcon
          className={cn(
            'text-muted-foreground size-3.5 shrink-0 transition-[rotate] duration-(--duration-normal) motion-reduce:transition-none',
            expanded && 'rotate-180',
          )}
        />
      )}
    </button>
  );
}

/** The collapsed row's surface; an open row becomes a bordered card. */
export function AccordionRowFrame({
  expanded,
  inline,
  children,
}: {
  expanded: boolean;
  /** AK01: the row is a field right now — the board fills it. */
  inline?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      data-accordion-frame={expanded ? 'open' : inline ? 'inline' : 'closed'}
      className={cn(
        'rounded-lg',
        expanded
          ? 'bg-surface border-border border'
          : inline
            ? 'bg-hover'
            : 'hover:bg-hover focus-within:bg-hover transition-[background-color] duration-(--duration-normal)',
      )}
    >
      {children}
    </div>
  );
}

// ─── Container ───────────────────────────────────────────────────────────────

/** A row being typed into: the AK01 field (one key) on the row's own line. */
function InlineAddKeyRow({
  projectId,
  entry,
  row,
  onDone,
}: {
  projectId: string;
  entry: LlmProviderEntry;
  row: ProviderListRow;
  onDone: () => void;
}) {
  const t = useTranslations('providerSheet');
  const key = useProviderKey(projectId, entry);
  const envVar = entry.envVars[0]!;
  return (
    <AccordionRowFrame expanded={false} inline>
      <div className="flex items-center gap-3 px-3.5 py-2.5">
        <ProviderLogoStatus providerId={row.id} label={row.label} status={row.status} size="medium" />
        <span className="flex w-40 shrink-0 flex-col">
          <span className="text-foreground truncate text-sm font-medium">{row.label}</span>
          {entry.helpUrl ? (
            <a
              href={entry.helpUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-[color] duration-(--duration-normal)"
            >
              {t('getAKey')}
              <ArrowSquareOutIcon className="size-3 shrink-0" />
            </a>
          ) : null}
        </span>
        <InlineKeyField
          providerId={entry.id}
          envVar={envVar}
          value={key.values[envVar] ?? ''}
          onValueChange={(value) => key.setValue(envVar, value)}
          saving={key.saving}
          error={key.error}
          onCancel={() => {
            key.reset();
            onDone();
          }}
          onSave={() => void key.save()?.then((ok) => ok && onDone())}
        />
      </div>
      {key.error ? (
        <p role="alert" className="text-destructive px-3.5 pb-2.5 pl-15.5 text-xs text-pretty">
          {key.error}
        </p>
      ) : null}
    </AccordionRowFrame>
  );
}

/** "Enable {name} for this project" — same rule and lock as the sheet's switch. */
function EnableSubRow({
  projectId,
  entry,
  canWrite,
  enabled,
}: {
  projectId: string;
  entry: LlmProviderEntry;
  canWrite: boolean;
  enabled: boolean;
}) {
  const t = useTranslations('providerSheet');
  const tAccess = useTranslations('modelAccess');
  const access = useModelAccess(enabled ? projectId : null);
  const data = access.data;
  if (!data?.enforced) return null;
  const on = !data.disabledProviders.includes(entry.id);
  const locked = access.defaultProvider === entry.id && on;
  const name = entry.id === 'kortix' ? tAccess('managedTitle') : entry.label;
  return (
    <AccordionSubRow
      emphasis
      action={
        <Switch
          checked={on}
          aria-label={t('enableForProject', { name })}
          title={locked ? tAccess('defaultProviderHint') : undefined}
          disabled={!canWrite || access.isUpdating || locked}
          onCheckedChange={(next) =>
            void access
              .setEnabled({ target: 'provider', id: entry.id, enabled: next })
              .catch((error: unknown) =>
                errorToast(error instanceof Error ? error.message : tAccess('providerError')),
              )
          }
          className="shrink-0"
        />
      }
    >
      {t('enableForProject', { name })}
    </AccordionSubRow>
  );
}

/** The key line inside an open card: saved / not added, and its actions. */
function KeySubRow({
  projectId,
  entry,
  saved,
  canWrite,
}: {
  projectId: string;
  entry: LlmProviderEntry;
  saved: boolean;
  canWrite: boolean;
}) {
  const t = useTranslations('providerSheet');
  const key = useProviderKey(projectId, entry);
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const envVar = entry.envVars[0]!;

  if (editing) {
    return (
      <div className="border-border border-t py-1.5">
        <InlineKeyField
          providerId={entry.id}
          envVar={envVar}
          value={key.values[envVar] ?? ''}
          onValueChange={(value) => key.setValue(envVar, value)}
          saving={key.saving}
          error={key.error}
          onCancel={() => {
            key.reset();
            setEditing(false);
          }}
          onSave={() => void key.save()?.then((ok) => ok && setEditing(false))}
        />
        {key.error ? (
          <p role="alert" className="text-destructive pt-1.5 text-xs text-pretty">
            {key.error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <>
      <AccordionSubRow
        action={
          canWrite ? (
            saved ? (
              <span className="flex shrink-0 items-center gap-1">
                <Button type="button" size="xs" variant="ghost" onClick={() => setEditing(true)}>
                  {t('replace')}
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setConfirmRemove(true)}
                >
                  {t('removeKey')}
                </Button>
              </span>
            ) : (
              <Button type="button" size="xs" variant="secondary" onClick={() => setEditing(true)}>
                {t('addKeyShort')}
              </Button>
            )
          ) : null
        }
      >
        {`${t('apiKey')} · ${saved ? t('savedKey') : t('notAdded')}`}
      </AccordionSubRow>
      <RemoveKeyDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        entry={entry}
        pending={key.removing}
        onConfirm={() => void key.remove()?.then((ok) => ok && setConfirmRemove(false))}
      />
    </>
  );
}

/** OpenAI / OpenCode Go: the sign-in line, and the device code while it runs. */
function SignInSubRows({
  projectId,
  entry,
  canWrite,
}: {
  projectId: string;
  entry: LlmProviderEntry;
  canWrite: boolean;
}) {
  const t = useTranslations('providerSheet');
  const sub = SUBSCRIPTION_BY_PROVIDER[entry.id]!;
  const sign = useSubscriptionSignIn({ projectId, kind: sub.kind, onConnected: () => undefined });
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const waiting = sign.phase === 'waiting';

  const copyCode = () => {
    if (!sign.challenge?.code) return;
    void navigator.clipboard?.writeText(sign.challenge.code).then(() => successToast(t('codeCopied')));
  };

  return (
    <>
      <AccordionSubRow
        action={
          !canWrite ? null : waiting ? (
            <Button type="button" size="xs" variant="ghost" onClick={sign.cancel}>
              {t('cancel')}
            </Button>
          ) : sign.connected ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="text-muted-foreground"
              disabled={sign.disconnect.isPending}
              onClick={() => setConfirmDisconnect(true)}
            >
              {t('disconnect')}
            </Button>
          ) : (
            <Button type="button" size="xs" variant="secondary" onClick={() => void sign.start()}>
              {t('signInTitle', { name: sub.name })}
            </Button>
          )
        }
      >
        {sign.connected
          ? `${t('subscription', { plan: sub.plan })} · ${t('signedIn')}`
          : waiting
            ? t('signingIn', { name: sub.name })
            : `${t('subscription', { plan: sub.plan })} · ${t('notConnected')}`}
      </AccordionSubRow>
      {waiting ? (
        <div className="border-border border-t py-3">
          <DeviceCode
            name={sub.name}
            code={sign.challenge?.code ?? null}
            url={sign.challenge?.url ?? null}
            onCopy={copyCode}
          />
        </div>
      ) : null}
      {sign.error ? (
        <p role="alert" className="text-destructive pb-1.5 text-xs text-pretty">
          {sign.error}
        </p>
      ) : null}
      <AlertDialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('disconnectTitle', { plan: sub.plan })}</AlertDialogTitle>
            <AlertDialogDescription>{t('disconnectBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={sign.disconnect.isPending}
              onClick={() => sign.disconnect.mutate()}
            >
              {t('disconnect')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** What an open card holds, by how the provider connects. */
function ExpandedBody({
  projectId,
  entry,
  status,
  keyConnected,
  canWrite,
  enabled,
  pooled,
}: {
  projectId: string;
  entry: LlmProviderEntry;
  status: ProviderStatus;
  keyConnected: boolean;
  canWrite: boolean;
  enabled: boolean;
  pooled: ReturnType<typeof usePooledProviderIds>;
}) {
  const t = useTranslations('providerSheet');
  const tPooled = useTranslations('pooledSecrets');
  const key = useProviderKey(projectId, entry);
  const method = providerMethod(entry);
  const enable =
    status !== 'none' ? (
      <EnableSubRow projectId={projectId} entry={entry} canWrite={canWrite} enabled={enabled} />
    ) : null;

  let content: ReactNode;
  if (method === 'included' || (entry.envVars.length === 0 && !SUBSCRIPTION_BY_PROVIDER[entry.id])) {
    content = <AccordionSubRow>{entry.hint}</AccordionSubRow>;
  } else if (pooled.pooledSecretsEnabled && pooled.accountId && entry.id === 'openai') {
    content = (
      <div className="border-border space-y-3 border-t py-3">
        <p className="text-foreground text-xs font-medium">{tPooled('chatGptAccounts')}</p>
        <AccountSecretResourcesPanel
          accountId={pooled.accountId}
          projectId={projectId}
          providerId="codex"
          providerName="ChatGPT Plus/Pro"
          envVar="CODEX_AUTH_JSON"
          canWrite
          oauth={{ projectId, onConnected: () => undefined }}
        />
        <ChatGptSubscriptionConnect projectId={projectId} onConnected={() => undefined} legacyOnly />
      </div>
    );
  } else if (pooled.pooledSecretsEnabled && pooled.accountId && supportsPooledProviderKey(entry)) {
    content = (
      <div className="border-border border-t py-3">
        <AccountSecretResourcesPanel
          accountId={pooled.accountId}
          projectId={projectId}
          providerId={entry.id}
          providerName={entry.label}
          envVar={entry.envVars[0]!}
          canWrite
        />
      </div>
    );
  } else if (SUBSCRIPTION_BY_PROVIDER[entry.id]) {
    content = (
      <>
        <SignInSubRows projectId={projectId} entry={entry} canWrite={canWrite} />
        <KeySubRow projectId={projectId} entry={entry} saved={keyConnected} canWrite={canWrite} />
      </>
    );
  } else if (entry.envVars.length > 1 && canWrite && !keyConnected) {
    // AK01 has no room for three fields on one line: Bedrock / Azure / Vertex
    // open to the sheet's multi-field form instead.
    content = (
      <div className="border-border border-t pt-3">
        <ProviderKeyForm
          entry={entry}
          values={key.values}
          onValueChange={key.setValue}
          saving={key.saving}
          error={key.error}
          onSave={() => void key.save()}
        />
      </div>
    );
  } else if (!canWrite && !keyConnected) {
    content = <AccordionSubRow>{t('readOnly')}</AccordionSubRow>;
  } else {
    content = (
      <KeySubRow projectId={projectId} entry={entry} saved={keyConnected} canWrite={canWrite} />
    );
  }

  return (
    <div className="flex flex-col gap-0.5 pr-3 pb-3 pl-15.5" data-accordion-body={entry.id}>
      {content}
      {enable}
    </div>
  );
}

export interface ProviderAccordionProps {
  projectId: string;
  canWrite?: boolean;
  enabled?: boolean;
  className?: string;
}

export function ProviderAccordion({
  projectId,
  canWrite = false,
  enabled = true,
  className,
}: ProviderAccordionProps) {
  const t = useTranslations('providerSheet');
  const common = useTranslations('common');
  const tPooled = useTranslations('pooledSecrets');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const meta = useProviderMeta();
  const access = useModelAccess(enabled ? projectId : null);
  const managedProvider = useManagedProvider(enabled ? projectId : null);
  const pooled = usePooledProviderIds(projectId, enabled);
  useLiveLlmProviderCatalog(projectId, enabled);
  const catalogRevision = useLlmProviderCatalogRevision();
  const { connectedProviders, providerStateLoading } = useConnectedProviders(projectId, enabled);

  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PROVIDER_PAGE_SIZE);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);

  const connectedIds = useMemo(
    () => new Set(connectedProviders.map((provider) => provider.id)),
    [connectedProviders],
  );

  const searchable = useMemo(() => [
    ...(access.data?.enforced ? [managedProvider] : []),
    ...LLM_PROVIDERS.filter((provider) => provider.id !== 'kortix'),
  // The module catalog is replaced out of band; its revision triggers a fresh read.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [access.data?.enforced, managedProvider, catalogRevision]);

  const entries = useMemo(
    () => new Map(searchable.map((entry) => [entry.id, entry])),
    [searchable],
  );

  const { inUse, available } = useMemo(() => {
    const ordered = orderProviderRows({
      providers: searchable,
      firstClassIds: ['kortix', ...FIRST_CLASS_PROVIDER_IDS],
      connectedIds,
      search,
    });
    const rows: ProviderListRow[] = ordered.map((entry) => {
      const method = providerMethod(entry);
      return {
        id: entry.id,
        label: entry.label,
        method,
        modelCount: entry.models.length,
        hint: entry.hint,
        status:
          method === 'included'
            ? entry.models.length > 0 ? 'included' : 'none'
            : connectedIds.has(entry.id) ||
                pooled.pooledProviderIds.has(entry.id) ||
                (entry.id === 'openai' && connectedIds.has('codex'))
              ? 'connected'
              : 'none',
        via: connectedVia(entry.id, connectedIds),
        disabled: access.data?.enforced === true && access.data.disabledProviders.includes(entry.id),
      };
    });
    return {
      inUse: rows.filter((row) => row.status !== 'none'),
      available: rows.filter((row) => row.status === 'none'),
    };
  }, [searchable, connectedIds, pooled.pooledProviderIds, search, access.data]);

  const searching = search.trim().length > 0;
  const visibleAvailable = available.slice(0, searching ? available.length : visibleCount);
  const hiddenCount = available.length - visibleAvailable.length;

  if (providerStateLoading || pooled.isLoading) {
    return (
      <div
        className="flex min-h-[200px] items-center justify-center"
        role="status"
        aria-label={tI18nComplete.raw('text7f619ff13aa8')}
      >
        <Loading className="text-muted-foreground size-4 shrink-0" />
      </div>
    );
  }

  if (pooled.isError) {
    return (
      <ErrorState
        size="sm"
        title={tPooled('loadError')}
        action={
          <Button size="sm" variant="secondary" disabled={pooled.isFetching} onClick={pooled.refetch}>
            {common('retry')}
          </Button>
        }
      />
    );
  }

  /** One provider: a field (AK01), an open card (PM01), or a closed row. */
  const renderRow = (row: ProviderListRow) => {
    const entry = entries.get(row.id) ?? LLM_PROVIDER_BY_ID.get(row.id);
    if (!entry) return null;
    const singleKey =
      entry.envVars.length === 1 &&
      !SUBSCRIPTION_BY_PROVIDER[entry.id] &&
      !(pooled.pooledSecretsEnabled && supportsPooledProviderKey(entry));
    const keyConnected = connectedIds.has(entry.id);

    if (addingId === row.id && singleKey && canWrite) {
      return (
        <InlineAddKeyRow
          key={row.id}
          projectId={projectId}
          entry={entry}
          row={row}
          onDone={() => setAddingId(null)}
        />
      );
    }

    const expanded = expandedId === row.id;
    // AK01: an available single-key row has nothing to show when opened
    // except a field — so it goes straight to the field.
    const addsInline = row.status === 'none' && singleKey && canWrite;
    return (
      <AccordionRowFrame key={row.id} expanded={expanded}>
        <div className={cn(expanded ? 'px-3 py-2.5' : 'px-3.5 py-2.5')}>
          <AccordionRowHeader
            row={row}
            meta={row.method === 'included' && row.modelCount === 0
              ? row.hint ?? ''
              : meta(row.method, row.modelCount, row.id, row.via)}
            expanded={expanded}
            addKeyHint={addsInline}
            onToggle={() => {
              if (addsInline) {
                setExpandedId(null);
                setAddingId(row.id);
                return;
              }
              setAddingId(null);
              setExpandedId(expanded ? null : row.id);
            }}
          />
        </div>
        {expanded ? (
          <ExpandedBody
            projectId={projectId}
            entry={entry}
            status={row.status}
            keyConnected={keyConnected}
            canWrite={canWrite}
            enabled={enabled}
            pooled={pooled}
          />
        ) : null}
      </AccordionRowFrame>
    );
  };

  const searchButton = (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      aria-label={t('searchProviders')}
      aria-pressed={searchOpen}
      className="text-muted-foreground"
      onClick={() => {
        if (searchOpen) setSearch('');
        setSearchOpen(!searchOpen);
      }}
    >
      <MagnifyingGlassIcon className="size-3.5" />
    </Button>
  );

  const empty = inUse.length === 0 && visibleAvailable.length === 0;

  return (
    <div className={cn('flex flex-col gap-1', className)} data-provider-accordion="">
      {searchOpen ? (
        <div className="pb-2">
          <InputGroupSearch>
            <InputGroupSearchIcon>
              <MagnifyingGlassIcon />
            </InputGroupSearchIcon>
            <InputGroupSearchInput
              autoFocus
              type="text"
              placeholder={t('searchPlaceholder', { count: searchable.length })}
              autoComplete="off"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && !search) {
                  event.stopPropagation();
                  setSearchOpen(false);
                }
              }}
            />
            <InputGroupSearchClear onClick={() => setSearch('')} />
          </InputGroupSearch>
        </div>
      ) : null}

      {pooled.pooledSecretsEnabled || !canWrite ? (
        <p className="text-muted-foreground px-1 pb-2 text-xs text-pretty">
          {pooled.pooledSecretsEnabled ? tPooled('sharedDescription') : t('readOnly')}
        </p>
      ) : null}

      {empty ? (
        <EmptyState size="sm" title={t('noMatch', { query: search.trim() })} />
      ) : (
        <>
          {inUse.length > 0 ? (
            <AccordionGroupLabel
              label={`${t('inUse')} · ${inUse.length}`}
              action={searchOpen ? null : searchButton}
            />
          ) : null}
          {inUse.map(renderRow)}
          {visibleAvailable.length > 0 ? (
            <AccordionGroupLabel
              label={t('available')}
              className={inUse.length > 0 ? 'pt-3.5' : undefined}
              action={inUse.length === 0 && !searchOpen ? searchButton : null}
            />
          ) : null}
          {visibleAvailable.map(renderRow)}
        </>
      )}

      {hiddenCount > 0 ? (
        <div className="flex items-center gap-2 px-1 pt-1" data-provider-load-more="">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setVisibleCount((shown) => shown + PROVIDER_PAGE_SIZE)}
          >
            {t('showMore')}
          </Button>
          <span className="text-muted-foreground text-xs tabular-nums">
            {t('shownOf', {
              shown: inUse.length + visibleAvailable.length,
              total: inUse.length + available.length,
            })}
          </span>
        </div>
      ) : null}
    </div>
  );
}
