'use client';

/**
 * ConnectProviderContent — the canonical provider connection UI.
 *
 * Renders inline (no Dialog wrapper). Used by:
 * - Setup overlay: rendered directly in the overlay card
 * - Settings modal: rendered in the Providers tab
 * - ConnectProviderDialog (model-selector.tsx): wrapped in a Dialog
 *
 * All provider connection flows go through this one component.
 */

import { useState, useMemo, useCallback, useEffect } from 'react';
import { cn } from '@/lib/utils';
import {
  Search,
  ArrowLeft,
  Loader2,
  ExternalLink,
  AlertCircle,
  ChevronRight,
  ChevronDown,
  Key,
  Globe,
  Plus,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import {
  POPULAR_PROVIDER_IDS,
  PROVIDER_LABELS,
  PROVIDER_NOTES,
  ProviderLogo,
} from '@/components/providers/provider-branding';
import {
  GroupHeading,
  ProviderCard,
} from '@/components/providers/provider-card';

import { getClient } from '@/lib/opencode-sdk';
import { useQueryClient } from '@tanstack/react-query';
import { opencodeKeys } from '@/hooks/opencode/use-opencode-sessions';
import type { ProviderListResponse } from '@/hooks/opencode/use-opencode-sessions';
import { configKeys } from '@/hooks/opencode/use-opencode-config';
import { toast } from '@/lib/toast';
import {
  buildCustomProviderConfigUpdate,
  isEnvReference,
  normalizeCustomProviderForm,
  validateCustomProviderForm,
} from '@/components/providers/custom-provider-config';

const FALLBACK_PROVIDER_CARDS: Array<{ id: string; name: string }> = [];

function unwrapResult<T>(result: { data?: T; error?: unknown }): T {
  if (result.error) {
    const err = result.error as {
      message?: string;
      data?: { message?: string };
    };
    throw new Error(err?.data?.message || err?.message || 'Request failed');
  }
  return result.data as T;
}

// =============================================================================
// Auth method display helpers
// =============================================================================

/** Normalize auth method label — API type always shows "API key" per upstream convention */
function methodLabel(method: { type: string; label: string }) {
  if (method.type === 'api') return 'API key';
  return method.label || 'OAuth';
}

/**
 * Coerce any thrown value into a user-readable string.
 *
 * The OpenCode SDK rejects with plain error-shaped objects (not `Error`
 * instances), so `String(err)` used to render the useless `[object Object]`.
 * This drills into common error shapes before falling back to JSON.stringify.
 */
function formatOauthError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if (typeof e.message === 'string' && e.message) return e.message;
    if (typeof e.error === 'string' && e.error) return e.error;
    if (e.error && typeof e.error === 'object') {
      const inner = e.error as Record<string, unknown>;
      if (typeof inner.message === 'string' && inner.message) return inner.message;
    }
    if (typeof e.name === 'string' && typeof e.code === 'string') {
      return `${e.name}: ${e.code}`;
    }
    try {
      const json = JSON.stringify(err);
      if (json && json !== '{}') return json;
    } catch { /* fall through */ }
  }
  return typeof err === 'string' ? err : 'Something went wrong. Please try again.';
}

/** Get an icon for the auth method based on its label/type */
function methodIcon(method: { type: string; label: string }) {
  const label = method.label.toLowerCase();
  if (
    method.type === 'api' ||
    label.includes('api key') ||
    label.includes('manually')
  )
    return Key;
  if (label.includes('pro') || label.includes('max') || label.includes('plus'))
    return Globe;
  if (label.includes('create')) return Plus;
  return Globe;
}

/** Get a short description for the auth method */
function methodDescription(method: { type: string; label: string }) {
  const label = method.label.toLowerCase();
  if (label.includes('pro') && label.includes('max'))
    return 'Use your Claude Pro or Max subscription';
  if (label.includes('pro') && label.includes('plus'))
    return 'Use your ChatGPT Pro or Plus subscription';
  if (label.includes('create') && label.includes('api'))
    return 'Automatically create and connect an API key';
  if (method.type === 'api') return 'Manually enter an existing API key';
  if (label.includes('copilot') || label.includes('github'))
    return 'Login with your GitHub account';
  return undefined;
}

