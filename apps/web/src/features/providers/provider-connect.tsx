'use client';

/**
 * `provider-connect.tsx` — the provider LIST of the Models page's Providers
 * tab and of the quick provider dialog (`llm-provider-modal.tsx`).
 *
 * A search field and two groups: **In use** (Kortix's included models and every
 * provider with a stored credential) and **Available** (the rest of the
 * catalogue, a page at a time). A row is a button: it opens that provider in
 * the host's `SplitSheet`, where the key, the sign-in and the models live
 * (`provider-sheet.tsx`). The list itself writes nothing.
 *
 * It used to carry a key field on every row and save on blur. That put 12
 * inputs on the screen to connect one provider, and a save nobody could see.
 * The sheet has an explicit Save and room for the two-way OpenAI choice.
 *
 * **Layers.** `ProviderConnectView` is pure (props only) so it renders under
 * `renderToStaticMarkup` with no `QueryClientProvider` — the repo's only
 * render-assertion idiom. `ProviderConnect` is the container and owns every
 * hook.
 */

import { CaretRightIcon, CheckCircleIcon, MagnifyingGlassIcon as Search } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import Loading from '@/components/ui/loading';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { ProviderLogo } from '@/features/providers/provider-branding';
import { useConnectedProviders } from '@/features/workspace/customize/sections/llm-provider/use-connected-providers';
import {
  useLiveLlmProviderCatalog,
  useLlmProviderCatalogRevision,
} from '@/features/workspace/customize/sections/llm-provider/use-live-catalog';
import {
  managedProviderHint,
  orderProviderRows,
} from '@/features/workspace/customize/sections/llm-provider/utils';
import { useTranslations } from '@/i18n/use-translations';
import { LLM_PROVIDERS, type LlmProviderEntry } from '@/lib/llm-providers';
import { cn } from '@/lib/utils';
import { getProjectDetail } from '@kortix/sdk';
import {
  qk,
  useAccountSecretResources,
  useFeatureFlag,
  useModelAccess,
  useProjectModelPickerCatalog,
} from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';

/**
 * The three providers JAY-510 makes first-class: "Anthropic (Claude), OpenAI
 * (ChatGPT), Google Gemini". They lead the Available group after Kortix; every
 * other provider follows in catalogue order.
 */
export const FIRST_CLASS_PROVIDER_IDS = ['anthropic', 'openai', 'google'] as const;

/** Providers whose sheet offers a subscription sign-in beside the API key. */
export const SUBSCRIPTION_PROVIDER_IDS: ReadonlySet<string> = new Set(['openai', 'opencode-go']);

/**
 * How many Available providers render before `Show more`, and how many each
 * press adds. A query is a request for its matches — all of them — so a search
 * renders every match whatever this window is.
 */
export const PROVIDER_PAGE_SIZE = 12;

// Mirrors the gateway's base-URL fallbacks in provider-registry.ts. A provider
// without an API host or one of these fallbacks cannot create a gateway key.
const GATEWAY_BASE_URL_FALLBACK_IDS = new Set([
  'anthropic', 'openai', 'google', 'groq', 'x-ai', 'xai', 'mistral', 'deepseek',
  'perplexity', 'cerebras', 'vercel', 'v0', 'deepinfra', 'togetherai',
]);

export function supportsPooledProviderKey(entry: LlmProviderEntry | undefined): boolean {
  return Boolean(entry && entry.envVars.length === 1 &&
    (entry.apiHost || GATEWAY_BASE_URL_FALLBACK_IDS.has(entry.id)));
}

export type ProviderStatus = 'included' | 'connected' | 'none';

/** How a provider is connected: the row's meta and the sheet's subtitle. */
export type ProviderMethod = 'included' | 'key' | 'signIn' | 'signInOrKey';

export function providerMethod(entry: Pick<LlmProviderEntry, 'id' | 'envVars' | 'managed'>): ProviderMethod {
  if (entry.managed || entry.id === 'kortix') return 'included';
  if (SUBSCRIPTION_PROVIDER_IDS.has(entry.id)) return 'signInOrKey';
  return entry.envVars.length === 0 ? 'signIn' : 'key';
}

/** Everything one provider row needs. Plain data — the view holds no hooks. */
export interface ProviderListRow {
  id: string;
  label: string;
  method: ProviderMethod;
  modelCount: number;
  status: ProviderStatus;
  /** How a connected two-way provider is connected (OpenAI only today). */
  via?: ConnectedVia;
  /** Inference turned off for this project; credentials are kept. */
  disabled?: boolean;
}

