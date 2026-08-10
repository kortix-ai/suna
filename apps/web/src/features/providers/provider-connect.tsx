'use client';

/**
 * `provider-connect.tsx` — THE provider connect surface. One component, mounted
 * by the Models settings tab (`gateway-view.tsx`'s Providers sub-tab, reached
 * through `features/workspace/settings/tabs/models-tab.tsx`), by the model
 * selector's connect dialog and by the Secrets tab's "Manage providers" button
 * (both through `llm-provider-modal.tsx`'s `ProjectProviderModal`, which is now
 * only a `Modal` shell around this file). JAY-510: a third copy is not
 * acceptable — that is the defect this file exists to remove.
 *
 * **Four sections, in this order** (JAY-510's target structure):
 *   1. Connected      — what is wired now, each with Disconnect.
 *   2. Add a provider — the three first-class providers as INLINE rows, one
 *                       field and one button each. No modal, no disclosure,
 *                       no search stands between a new user and them.
 *   3. More providers — a `Disclosure` that HOLDS the search. The search input
 *                       lives inside it, not above it, so the long tail costs
 *                       one click and the short list costs none.
 *   4. Custom provider — the OpenAI-compatible escape hatch, last.
 *
 * **What this replaced.** `ProjectProviderModal` used to be a three-tab surface
 * (Add provider / Connected / Models) with an always-on search bar above the
 * tabs, and its "Add provider" tab was a list -> provider detail -> connect
 * form drill-down (`catalog-tab.tsx`'s deleted `CatalogTab`). Connecting
 * Anthropic — the single most common action a new user takes — cost a modal, a
 * tab, a list row, a detail page and a form. It is now one field and one
 * button on the first screen.
 *
 * **Copy is reused, not rewritten.** The subscription-versus-key wording comes
 * verbatim from `PROVIDER_NOTES` (`provider-branding.tsx:28-36`) — the simple
 * model was already in the data; only the UI was complex. `provider-connect.test.tsx`
 * pins all three strings against that map so a rewrite fails the suite.
 *
 * **Anthropic's subscription half has no control — deliberate, disclosed.**
 * `PROVIDER_NOTES.anthropic` reads "Claude Pro/Max subscription or your own API
 * key", but there is no Anthropic OAuth anywhere in this repo: the only live
 * provider OAuth is `startProjectProviderOAuth(projectId, 'openai', ...)`
 * (`chatgpt-subscription-connect.tsx:58`). The note renders verbatim because
 * JAY-510 requires it; the missing flow is a product gap, not something this
 * file may invent. OpenAI's subscription half IS real and mounts as
 * `subscriptionSlots.openai`.
 *
 * **Layers.** `ProviderConnectView` is pure (props only, no hooks) so it renders
 * under `renderToStaticMarkup` with no `QueryClientProvider` — the repo's only
 * render-assertion idiom. `ProviderConnect` is the container and owns every
 * hook. Same split as `sandbox-tab.tsx` / `instructions-tab.tsx`.
 */