// =============================================================================
// ConnectProviderContent
// =============================================================================

export function ConnectProviderContent({
  providers,
  onClose,
  onProviderConnected,
}: {
  providers: ProviderListResponse | undefined;
  onClose?: () => void;
  onProviderConnected?: () => void;
}) {
  const queryClient = useQueryClient();
  const connectedIds = useMemo(
    () => new Set(providers?.connected ?? []),
    [providers],
  );

  // --- Navigation state ---
  type View =
    | { type: 'list' }
    | { type: 'custom' }
    | { type: 'connect'; providerID: string };

  const [view, setView] = useState<View>({ type: 'list' });
  const [search, setSearch] = useState('');
  const [otherOpen, setOtherOpen] = useState(false);

  // --- Connect flow state ---
  const [authMethods, setAuthMethods] = useState<
    Array<{ type: string; label: string }>
  >([]);
  const [methodIndex, setMethodIndex] = useState<number | undefined>(undefined);
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [oauthState, setOauthState] = useState<
    'idle' | 'pending' | 'complete' | 'error'
  >('idle');
  const [oauthUrl, setOauthUrl] = useState('');
  const [oauthMethod, setOauthMethod] = useState<'code' | 'auto' | undefined>(
    undefined,
  );
  const [oauthCode, setOauthCode] = useState('');
  const [oauthInstructions, setOauthInstructions] = useState('');

  // --- Custom provider state ---
  const [customForm, setCustomForm] = useState({
    providerID: '',
    name: '',
    baseURL: '',
    apiKey: '',
    modelId: '',
    modelName: '',
  });

  const allProviders = useMemo(() => {
    const listedProviders = providers?.all || [];
    const seenIds = new Set(listedProviders.map((provider) => provider.id));
    const fallbackProviders = FALLBACK_PROVIDER_CARDS.filter(
      (provider) => !seenIds.has(provider.id),
    );
    return [...fallbackProviders, ...listedProviders];
  }, [providers]);

  const filteredProviders = useMemo(() => {
    const q = search.toLowerCase();
    return allProviders
      .filter(
        (p) =>
          !q ||
          (p.id || '').toLowerCase().includes(q) ||
          (p.name || '').toLowerCase().includes(q),
      )
      .sort((a, b) => {
        const ai = POPULAR_PROVIDER_IDS.indexOf(a.id);
        const bi = POPULAR_PROVIDER_IDS.indexOf(b.id);
        if (ai >= 0 && bi < 0) return -1;
        if (ai < 0 && bi >= 0) return 1;
        if (ai >= 0 && bi >= 0) return ai - bi;
        return a.name.localeCompare(b.name);
      });
  }, [allProviders, search]);

  const popularGroup = useMemo(
    () => filteredProviders.filter((p) => POPULAR_PROVIDER_IDS.includes(p.id)),
    [filteredProviders],
  );
  const otherGroup = useMemo(
    () => filteredProviders.filter((p) => !POPULAR_PROVIDER_IDS.includes(p.id)),
    [filteredProviders],
  );

  useEffect(() => {
    if (search.trim()) {
      setOtherOpen(otherGroup.length > 0);
    }
  }, [search, otherGroup.length]);

  const selectedProviderData = useMemo(
    () =>
      view.type === 'connect'
        ? allProviders.find((p) => p.id === view.providerID)
        : undefined,
    [view, allProviders],
  );

  // Reset all connect state
  const resetConnect = useCallback(() => {
    setAuthMethods([]);
    setMethodIndex(undefined);
    setApiKey('');
    setError('');
    setSaving(false);
    setOauthState('idle');
    setOauthUrl('');
    setOauthMethod(undefined);
    setOauthCode('');
    setOauthInstructions('');
  }, []);

  // --- Complete connection (shared by API key + OAuth) ---
  const completeConnection = useCallback(
    async (providerID: string) => {
      try {
        const client = getClient();
        await client.global.dispose();
      } catch {
        /* ignore */
      }
      queryClient.invalidateQueries({ queryKey: opencodeKeys.providers() });
      onProviderConnected?.();
      const label = PROVIDER_LABELS[providerID] || providerID;
      toast.success(`${label} connected`, {
        description: 'API key saved successfully.',
      });
      setView({ type: 'list' });
      setSearch('');
      setOtherOpen(false);
      resetConnect();
      setCustomForm({
        providerID: '',
        name: '',
        baseURL: '',
        apiKey: '',
        modelId: '',
        modelName: '',
      });
      onClose?.();
    },
    [queryClient, onClose, onProviderConnected, resetConnect],
  );

  // --- Select auth method ---
  const selectMethod = useCallback(
    async (
      providerID: string,
      methods: Array<{ type: string; label: string }>,
      index: number,
    ) => {
      setMethodIndex(index);
      setError('');
      const method = methods[index];

      if (method.type === 'oauth') {
        setOauthState('pending');
        try {
          const client = getClient();
          const result = await client.provider.oauth.authorize({
            providerID,
            method: index,
          });
          if (result.error) throw result.error;
          const data = result.data!;
          setOauthUrl(data.url);

          if (data.method === 'code') {
            setOauthMethod('code');
            setOauthState('complete');
            window.open(data.url, '_blank', 'noopener,noreferrer');
          } else if (data.method === 'auto') {
            setOauthMethod('auto');
            setOauthInstructions(data.instructions || '');
            setOauthState('complete');
          }
        } catch (err) {
          setOauthState('error');
          setError(formatOauthError(err));
        }
      }
    },
    [],
  );

  // --- Select a provider from the list ---
  const handleSelectProvider = useCallback(
    async (providerID: string) => {
      resetConnect();
      setView({ type: 'connect', providerID });

      try {
        const client = getClient();
        const result = await client.provider.auth();
        const methods = (
          result.data as Record<string, Array<{ type: string; label: string }>>
        )?.[providerID];
        if (methods && methods.length > 0) {
          setAuthMethods(methods);
          if (methods.length === 1) {
            selectMethod(providerID, methods, 0);
          }
        } else {
          setAuthMethods([{ type: 'api', label: 'API Key' }]);
          setMethodIndex(0);
        }
      } catch {
        setAuthMethods([{ type: 'api', label: 'API Key' }]);
        setMethodIndex(0);
      }
    },
    [resetConnect, selectMethod],
  );

  // --- Submit API key ---
  const handleApiKeySubmit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      if (view.type !== 'connect') return;
      if (!apiKey.trim()) {
        setError('API key is required');
        return;
      }
      setSaving(true);
      setError('');
      try {
        const client = getClient();
        await client.auth.set({
          providerID: view.providerID,
          auth: { type: 'api', key: apiKey.trim() },
        });
        await completeConnection(view.providerID);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    },
    [view, apiKey, completeConnection],
  );

  // --- Submit OAuth code ---
  const handleOAuthCodeSubmit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      if (view.type !== 'connect') return;
      if (!oauthCode.trim()) {
        setError('Authorization code is required');
        return;
      }
      setSaving(true);
      setError('');
      try {
        const client = getClient();
        const result = await client.provider.oauth.callback({
          providerID: view.providerID,
          method: methodIndex,
          code: oauthCode,
        });
        if (result.error) throw result.error;
        await completeConnection(view.providerID);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    },
    [view, oauthCode, methodIndex, completeConnection],
  );

  // --- Auto-callback for 'auto' OAuth methods (OpenAI browser/headless) ---
  // When method is 'auto', open the auth URL in a new tab, then call the callback
  // endpoint (no code) — the backend blocks until auth completes.
  useEffect(() => {
    if (
      view.type !== 'connect' ||
      oauthMethod !== 'auto' ||
      oauthState !== 'complete'
    )
      return;
    let cancelled = false;

    // Open auth URL automatically
    if (oauthUrl) {
      window.open(oauthUrl, '_blank', 'noopener,noreferrer');
    }

    (async () => {
      try {
        const client = getClient();
        const result = await client.provider.oauth.callback({
          providerID: view.providerID,
          method: methodIndex,
        });
        if (cancelled) return;
        if (result.error) throw result.error;
        await completeConnection(view.providerID);
      } catch (err) {
        if (cancelled) return;
        setOauthState('error');
        setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, oauthMethod, oauthState]);

  // --- Submit custom provider ---
  const handleCustomSubmit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      const validationError = validateCustomProviderForm(customForm);
      if (validationError) {
        setError(validationError);
        return;
      }

      setSaving(true);
      setError('');
      try {
        const normalizedForm = normalizeCustomProviderForm(customForm);
        const client = getClient();
        const currentConfig = unwrapResult(await client.global.config.get());
        const configUpdate = buildCustomProviderConfigUpdate(
          currentConfig,
          normalizedForm,
        );

        unwrapResult(
          await client.global.config.update({ config: configUpdate } as any),
        );

        if (normalizedForm.apiKey && !isEnvReference(normalizedForm.apiKey)) {
          unwrapResult(
            await client.auth.set({
              providerID: normalizedForm.providerID,
              auth: { type: 'api', key: normalizedForm.apiKey },
            }),
          );
        }

        await client.global.dispose();
        queryClient.invalidateQueries({ queryKey: configKeys.all });
        queryClient.invalidateQueries({ queryKey: opencodeKeys.providers() });
        onProviderConnected?.();
        const label = normalizedForm.name || normalizedForm.providerID;
        toast.success(`${label} connected`, {
          description: 'Custom provider added successfully.',
        });
        setView({ type: 'list' });
        setSearch('');
        resetConnect();
        setCustomForm({
          providerID: '',
          name: '',
          baseURL: '',
          apiKey: '',
          modelId: '',
          modelName: '',
        });
        onClose?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    },
    [customForm, queryClient, onClose, onProviderConnected, resetConnect],
  );

  // --- Back navigation ---
  const handleBack = useCallback(() => {
    if (view.type === 'connect') {
      if (authMethods.length > 1 && methodIndex !== undefined) {
        setMethodIndex(undefined);
        setError('');
        setOauthState('idle');
        return;
      }
      resetConnect();
      setView({ type: 'list' });
      setOtherOpen(false);
      return;
    }
    if (view.type === 'custom') {
      setError('');
      setView({ type: 'list' });
      setOtherOpen(false);
      return;
    }
  }, [view, authMethods, methodIndex, resetConnect]);

  // Determine what to show in connect view
  const currentMethod =
    methodIndex !== undefined ? authMethods[methodIndex] : undefined;
  const showMethodSelect =
    view.type === 'connect' &&
    authMethods.length > 1 &&
    methodIndex === undefined;
  const showApiKeyForm =
    view.type === 'connect' && currentMethod?.type === 'api';
  const showOAuthCode =
    view.type === 'connect' &&
    currentMethod?.type === 'oauth' &&
    oauthMethod === 'code' &&
    oauthState === 'complete';
  const showOAuthAuto =
    view.type === 'connect' &&
    currentMethod?.type === 'oauth' &&
    oauthMethod === 'auto' &&
    oauthState === 'complete';
  const showOAuthPending =
    view.type === 'connect' &&
    currentMethod?.type === 'oauth' &&
    oauthState === 'pending';
  const showOAuthError = view.type === 'connect' && oauthState === 'error';

  // Dynamic title: upstream shows "Login with Claude Pro/Max" when that method is selected
  const connectTitle = (() => {
    if (view.type !== 'connect') return '';
    if (
      currentMethod?.label?.toLowerCase().includes('max') &&
      view.providerID === 'anthropic'
    ) {
      return 'Login with Claude Pro/Max';
    }
    if (
      currentMethod?.label?.toLowerCase().includes('plus') &&
      view.providerID === 'openai'
    ) {
      return 'Login with ChatGPT Pro/Plus';
    }
    return `Connect ${PROVIDER_LABELS[view.providerID] || selectedProviderData?.name || view.providerID}`;
  })();

  const customMatchesSearch = !search || 'custom provider'.includes(search.toLowerCase());

  return (
    <div className={cn(view.type === 'list' ? 'pb-4' : 'px-5 py-4')}>
      {/* Header — only for connect/custom flows. The list view uses the modal's
          DialogTitle + tab bar, so an inline header would be a third hat. */}
      {view.type !== 'list' && (
        <div className="flex items-center gap-2 pb-3">
          <Button
            type="button"
            onClick={handleBack}
            variant="ghost"
            size="icon-sm"
            className="-ml-1.5"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h3 className="flex-1 text-sm font-medium text-foreground">
            {view.type === 'custom' && 'Add Custom Provider'}
            {view.type === 'connect' && connectTitle}
          </h3>
        </div>
      )}

      {/* Selected provider summary for connect view */}
      {view.type === 'connect' && selectedProviderData && (
        <div className="mb-5 flex items-center gap-3 rounded-xl border border-border/50 bg-muted/20 px-4 py-3.5">
          <ProviderLogo
            providerID={selectedProviderData.id}
            name={selectedProviderData.name}
            size="large"
          />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-foreground">
              {PROVIDER_LABELS[selectedProviderData.id] ||
                selectedProviderData.name}
            </div>
            {PROVIDER_NOTES[selectedProviderData.id] && (
              <p className="text-xs text-muted-foreground mt-0.5">
                {PROVIDER_NOTES[selectedProviderData.id]}
              </p>
            )}
          </div>
        </div>
      )}

      {/* ============ PROVIDER LIST ============ */}
      {view.type === 'list' && (
        <div className="flex flex-col">
          {/* Search — flush, with bottom border, matches CommandInput compact */}
          <div className="relative flex h-11 items-center gap-2.5 border-b border-border/40 px-4">
            <Search className="size-4 shrink-0 text-muted-foreground/60" />
            <Input
              type="text"
              placeholder="Search providers..."
              autoComplete="off"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-11 flex-1 rounded-none border-0 bg-transparent px-0 text-[13px] shadow-none placeholder:text-muted-foreground/50 focus-visible:ring-0 focus-visible:ring-offset-0"
              autoFocus
            />
          </div>

          {/* Provider list */}
          <div className="px-3 pt-2">
            {/* Popular providers */}
            {popularGroup.length > 0 && (
              <div className="space-y-1">
                <GroupHeading>Popular</GroupHeading>
                {popularGroup.map((p) => (
                  <ProviderCard
                    key={p.id}
                    providerID={p.id}
                    name={PROVIDER_LABELS[p.id] || p.name}
                    description={PROVIDER_NOTES[p.id]}
                    connected={connectedIds.has(p.id)}
                    onClick={() => handleSelectProvider(p.id)}
                  />
                ))}
              </div>
            )}

            {/* Other providers */}
            {otherGroup.length > 0 && (
              <Accordion
                type="single"
                collapsible
                value={otherOpen ? 'other' : undefined}
                onValueChange={(value) => setOtherOpen(value === 'other')}
                className="mt-3"
              >
                <AccordionItem value="other" className="border-none">
                  <AccordionTrigger className="rounded-xl px-1 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-foreground/40 hover:no-underline hover:text-foreground/60 [&>svg]:hidden">
                    <span className="flex w-full items-center justify-between gap-2">
                      <span>Other ({otherGroup.length})</span>
                      <ChevronDown
                        className={cn(
                          'h-3 w-3 text-muted-foreground/50 transition-transform duration-200',
                          otherOpen && 'rotate-180',
                        )}
                      />
                    </span>
                  </AccordionTrigger>
                  <AccordionContent className="pt-1 pb-0">
                    <div className="space-y-1">
                      {otherGroup.map((p) => (
                        <ProviderCard
                          key={p.id}
                          providerID={p.id}
                          name={PROVIDER_LABELS[p.id] || p.name}
                          connected={connectedIds.has(p.id)}
                          onClick={() => handleSelectProvider(p.id)}
                        />
                      ))}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            )}

            {/* Custom — its own group at the bottom so structure mirrors above */}
            {customMatchesSearch && (
              <div className="mt-3 space-y-1">
                <GroupHeading>Custom</GroupHeading>
                <ProviderCard
                  providerID="custom"
                  name="Custom Provider"
                  description="Add any OpenAI-compatible endpoint"
                  onClick={() => setView({ type: 'custom' })}
                />
              </div>
            )}

            {filteredProviders.length === 0 && !customMatchesSearch && (
              <div className="py-8 text-center text-sm text-muted-foreground/60">
                No providers found
              </div>
            )}
          </div>
        </div>
      )}

      {/* ============ CUSTOM PROVIDER FORM ============ */}
      {view.type === 'custom' && (
        <form onSubmit={handleCustomSubmit} className="space-y-4">
          <p className="text-sm text-muted-foreground/70">
            Add an OpenAI-compatible provider.{' '}
            <a
              href="https://opencode.ai/docs/providers/#custom-provider"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline inline-flex items-center gap-0.5"
            >
              Learn more <ExternalLink className="h-3 w-3" />
            </a>
          </p>
          <div className="space-y-4 rounded-xl border border-border/50 bg-muted/20 p-4">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                Provider ID
              </label>
              <Input
                type="text"
                placeholder="my-provider"
                value={customForm.providerID}
                onChange={(e) =>
                  setCustomForm((f) => ({ ...f, providerID: e.target.value }))
                }
                className="h-9 rounded-xl border-border/50 bg-background text-sm"
                autoFocus
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                Display Name
              </label>
              <Input
                type="text"
                placeholder="My Provider"
                value={customForm.name}
                onChange={(e) =>
                  setCustomForm((f) => ({ ...f, name: e.target.value }))
                }
                className="h-9 rounded-xl border-border/50 bg-background text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                Base URL
              </label>
              <Input
                type="text"
                placeholder="https://api.example.com/v1"
                value={customForm.baseURL}
                onChange={(e) =>
                  setCustomForm((f) => ({ ...f, baseURL: e.target.value }))
                }
                className="h-9 rounded-xl border-border/50 bg-background text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                API Key{' '}
                <span className="font-normal text-muted-foreground/50">
                  (optional)
                </span>
              </label>
              <Input
                placeholder="sk-..."
                type="password"
                value={customForm.apiKey}
                onChange={(e) =>
                  setCustomForm((f) => ({ ...f, apiKey: e.target.value }))
                }
                className="h-9 rounded-xl border-border/50 bg-background text-sm"
              />
              <p className="text-[11px] text-muted-foreground/50 mt-1.5">
                Use {'{env:VAR_NAME}'} to read from environment
              </p>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                Model
              </label>
              <div className="flex gap-2">
                <Input
                  type="text"
                  placeholder="Model ID"
                  value={customForm.modelId}
                  onChange={(e) =>
                    setCustomForm((f) => ({ ...f, modelId: e.target.value }))
                  }
                  className="h-9 flex-1 rounded-xl border-border/50 bg-background text-sm"
                />
                <Input
                  type="text"
                  placeholder="Display Name"
                  value={customForm.modelName}
                  onChange={(e) =>
                    setCustomForm((f) => ({ ...f, modelName: e.target.value }))
                  }
                  className="h-9 flex-1 rounded-xl border-border/50 bg-background text-sm"
                />
              </div>
            </div>
          </div>
          {error && (
            <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/5 rounded-lg px-3 py-2">
              <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
          <Button type="submit" disabled={saving} size="sm" className="px-4">
            {saving ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                Connecting...
              </>
            ) : (
              'Connect'
            )}
          </Button>
        </form>
      )}

      {/* ============ CONNECT FLOW ============ */}
      {view.type === 'connect' && (
        <div className="space-y-4">
          {showMethodSelect && (
            <>
              <p className="text-sm text-muted-foreground">
                Select login method for{' '}
                {PROVIDER_LABELS[view.providerID] ||
                  selectedProviderData?.name ||
                  view.providerID}
                .
              </p>
              <div className="rounded-xl border border-border/50 bg-muted/20 p-2 space-y-0.5">
                {authMethods.map((method, i) => {
                  const Icon = methodIcon(method);
                  const desc = methodDescription(method);
                  return (
                    <Button
                      key={i}
                      type="button"
                      onClick={() =>
                        selectMethod(view.providerID, authMethods, i)
                      }
                      variant="ghost"
                      className="group h-auto w-full items-center gap-3 rounded-xl px-3 py-3 text-left hover:bg-background/70 justify-start"
                    >
                      <span className="flex items-center justify-center size-8 rounded-lg bg-muted/50 text-muted-foreground group-hover:text-foreground transition-colors shrink-0">
                        <Icon className="h-4 w-4" />
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="text-sm font-medium block">
                          {methodLabel(method)}
                        </span>
                        {desc && (
                          <span className="text-xs text-muted-foreground/70 block mt-0.5">
                            {desc}
                          </span>
                        )}
                      </span>
                      <ChevronRight className="h-4 w-4 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors shrink-0 ml-auto" />
                    </Button>
                  );
                })}
              </div>
            </>
          )}

          {showApiKeyForm && (
            <form
              onSubmit={handleApiKeySubmit}
              className="space-y-4 rounded-xl border border-border/50 bg-muted/20 p-4"
            >
              <p className="text-sm text-muted-foreground">
                Enter your {selectedProviderData?.name || view.providerID} API
                key.
              </p>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                  API Key
                </label>
                <Input
                  placeholder="Enter API key..."
                  type="text"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="h-9 rounded-xl border-border/50 bg-background text-sm"
                  autoFocus
                />
              </div>
              {error && (
                <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/5 rounded-lg px-3 py-2">
                  <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}
              <Button
                type="submit"
                disabled={saving}
                size="sm"
                className="px-4 "
              >
                {saving ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                    Connecting...
                  </>
                ) : (
                  'Connect'
                )}
              </Button>
            </form>
          )}

          {showOAuthPending && (
            <div className="flex items-center gap-2.5 py-6 justify-center">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                Starting authorization...
              </span>
            </div>
          )}

          {showOAuthCode && (
            <form
              onSubmit={handleOAuthCodeSubmit}
              className="space-y-4 rounded-xl border border-border/50 bg-muted/20 p-5"
            >
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-foreground">
                  Connect {selectedProviderData?.name || view.providerID}
                </h3>
                <div className="space-y-2 text-sm text-muted-foreground">
                  <div className="flex items-start gap-2">
                    <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center mt-0.5">
                      1
                    </span>
                    <span>
                      Click the button below to open the authorization page
                    </span>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center mt-0.5">
                      2
                    </span>
                    <span>Sign in and authorize access</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center mt-0.5">
                      3
                    </span>
                    <span>
                      After redirect, copy the full URL from your browser&apos;s
                      address bar (starts with{' '}
                      <code className="text-xs bg-muted px-1 py-0.5 rounded">
                        http://localhost...
                      </code>
                      )
                    </span>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center mt-0.5">
                      4
                    </span>
                    <span>Paste it below and click Connect</span>
                  </div>
                </div>
              </div>

              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full h-10 gap-2"
                onClick={() =>
                  window.open(oauthUrl, '_blank', 'noopener,noreferrer')
                }
              >
                <ExternalLink className="h-4 w-4" />
                Open Authorization Page
              </Button>

              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                  Paste the redirect URL here
                </label>
                <Input
                  placeholder="http://localhost:.../callback?code=..."
                  type="text"
                  value={oauthCode}
                  onChange={(e) => setOauthCode(e.target.value)}
                  className="h-9 rounded-xl border-border/50 bg-background text-sm"
                  autoFocus
                />
              </div>
              {error && (
                <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/5 rounded-lg px-3 py-2">
                  <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}
              <Button
                type="submit"
                disabled={saving || !oauthCode.trim()}
                size="sm"
                className="w-full "
              >
                {saving ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                    Connecting...
                  </>
                ) : (
                  'Connect'
                )}
              </Button>
            </form>
          )}

          {showOAuthAuto && (
            <div className="space-y-4 rounded-xl border border-border/50 bg-muted/20 p-5">
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  A browser tab should have opened automatically. Complete the
                  authorization there, then return here.
                </p>
              </div>
              {oauthInstructions && (
                <div className="px-3 py-2.5 rounded-lg bg-background border border-border/30 font-mono text-sm select-all break-all text-center font-semibold tracking-widest">
                  {oauthInstructions.includes(':')
                    ? oauthInstructions.split(':')[1]?.trim()
                    : oauthInstructions}
                </div>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full h-10 gap-2"
                onClick={() =>
                  window.open(oauthUrl, '_blank', 'noopener,noreferrer')
                }
              >
                <ExternalLink className="h-4 w-4" />
                Open Authorization Page
              </Button>
              <div className="flex items-center gap-2.5 text-sm text-muted-foreground justify-center">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>Waiting for authorization...</span>
              </div>
            </div>
          )}

          {showOAuthError && (
            <div className="space-y-3">
              <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/5 rounded-lg px-4 py-3">
                <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                <span>{error || 'Authorization failed'}</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                className=""
                onClick={() => {
                  setOauthState('idle');
                  setMethodIndex(undefined);
                  setError('');
                }}
              >
                Try again
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