/**
 * The provider logo with its status on the tile's corner: a solid green check
 * when the provider is usable (connected, or included with the plan). The list
 * row and the sheet header draw the same one.
 */
export function ProviderLogoStatus({
  providerId,
  label,
  status,
  size = 'small',
}: {
  providerId: string;
  label: string;
  status: ProviderStatus;
  size?: 'small' | 'medium' | 'large';
}) {
  const t = useTranslations('providerSheet');
  return (
    <span className="relative inline-flex shrink-0">
      <ProviderLogo providerID={providerId} name={label} size={size} tone="light" />
      {status !== 'none' ? (
        <span
          role="img"
          aria-label={status === 'included' ? t('included') : t('connected')}
          className="bg-background absolute -right-1 -bottom-1 flex rounded-full"
        >
          <CheckCircleIcon
            weight="fill"
            className={cn('text-kortix-green', size === 'large' ? 'size-4.5' : 'size-4')}
          />
        </span>
      ) : null}
    </span>
  );
}

/** The subscription plan a two-way provider signs in with. */
export const SUBSCRIPTION_PLANS: Readonly<Record<string, string>> = {
  openai: 'ChatGPT Plus or Pro',
  'opencode-go': 'OpenCode Go',
};

/** How a connected two-way provider is connected. Undefined: not connected, or unknown. */
export type ConnectedVia = 'signIn' | 'key' | 'both';

/**
 * OpenAI's ChatGPT sign-in connects as provider `codex`, its API key as
 * `openai`, so the two can be told apart. Other providers report undefined.
 */
export function connectedVia(providerId: string, connectedIds: ReadonlySet<string>): ConnectedVia | undefined {
  if (providerId !== 'openai') return undefined;
  const signIn = connectedIds.has('codex');
  const key = connectedIds.has('openai');
  return signIn && key ? 'both' : signIn ? 'signIn' : key ? 'key' : undefined;
}

/**
 * "API key · 14 models" — the same line under the row and the sheet title.
 * A connected two-way provider says HOW it is connected, not how it could be.
 */
export function useProviderMeta() {
  const t = useTranslations('providerSheet');
  return (method: ProviderMethod, modelCount: number, providerId?: string, via?: ConnectedVia) => {
    const plan = providerId ? SUBSCRIPTION_PLANS[providerId] : undefined;
    const how =
      method === 'included'
        ? t('metaIncluded')
        : method === 'signIn'
          ? t('metaSignIn')
          : method === 'signInOrKey'
            ? via === 'both' && plan
              ? t('metaBoth', { plan })
              : via === 'signIn' && plan
                ? t('subscription', { plan })
                : via === 'key'
                  ? t('metaKey')
                  : t('metaSignInOrKey')
            : t('metaKey');
    return modelCount > 0 ? `${how} · ${t('models', { count: modelCount })}` : how;
  };
}

export interface ProviderConnectViewProps {
  /** Kortix and every provider with a credential. Never paged. */
  inUse: ProviderListRow[];
  /** Everything else, already windowed by the host. */
  available: ProviderListRow[];
  /** The CATALOGUE's size — what the search placeholder counts. */
  totalCount: number;
  /** Available rows matching but not rendered yet. `0` while searching. */
  hiddenCount?: number;
  onLoadMore?: () => void;
  search: string;
  onSearchChange: (value: string) => void;
  /** The provider open in the host's sheet, if any. */
  selectedId?: string | null;
  onSelect: (providerId: string) => void;
  /** One line above the list: read-only members and pooled-keys mode only. */
  note?: string;
  className?: string;
}