import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { Field, FieldLabel } from '@/components/ui/field';
import Hint from '@/components/ui/hint';
import { Input } from '@/components/ui/input';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import Loading from '@/components/ui/loading';
import { SettingsSectionHeader } from '@/components/ui/settings-section-header';
import { errorToast, successToast, warningToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { PROVIDER_NOTES, ProviderLogo } from '@/features/providers/provider-branding';
import { ChatGptSubscriptionConnect } from '@/features/workspace/customize/sections/llm-provider/chatgpt-subscription-connect';
import { CustomProviderForm } from '@/features/workspace/customize/sections/llm-provider/custom-provider-form';
import { ProviderDetail } from '@/features/workspace/customize/sections/llm-provider/provider-detail';
import { useConnectedProviders } from '@/features/workspace/customize/sections/llm-provider/use-connected-providers';
import {
  envVarPlaceholder,
  prettyFieldLabel,
  providerCredentialSummary,
  providerDisconnectPlan,
} from '@/features/workspace/customize/sections/llm-provider/utils';
import { LLM_PROVIDERS, LLM_PROVIDER_BY_ID, type LlmProviderEntry } from '@/lib/llm-providers';
import { cn } from '@/lib/utils';
import { deleteProjectProviderOAuth, deleteProjectSecret, upsertProjectSecret } from '@kortix/sdk';
import { qk, refreshProjectProviderState } from '@kortix/sdk/react';
import {
  CaretDownIcon as ChevronDown,
  ArrowSquareOutIcon as ExternalLink,
  MagnifyingGlassIcon as Search,
  PlusIcon as Plus,
  PlugsIcon as Unplug,
} from '@phosphor-icons/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

/**
 * The three providers JAY-510 makes first-class: "Anthropic (Claude), OpenAI
 * (ChatGPT), Google Gemini". Deliberately NOT `POPULAR_PROVIDER_IDS`, which is
 * a six-member SORT key for the long tail (`provider-branding.tsx:10-17`) and
 * also carries `github-copilot`, `openrouter` and `vercel`. Those three stay in
 * More providers, ranked first by that same sort key.
 */
export const FIRST_CLASS_PROVIDER_IDS = ['anthropic', 'openai', 'google'] as const;

/** Everything one provider row needs. Plain data — the view holds no hooks. */
export interface ProviderConnectRow {
  id: string;
  label: string;
  /** `PROVIDER_NOTES[id]`, rendered verbatim. Undefined for the long tail. */
  note?: string;
  /** Credential fields the row collects. One for all three first-class ids. */
  envVars: string[];
  helpUrl: string | null;
  connected: boolean;
  modelCount: number;
  /** Per-env-var input placeholder from `envVarPlaceholder`. Falls back to the
   *  env var name itself so the pure view never needs the catalog entry. */
  placeholders?: Record<string, string>;
}

export interface ProviderConnectViewProps {
  firstClass: ProviderConnectRow[];
  more: ProviderConnectRow[];
  /** Keyed `${providerId}:${envVar}`. */
  values: Record<string, string>;
  onValueChange: (providerId: string, envVar: string, value: string) => void;
  onConnect: (providerId: string) => void;
  pendingProviderId?: string | null;
  /**
   * Read-only members see every row but no credential field and no Connect
   * button — those POST secrets and would 403. Same gate the deleted
   * `CatalogTab` used (`catalog-tab.tsx:68-71`), applied by hiding the write
   * controls instead of folding a subview back to a list.
   */
  canWrite: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  moreOpen: boolean;
  onMoreOpenChange: (open: boolean) => void;
  /** Drives whether section 1 renders at all. */
  connectedCount: number;
  connectedSlot?: ReactNode;
  customSlot?: ReactNode;
  /** Per-provider extra auth affordance. Only `openai` has one today. */
  subscriptionSlots?: Record<string, ReactNode>;
  /**
   * Long-tail "browse before you connect". When set, the More-providers
   * disclosure renders `detailSlot` in place of its search + row list — the one
   * capability the deleted `CatalogTab` drill-down had that an inline row does
   * not. Never offered for the three first-class rows, which must stay one
   * field and one button.
   */
  detailProviderId?: string | null;
  onOpenDetail?: (providerId: string | null) => void;
  detailSlot?: ReactNode;
  className?: string;
}

const ROW_CHROME = 'bg-popover flex flex-col gap-3 rounded-md border px-4 py-3';

function ProviderRow({
  row,
  values,
  onValueChange,
  onConnect,
  pending,
  canWrite,
  subscriptionSlot,
  onOpenDetail,
}: {
  row: ProviderConnectRow;
  values: Record<string, string>;
  onValueChange: ProviderConnectViewProps['onValueChange'];
  onConnect: ProviderConnectViewProps['onConnect'];
  pending: boolean;
  canWrite: boolean;
  subscriptionSlot?: ReactNode;
  onOpenDetail?: (providerId: string) => void;
}) {
  const filled = row.envVars.every((envVar) => (values[`${row.id}:${envVar}`] ?? '').trim());
  return (
    <div className={ROW_CHROME} data-provider-row={row.id}>
      <div className="flex items-center gap-3">
        <ProviderLogo providerID={row.id} name={row.label} size="default" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-foreground truncate text-sm font-medium">{row.label}</span>
            {row.connected && (
              <Badge variant="success" size="sm">
                Connected
              </Badge>
            )}
          </div>
          {row.note && (
            <p className="text-muted-foreground mt-0.5 text-xs text-pretty">{row.note}</p>
          )}
        </div>
        {onOpenDetail && row.modelCount > 0 && (
          <button
            type="button"
            onClick={() => onOpenDetail(row.id)}
            className="text-muted-foreground hover:text-foreground shrink-0 cursor-pointer text-xs tabular-nums underline underline-offset-2 transition-colors"
          >
            {row.modelCount} model{row.modelCount === 1 ? '' : 's'}
          </button>
        )}
        {row.helpUrl && (
          <a
            href={row.helpUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground inline-flex shrink-0 items-center gap-1 text-xs transition-colors"
          >
            <ExternalLink className="size-3 shrink-0" />
            Get a key
          </a>
        )}
      </div>

      {canWrite && (
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            onConnect(row.id);
          }}
        >
          {row.envVars.map((envVar) => (
            <Field key={envVar} className="min-w-0 flex-1">
              <FieldLabel htmlFor={`provider-connect-${row.id}-${envVar}`} className="sr-only">
                {row.label} {prettyFieldLabel(envVar)}
              </FieldLabel>
              <Input
                id={`provider-connect-${row.id}-${envVar}`}
                type="text"
                autoComplete="off"
                aria-label={`${row.label} ${prettyFieldLabel(envVar)}`}
                placeholder={row.placeholders?.[envVar] ?? envVar}
                value={values[`${row.id}:${envVar}`] ?? ''}
                onChange={(event) => onValueChange(row.id, envVar, event.target.value)}
              />
            </Field>
          ))}
          <Button type="submit" size="sm" disabled={pending || !filled} className="shrink-0">
            {pending ? <Loading className="size-3.5 shrink-0" /> : null}
            {row.connected ? 'Reconnect' : 'Connect'}
          </Button>
        </form>
      )}

      {subscriptionSlot}
    </div>
  );
}

/**
 * Presentational only — no hooks, no fetching. Kept separate from
 * `ProviderConnect` so it renders under `renderToStaticMarkup`; every slot
 * defaults to `undefined` so the bare view needs no provider tree.
 */
export function ProviderConnectView({
  firstClass,
  more,
  values,
  onValueChange,
  onConnect,
  pendingProviderId = null,
  canWrite,
  search,
  onSearchChange,
  moreOpen,
  onMoreOpenChange,
  connectedCount,
  connectedSlot,
  customSlot,
  subscriptionSlots,
  detailProviderId = null,
  onOpenDetail,
  detailSlot,
  className,
}: ProviderConnectViewProps) {
  return (
    <div className={cn('flex flex-col gap-8 px-5 py-5', className)}>
      {/* 1 — Connected. Omitted entirely with nothing connected: a new user's
          first screen should open on "Add a provider", not on an empty box. */}
      {connectedCount > 0 && (
        <section className="flex flex-col gap-3">
          <SettingsSectionHeader
            title="Connected"
            description="Providers this project can call. Disconnecting deletes the stored credential."
          />
          {connectedSlot}
        </section>
      )}

      {/* 2 — Add a provider. Inline rows, no disclosure, no search. */}
      <section className="flex flex-col gap-3">
        <SettingsSectionHeader
          title="Add a provider"
          description={
            canWrite
              ? 'Paste a key and connect. Keys are project-wide and encrypted at rest — every member of this project can use them.'
              : 'You need write access on this project to connect a provider.'
          }
        />
        <div className="flex flex-col gap-2">
          {firstClass.map((row) => (
            <ProviderRow
              key={row.id}
              row={row}
              values={values}
              onValueChange={onValueChange}
              onConnect={onConnect}
              pending={pendingProviderId === row.id}
              canWrite={canWrite}
              subscriptionSlot={subscriptionSlots?.[row.id]}
            />
          ))}
        </div>
      </section>

      {/* 3 — More providers. The disclosure HOLDS the search: closed, neither
          the search box nor the long tail is in the document at all. */}
      {(more.length > 0 || search.trim().length > 0) && (
        <section className="flex flex-col gap-3" data-more-providers="">
          <Disclosure open={moreOpen} onOpenChange={onMoreOpenChange}>
            <DisclosureTrigger>
              <button
                type="button"
                data-more-providers-trigger=""
                className="text-foreground hover:bg-muted/40 flex w-full cursor-pointer items-center justify-between gap-2 rounded-md px-1 py-2 text-left text-sm transition-colors"
              >
                <span>
                  More providers{' '}
                  <span className="text-muted-foreground tabular-nums">({more.length})</span>
                </span>
                <ChevronDown
                  className={cn(
                    'text-muted-foreground size-4 shrink-0 transition-transform duration-200',
                    moreOpen && 'rotate-180',
                  )}
                />
              </button>
            </DisclosureTrigger>
            <DisclosureContent>
              {detailProviderId && detailSlot ? (
                <div className="pt-2">{detailSlot}</div>
              ) : (
                <div className="flex flex-col gap-2 pt-2">
                  <InputGroupSearch data-provider-search="">
                    <InputGroupSearchIcon>
                      <Search />
                    </InputGroupSearchIcon>
                    <InputGroupSearchInput
                      type="text"
                      placeholder="Search providers…"
                      autoComplete="off"
                      value={search}
                      onChange={(event) => onSearchChange(event.target.value)}
                    />
                    <InputGroupSearchClear onClick={() => onSearchChange('')} />
                  </InputGroupSearch>
                  {more.length === 0 && (
                    <EmptyState size="sm" title={`No providers match "${search}"`} />
                  )}
                  {more.map((row) => (
                    <ProviderRow
                      key={row.id}
                      row={row}
                      values={values}
                      onValueChange={onValueChange}
                      onConnect={onConnect}
                      pending={pendingProviderId === row.id}
                      canWrite={canWrite}
                      subscriptionSlot={subscriptionSlots?.[row.id]}
                      onOpenDetail={onOpenDetail}
                    />
                  ))}
                </div>
              )}
            </DisclosureContent>
          </Disclosure>
        </section>
      )}

      {/* 4 — Custom provider, the escape hatch, last. */}
      {customSlot && (
        <section className="flex flex-col gap-3">
          <SettingsSectionHeader
            title="Custom provider"
            description="Any OpenAI-compatible endpoint. Requests go straight to it, not through the Kortix gateway."
          />
          {customSlot}
        </section>
      )}
    </div>
  );
}