function ProviderRow({
  row,
  selected,
  onSelect,
}: {
  row: ProviderListRow;
  selected: boolean;
  onSelect: (providerId: string) => void;
}) {
  const t = useTranslations('providerSheet');
  const meta = useProviderMeta();
  return (
    <button
      type="button"
      data-provider-row={row.id}
      aria-current={selected || undefined}
      onClick={() => onSelect(row.id)}
      className={cn(
        'group flex min-h-12 w-full items-center gap-3 rounded-md px-3 py-2 text-left',
        'hover:bg-muted/60 transition-[background-color] duration-(--duration-normal) ease-out',
        'focus-visible:ring-ring/50 outline-none focus-visible:ring-2',
        selected && 'bg-muted hover:bg-muted',
      )}
    >
      <ProviderLogoStatus providerId={row.id} label={row.label} status={row.status} size="medium" />
      <span className="min-w-0 flex-1">
        <span className="text-foreground block truncate text-sm font-medium">{row.label}</span>
        <span className="text-muted-foreground block truncate text-xs">
          {meta(row.method, row.modelCount, row.id, row.via)}
        </span>
      </span>
      {row.disabled ? (
        <span className="text-muted-foreground shrink-0 text-xs">{t('turnedOff')}</span>
      ) : null}
      <CaretRightIcon
        className={cn(
          'text-muted-foreground size-3.5 shrink-0 transition-[color] duration-(--duration-normal)',
          'group-hover:text-foreground',
          selected && 'text-foreground',
        )}
      />
    </button>
  );
}

function ProviderGroup({
  label,
  rows,
  selectedId,
  onSelect,
}: {
  label: string;
  rows: ProviderListRow[];
  selectedId?: string | null;
  onSelect: (providerId: string) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <section className="flex flex-col gap-0.5" aria-label={label}>
      <h3 className="text-muted-foreground px-3 pb-1 text-xs font-medium tabular-nums">
        {label}
      </h3>
      {rows.map((row) => (
        <ProviderRow key={row.id} row={row} selected={row.id === selectedId} onSelect={onSelect} />
      ))}
    </section>
  );
}

/** Presentational only — no hooks beyond translations, no fetching. */
export function ProviderConnectView({
  inUse,
  available,
  totalCount,
  hiddenCount = 0,
  onLoadMore,
  search,
  onSearchChange,
  selectedId,
  onSelect,
  note,
  className,
}: ProviderConnectViewProps) {
  const t = useTranslations('providerSheet');
  const empty = inUse.length === 0 && available.length === 0;
  return (
    <div className={cn('flex flex-col gap-5', className)}>
      <InputGroupSearch data-provider-search="">
        <InputGroupSearchIcon>
          <Search />
        </InputGroupSearchIcon>
        <InputGroupSearchInput
          type="text"
          placeholder={t('searchPlaceholder', { count: totalCount })}
          autoComplete="off"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
        />
        <InputGroupSearchClear onClick={() => onSearchChange('')} />
      </InputGroupSearch>

      {note ? <p className="text-muted-foreground px-3 text-xs text-pretty">{note}</p> : null}

      {empty ? (
        <EmptyState size="sm" title={t('noMatch', { query: search.trim() })} />
      ) : (
        <div className="flex flex-col gap-5">
          <ProviderGroup
            label={`${t('inUse')} · ${inUse.length}`}
            rows={inUse}
            selectedId={selectedId}
            onSelect={onSelect}
          />
          <ProviderGroup
            label={t('available')}
            rows={available}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        </div>
      )}

      {hiddenCount > 0 && onLoadMore ? (
        <div className="flex items-center gap-2 px-1" data-provider-load-more="">
          <Button variant="ghost" size="sm" onClick={onLoadMore}>
            {t('showMore')}
          </Button>
          <span className="text-muted-foreground text-xs tabular-nums">
            {t('shownOf', {
              shown: inUse.length + available.length,
              total: inUse.length + available.length + hiddenCount,
            })}
          </span>
        </div>
      ) : null}
    </div>
  );
}

// ─── Container ───────────────────────────────────────────────────────────────

/**
 * Kortix's managed provider, built from the served model-picker catalogue —
 * the same truth the model picker renders. Zero models (a free plan with no
 * servable platform default) switches the hint to the upgrade story so both
 * surfaces tell one story (KRTX-1482).
 */
export function useManagedProvider(projectId: string | null): LlmProviderEntry {
  const tAccess = useTranslations('modelAccess');
  const pickerCatalog = useProjectModelPickerCatalog(projectId);
  return useMemo<LlmProviderEntry>(() => {
    const managedModels = Object.entries(pickerCatalog?.models ?? {})
      .filter(([id]) => !id.includes('/'))
      .map(([id, model]) => ({
        id,
        name: model.name || id,
        description: model.description,
        reasoning: model.reasoning,
        tool_call: model.tool_call,
        attachment: model.attachment,
        limit: model.limit,
        cost: model.cost,
      }));
    return {
      id: 'kortix',
      label: 'Kortix',
      envVars: [],
      authRequirement: { methods: [] },
      helpUrl: null,
      apiHost: null,
      hint: managedProviderHint(managedModels, {
        managedDescription: tAccess('managedDescription'),
        managedUpgradeHint: tAccess('managedUpgradeHint'),
      }),
      models: managedModels,
      featured: true,
      managed: true,
    };
  }, [pickerCatalog, tAccess]);
}