// ─── Connected list (section 1's slot) ───────────────────────────────────────

/**
 * Ported verbatim from the deleted `llm-provider/connected-tab.tsx` — same
 * `providerDisconnectPlan` call, same `deleteProjectProviderOAuth` +
 * `deleteProjectSecret` fan-out, same invalidations, same `ConfirmDialog`
 * before a disconnect, same `canWrite && !provider.managed` gate on the button.
 * Its empty-state and search-miss branches are gone because this only ever
 * mounts with at least one connected provider (`connectedCount > 0`).
 */
function ConnectedProviderList({
  projectId,
  connectedProviders,
  canWrite,
}: {
  projectId: string;
  connectedProviders: LlmProviderEntry[];
  canWrite: boolean;
}) {
  const queryClient = useQueryClient();
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const disconnect = useMutation({
    mutationFn: async (provider: LlmProviderEntry) => {
      const plan = providerDisconnectPlan(provider);
      await Promise.all([
        ...(plan.oauthProvider ? [deleteProjectProviderOAuth(projectId, plan.oauthProvider)] : []),
        ...plan.secretNames.map((name) => deleteProjectSecret(projectId, name)),
      ]);
      return provider;
    },
    onSuccess: (provider) => {
      successToast(`${provider.label} disconnected`);
      setConfirmId(null);
      queryClient.invalidateQueries({ queryKey: qk.project.secrets(projectId) });
      refreshProjectProviderState(queryClient, projectId);
    },
    onError: (err) => errorToast(err instanceof Error ? err.message : 'Failed to disconnect'),
  });

  const confirmProvider = confirmId
    ? (connectedProviders.find((p) => p.id === confirmId) ?? LLM_PROVIDER_BY_ID.get(confirmId) ?? null)
    : null;

  return (
    <>
      <ul className="flex flex-col gap-2">
        {connectedProviders.map((provider) => {
          const busy = disconnect.isPending && disconnect.variables?.id === provider.id;
          return (
            <li
              key={provider.id}
              className="bg-popover flex items-center gap-3 rounded-md border px-4 py-2.5"
            >
              <ProviderLogo providerID={provider.id} name={provider.label} size="default" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-foreground truncate text-sm font-medium">
                    {provider.label}
                  </span>
                  {provider.managed && (
                    <Badge size="sm" variant="secondary">
                      Managed
                    </Badge>
                  )}
                </div>
                <p className="text-muted-foreground mt-0.5 truncate text-xs">
                  {provider.managed
                    ? `${provider.hint} · ${provider.models.length} model${provider.models.length === 1 ? '' : 's'}`
                    : `${providerCredentialSummary(provider)} · ${provider.models.length} model${provider.models.length === 1 ? '' : 's'}`}
                </p>
              </div>
              {canWrite && !provider.managed && (
                <Hint label="Disconnect">
                  <Button
                    type="button"
                    onClick={() => setConfirmId(provider.id)}
                    disabled={disconnect.isPending}
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground/40 hover:text-foreground shrink-0"
                    aria-label="Disconnect"
                  >
                    {busy ? (
                      <Loading className="size-3.5 shrink-0" />
                    ) : (
                      <Unplug className="size-3.5 shrink-0" />
                    )}
                  </Button>
                </Hint>
              )}
            </li>
          );
        })}
      </ul>

      <ConfirmDialog
        open={!!confirmId}
        onOpenChange={(open) => !open && setConfirmId(null)}
        title="Disconnect provider"
        confirmLabel="Disconnect"
        confirmVariant="destructive"
        confirmIcon={<Unplug className="size-3.5 shrink-0" />}
        isPending={disconnect.isPending}
        onConfirm={() => confirmProvider && disconnect.mutate(confirmProvider)}
        description={
          confirmProvider ? (
            <span className="text-xs">
              Remove <span className="text-foreground font-medium">{confirmProvider.label}</span>?
              This deletes{' '}
              {confirmProvider.envVars.length === 1 ? (
                <>
                  the{' '}
                  <code className="bg-muted rounded px-1 py-0.5 font-mono">
                    {confirmProvider.envVars[0]}
                  </code>{' '}
                  project secret.
                </>
              ) : (
                <>
                  {confirmProvider.envVars.length} project secrets (
                  {confirmProvider.envVars.map((envVar, index) => (
                    <span key={envVar}>
                      {index > 0 && ', '}
                      <code className="bg-muted rounded px-1 py-0.5 font-mono">{envVar}</code>
                    </span>
                  ))}
                  ).
                </>
              )}{' '}
              You&apos;ll need to reconnect to use it again.
            </span>
          ) : null
        }
      />
    </>
  );
}