/** Provider ids that hold a usable pooled (account-level) key for this project. */
export function usePooledProviderIds(projectId: string, enabled: boolean) {
  const pooledFlag = useFeatureFlag(enabled ? projectId : null, 'pooled_provider_secrets');
  const pooledSecretsEnabled = pooledFlag.enabled;
  const project = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    enabled: enabled && pooledSecretsEnabled,
  });
  const accountId = project.data?.project?.account_id;
  const pooledResources = useAccountSecretResources(
    enabled && pooledSecretsEnabled ? accountId : null,
    projectId,
  );
  const pooledProviderIds = useMemo(
    () =>
      new Set(
        (pooledResources.data?.secrets ?? [])
          .filter((secret) => secret.can_use && secret.active)
          .map((secret) => secret.provider_id),
      ),
    [pooledResources.data],
  );
  return {
    pooledSecretsEnabled,
    accountId,
    pooledProviderIds,
    isLoading:
      pooledFlag.isLoading || (pooledSecretsEnabled && (project.isLoading || pooledResources.isLoading)),
    isError: pooledSecretsEnabled && (project.isError || pooledResources.isError),
    isFetching: project.isFetching || pooledResources.isFetching,
    refetch: () => {
      void project.refetch();
      void pooledResources.refetch();
    },
  };
}

export interface ProviderConnectProps {
  projectId: string;
  canWrite?: boolean;
  /** Set while this surface is visible; drives the underlying queries. */
  enabled?: boolean;
  selectedId?: string | null;
  onSelect: (providerId: string) => void;
  className?: string;
}

export function ProviderConnect({
  projectId,
  canWrite = false,
  enabled = true,
  selectedId,
  onSelect,
  className,
}: ProviderConnectProps) {
  const t = useTranslations('providerSheet');
  const common = useTranslations('common');
  const tPooled = useTranslations('pooledSecrets');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const access = useModelAccess(enabled ? projectId : null);
  const managedProvider = useManagedProvider(enabled ? projectId : null);
  const pooled = usePooledProviderIds(projectId, enabled);
  useLiveLlmProviderCatalog(projectId, enabled);
  const catalogRevision = useLlmProviderCatalogRevision();
  const { connectedProviders, providerStateLoading } = useConnectedProviders(projectId, enabled);

  const [search, setSearch] = useState('');
  const [visibleCount, setVisibleCount] = useState(PROVIDER_PAGE_SIZE);

  const connectedIds = useMemo(
    () => new Set(connectedProviders.map((provider) => provider.id)),
    [connectedProviders],
  );

  // The revision subscription above re-renders this component after the live
  // catalogue replaces the module binding.
  const searchable = useMemo(() => [
    ...(access.data?.enforced ? [managedProvider] : []),
    ...LLM_PROVIDERS.filter((provider) => provider.id !== 'kortix'),
  // The module catalog is replaced out of band; its revision triggers a fresh read.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [access.data?.enforced, managedProvider, catalogRevision]);

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
        status:
          method === 'included'
            ? 'included'
            : connectedIds.has(entry.id) ||
                pooled.pooledProviderIds.has(entry.id) ||
                // A ChatGPT sign-in connects OpenAI as provider `codex`.
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
  const limit = searching ? available.length : visibleCount;
  const visibleAvailable = available.slice(0, limit);

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

  return (
    <ProviderConnectView
      inUse={inUse}
      available={visibleAvailable}
      totalCount={searchable.length}
      hiddenCount={available.length - visibleAvailable.length}
      onLoadMore={() => setVisibleCount((shown) => shown + PROVIDER_PAGE_SIZE)}
      search={search}
      onSearchChange={setSearch}
      selectedId={selectedId}
      onSelect={onSelect}
      note={
        pooled.pooledSecretsEnabled
          ? tPooled('sharedDescription')
          : canWrite
            ? undefined
            : t('readOnly')
      }
      className={className}
    />
  );
}