// ─── Custom provider (section 4's slot) ──────────────────────────────────────

/**
 * `CustomProviderForm` is mounted unchanged (JAY-510: "behaviour unchanged"),
 * behind a disclosure so the escape hatch does not dominate the screen it is
 * last on. Its `onBack`/`onDone` both close the disclosure — the same two exits
 * the deleted `CatalogTab` subview gave it.
 */
function CustomProviderSection({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-fit gap-1.5"
        onClick={() => setOpen(true)}
      >
        <Plus className="size-3.5 shrink-0" />
        Add a custom provider
      </Button>
    );
  }
  return (
    <div className="bg-popover -mx-4 rounded-md border">
      <CustomProviderForm
        projectId={projectId}
        onBack={() => setOpen(false)}
        onDone={() => setOpen(false)}
      />
    </div>
  );
}

// ─── Container ───────────────────────────────────────────────────────────────

const CONNECTION_REFRESH_TIMEOUT_MS = 45_000;

function toRow(entry: LlmProviderEntry, connectedIds: Set<string>): ProviderConnectRow {
  return {
    id: entry.id,
    label: entry.label,
    note: PROVIDER_NOTES[entry.id],
    envVars: entry.envVars,
    helpUrl: entry.helpUrl,
    connected: connectedIds.has(entry.id),
    modelCount: entry.models.length,
    placeholders: Object.fromEntries(
      entry.envVars.map((envVar) => [envVar, envVarPlaceholder(entry, envVar)]),
    ),
  };
}

export interface ProviderConnectProps {
  projectId: string;
  /** Same value the deleted modal body took — see `ProviderConnectViewProps`. */
  canWrite?: boolean;
  /** Set while this surface is visible; drives the underlying queries. */
  enabled?: boolean;
  className?: string;
}

export function ProviderConnect({
  projectId,
  canWrite = false,
  enabled = true,
  className,
}: ProviderConnectProps) {
  const { connectedProviders, providerStateLoading } = useConnectedProviders(projectId, enabled);
  const queryClient = useQueryClient();

  const [values, setValues] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [moreOpen, setMoreOpen] = useState(false);
  const [pendingProviderId, setPendingProviderId] = useState<string | null>(null);
  const [detailProviderId, setDetailProviderId] = useState<string | null>(null);
  const detailEntry = detailProviderId ? (LLM_PROVIDER_BY_ID.get(detailProviderId) ?? null) : null;

  const connectedIds = useMemo(
    () => new Set(connectedProviders.map((provider) => provider.id)),
    [connectedProviders],
  );

  const firstClass = useMemo(
    () =>
      FIRST_CLASS_PROVIDER_IDS.map((id) => LLM_PROVIDER_BY_ID.get(id))
        .filter((entry): entry is LlmProviderEntry => !!entry)
        .map((entry) => toRow(entry, connectedIds)),
    [connectedIds],
  );

  const more = useMemo(() => {
    const q = search.trim().toLowerCase();
    return LLM_PROVIDERS.filter(
      (provider) =>
        provider.id !== 'kortix' &&
        !(FIRST_CLASS_PROVIDER_IDS as readonly string[]).includes(provider.id),
    )
      .filter(
        (provider) =>
          !q ||
          provider.label.toLowerCase().includes(q) ||
          provider.id.toLowerCase().includes(q) ||
          provider.envVars.some((envVar) => envVar.toLowerCase().includes(q)),
      )
      .map((entry) => toRow(entry, connectedIds));
  }, [search, connectedIds]);

  const connect = useMutation({
    mutationFn: async (providerId: string) => {
      const entry = LLM_PROVIDER_BY_ID.get(providerId);
      if (!entry) throw new Error(`Unknown provider ${providerId}`);
      // LLM provider credentials are ALWAYS project-wide — a per-user key is
      // invisible to the gateway's shared-row resolution and every model turn
      // dies with "No upstream configured" (2026-07-07 prod incident). Ported
      // verbatim from the deleted `api-key-connect-form.tsx:52-62`.
      for (const envVar of entry.envVars) {
        await upsertProjectSecret(projectId, {
          name: envVar,
          value: (values[`${providerId}:${envVar}`] ?? '').trim(),
          strategy: 'broker',
          consumer: 'llm_gateway',
        });
      }
      return entry;
    },
    onSuccess: (entry) => {
      successToast(`${entry.label} connected`);
      setValues((current) => {
        const next = { ...current };
        for (const envVar of entry.envVars) delete next[`${entry.id}:${envVar}`];
        return next;
      });
      setPendingProviderId(entry.id);
      queryClient.invalidateQueries({ queryKey: qk.project.secrets(projectId) });
      refreshProjectProviderState(queryClient, projectId, { expectProviderId: entry.id });
    },
    onError: (err) =>
      errorToast(err instanceof Error ? err.message : 'Failed to save credentials'),
  });

  // Clear the row's pending state once the provider actually shows up as
  // connected, and warn if the refresh never lands. Same contract as the
  // deleted modal's `pendingProviderId` effect (`llm-provider-modal.tsx:90-105`),
  // minus the full-surface takeover it used to render.
  useEffect(() => {
    if (!pendingProviderId) return;
    if (connectedIds.has(pendingProviderId)) {
      setPendingProviderId(null);
      return;
    }
    const timeout = window.setTimeout(() => {
      setPendingProviderId(null);
      warningToast('The key was saved, but the connected provider list did not refresh.');
    }, CONNECTION_REFRESH_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [connectedIds, pendingProviderId]);

  const handleValueChange = useCallback((providerId: string, envVar: string, value: string) => {
    setValues((current) => ({ ...current, [`${providerId}:${envVar}`]: value }));
  }, []);

  const handleConnect = useCallback(
    (providerId: string) => connect.mutate(providerId),
    [connect],
  );

  if (providerStateLoading) {
    return (
      <div
        className="flex min-h-[200px] items-center justify-center"
        role="status"
        aria-label="Loading providers"
      >
        <Loading className="text-muted-foreground size-4 shrink-0" />
      </div>
    );
  }

  return (
    <ProviderConnectView
      className={className}
      firstClass={firstClass}
      more={more}
      values={values}
      onValueChange={handleValueChange}
      onConnect={handleConnect}
      pendingProviderId={connect.isPending ? connect.variables : pendingProviderId}
      canWrite={canWrite}
      search={search}
      onSearchChange={setSearch}
      moreOpen={moreOpen}
      onMoreOpenChange={setMoreOpen}
      connectedCount={connectedProviders.length}
      connectedSlot={
        connectedProviders.length > 0 ? (
          <ConnectedProviderList
            projectId={projectId}
            connectedProviders={connectedProviders}
            canWrite={canWrite}
          />
        ) : undefined
      }
      customSlot={canWrite ? <CustomProviderSection projectId={projectId} /> : undefined}
      subscriptionSlots={
        canWrite
          ? {
              // The ONLY live provider subscription flow in the repo. Anthropic
              // has no OAuth anywhere — see this file's header comment.
              openai: (
                <ChatGptSubscriptionConnect
                  projectId={projectId}
                  onConnected={setPendingProviderId}
                />
              ),
            }
          : undefined
      }
      detailProviderId={detailProviderId}
      onOpenDetail={setDetailProviderId}
      detailSlot={
        detailEntry ? (
          <ProviderDetail
            provider={detailEntry}
            isConnected={connectedIds.has(detailEntry.id)}
            canWrite={canWrite}
            onBack={() => setDetailProviderId(null)}
            onConnect={() => setDetailProviderId(null)}
          />
        ) : undefined
      }
    />
  );
}
