'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { EmptyState } from '@/features/layout/section/empty-state';
import { PROVIDER_LABELS, ProviderLogo } from '@/features/providers/provider-branding';
import { LLM_PROVIDERS, LLM_PROVIDER_BY_ID } from '@/lib/llm-providers';
import type { HarnessAuthKind, HarnessId } from '@kortix/sdk/projects-client';
import { type ModelsPageConnection, type ModelsPageRuntime, harnessLabel } from '@kortix/sdk/react';
import {
  type AuthFlow,
  type AuthProviderPublic,
  accountDoorProviders,
  findAuthProviderPublic,
} from '@kortix/shared/auth-providers';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';

import { CONNECTION_STATUS, type StatusBadge, connectionStatusBadge } from './connection-status';
import { ApiKeyForm } from './forms/api-key-form';
import { ClaudeSubscriptionForm } from './forms/claude-subscription-form';
import { CustomEndpointForm } from './forms/custom-endpoint-form';
import { DeviceCodeForm } from './forms/device-code-form';
import { METHOD_COMPATIBLE_HARNESSES } from './harness-method-compat';

type ConnectMethod =
  | { kind: 'claude_subscription' }
  | { kind: 'codex_subscription' }
  | { kind: 'anthropic_api_key' }
  | { kind: 'openai_api_key' }
  | { kind: 'other_provider'; providerId: string }
  | { kind: 'openai_compatible' }
  | { kind: 'anthropic_compatible' };

const ROW =
  'group bg-popover hover:bg-secondary focus-visible:ring-ring/50 flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-md border px-4 py-2.5 text-left transition-[color,background-color,transform] focus-visible:ring-2 focus-visible:outline-none active:scale-[0.96]';

const OTHER_PROVIDER_IDS = new Set(
  LLM_PROVIDERS.filter(
    (provider) =>
      !['claude-subscription', 'codex', 'anthropic', 'openai', 'kortix'].includes(provider.id),
  ).map((provider) => provider.id),
);
const OTHER_PROVIDERS = LLM_PROVIDERS.filter((provider) => OTHER_PROVIDER_IDS.has(provider.id));

function joinAnd(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/** The honest "works with <harnesses>" fan-out (spec §9.1) — derived from the
 *  same descriptor the server routes on, never hand-listed. */
function worksWithHarnesses(kind: HarnessAuthKind): HarnessId[] {
  return METHOD_COMPATIBLE_HARNESSES[kind];
}

function worksWithLabel(kind: HarnessAuthKind): string | null {
  const harnesses = worksWithHarnesses(kind);
  if (harnesses.length === 0) return null;
  return `Works with ${joinAnd(harnesses.map(harnessLabel))}`;
}

/** How the web surface completes this door row, phrased for someone who has
 *  never seen it before. Browserless-honest: a paste or a link+code, never a
 *  localhost redirect (spec §6.5/§9.2-9.3). */
function flowPhrase(flow: AuthFlow | undefined): string {
  switch (flow) {
    case 'paste-token':
      return 'Paste a setup token';
    case 'device-code':
      return 'Sign in with a device code';
    case 'browser-oauth':
      return 'Sign in with your browser';
    case 'paste-api-key':
      return 'Paste an API key';
    default:
      return 'Connect';
  }
}

/** Account-door subtitle: the flow method, plus the fan-out only when it adds
 *  information the title doesn't already carry (a Claude-Code row saying "works
 *  with Claude Code" is noise; a ChatGPT/Codex row saying "works with Codex"
 *  is not). */
function accountSubtitle(provider: AuthProviderPublic): string {
  const phrase = flowPhrase(provider.flows.web[0]);
  const harnesses = worksWithHarnesses(provider.producesAuthKind);
  const labels = harnesses.map(harnessLabel);
  const redundant = labels.length === 1 && labels[0] === provider.label;
  if (harnesses.length === 0 || redundant) return phrase;
  return `${phrase} · works with ${joinAnd(labels)}`;
}

type RowHealth = StatusBadge | null;

function healthFor(connection: ModelsPageConnection | null): RowHealth {
  // Shared vocabulary — a row here reads the SAME word the Models page shows
  // for the same connection (see ./connection-status).
  return connection ? connectionStatusBadge(connection.status) : null;
}

function connectionFor(connections: ModelsPageConnection[], kind: HarnessAuthKind) {
  return connections.find((connection) => connection.id === kind) ?? null;
}

/** When a connection needs attention, the row's subtitle IS the next action
 *  (spec §9.5) — the honest reason replaces the generic method blurb; a
 *  healthy or absent connection keeps the descriptive fallback. */
function rowHint(connection: ModelsPageConnection | null, fallback: string): string {
  if (connection?.status === 'needs-attention') {
    return `Needs attention · ${connection.statusReason ?? 'Reconnect to continue'}`;
  }
  if (connection?.status === 'unavailable') {
    return connection.statusReason ?? 'Currently unavailable';
  }
  return fallback;
}

function methodForKind(kind: HarnessAuthKind): ConnectMethod | null {
  switch (kind) {
    case 'claude_subscription':
    case 'codex_subscription':
    case 'anthropic_api_key':
    case 'openai_api_key':
    case 'openai_compatible':
    case 'anthropic_compatible':
      return { kind };
    default:
      return null;
  }
}

/** A method is offered whenever at least one harness can use it. A kind
 *  compatible with no harness at all (e.g. the parked anthropic_compatible
 *  endpoint) is never shown. This is the ONLY gate on a row's presence — the
 *  modal never hides a door or a row to "scope" itself to one harness (see
 *  `harnessFilter`, which only emphasizes, never subtracts). */
function isOfferable(kind: HarnessAuthKind): boolean {
  return METHOD_COMPATIBLE_HARNESSES[kind].length > 0;
}

export function ConnectModelModal({
  projectId,
  open,
  onOpenChange,
  runtimes,
  connections,
  connectedProviderIds = [],
  harnessFilter = null,
  initialKind = null,
  initialProviderId = null,
  onConnected,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  runtimes: ModelsPageRuntime[];
  connections: ModelsPageConnection[];
  /** Gateway provider ids whose secrets are already satisfied — the only
   *  "connected" signal a raw-key catalog provider (no HarnessAuthKind) has. */
  connectedProviderIds?: readonly string[];
  /** The harness a caller is connecting *for* (the per-runtime "Connect" in
   *  `models-view.tsx`). This ONLY emphasizes the rows that harness can use —
   *  it never hides a door or a row. There is exactly one connect modal and it
   *  always shows both doors, everywhere it opens. */
  harnessFilter?: HarnessId | null;
  /** Pre-selects a form (used by "Reconnect"/"Replace key" from the manage
   *  modal) instead of landing on the two doors. */
  initialKind?: HarnessAuthKind | null;
  /** Pre-selects a specific "other provider" row (ignored when `initialKind`
   *  is also set — a specific method always wins over a provider guess). */
  initialProviderId?: string | null;
  /** @deprecated Retained only for source-compat with call sites that still
   *  pass it (e.g. `model-selector.tsx`). It no longer narrows the modal — both
   *  doors always render, everywhere. Delete once no caller passes it. */
  tab?: 'subscriptions' | 'api-keys' | null;
  onConnected?: () => void;
}) {
  const [method, setMethod] = useState<ConnectMethod | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (open) {
      setMethod(
        initialKind
          ? methodForKind(initialKind)
          : initialProviderId
            ? { kind: 'other_provider', providerId: initialProviderId }
            : null,
      );
      setSearch('');
    }
  }, [open, initialKind, initialProviderId]);

  const handleConnected = () => {
    onConnected?.();
    onOpenChange(false);
  };

  const query = search.trim().toLowerCase();
  const matchesSearch = (haystack: string) => !query || haystack.toLowerCase().includes(query);

  const filteredOtherProviders = useMemo(
    () =>
      query
        ? OTHER_PROVIDERS.filter(
            (provider) =>
              provider.label.toLowerCase().includes(query) ||
              provider.id.toLowerCase().includes(query),
          )
        : OTHER_PROVIDERS,
    [query],
  );

  // Door 1 — "Sign in with an account": built entirely from the shared
  // registry's `door === 'account'` rows (spec §8.3/§9.1). Copilot/xAI are
  // deliberately absent from the registry (Phase 2, §7/§11#4) — so they simply
  // don't appear here. Every offerable row is ALWAYS shown; `harnessFilter`
  // only emphasizes, never subtracts.
  const accountRows = accountDoorProviders().filter((provider) =>
    isOfferable(provider.producesAuthKind),
  );

  const showAnthropicKey = isOfferable('anthropic_api_key');
  const showOpenaiKey = isOfferable('openai_api_key');
  const showOtherProviders = true;
  const showOpenaiCompatible = isOfferable('openai_compatible');
  const showApiKeyDoor =
    showAnthropicKey || showOpenaiKey || showOtherProviders || showOpenaiCompatible;
  // Anthropic-compatible custom endpoints are parked (2026-07-15): no harness
  // is compatible with this kind, so it is never offered — see
  // METHOD_COMPATIBLE_HARNESSES.anthropic_compatible in ./harness-method-compat.

  const isConnectedProvider = (providerId: string) => connectedProviderIds.includes(providerId);

  // `harnessFilter` emphasis: a row is "recommended" when the harness the
  // caller is connecting *for* can actually use that method. Rows never
  // disappear — the highlight replaces the old scope-by-hiding behavior.
  const recommendsKind = (kind: HarnessAuthKind) =>
    harnessFilter != null && METHOD_COMPATIBLE_HARNESSES[kind].includes(harnessFilter);

  const anthropicMatches = showAnthropicKey && matchesSearch('anthropic claude api key');
  const openaiMatches = showOpenaiKey && matchesSearch('openai gpt api key');
  const customMatches =
    showOpenaiCompatible && matchesSearch('custom openai-compatible endpoint local vllm ollama');
  const anyApiKeyMatch =
    anthropicMatches || openaiMatches || customMatches || filteredOtherProviders.length > 0;

  let body: ReactNode;
  if (!method) {
    body = (
      <div className="space-y-8">
        {accountRows.length > 0 && (
          <section className="space-y-3">
            <DoorHeader
              title="Sign in with an account"
              description="Use your existing Claude or ChatGPT plan — no API key needed."
            />
            <ul className="space-y-2">
              {accountRows.map((provider) => {
                const conn = connectionFor(connections, provider.producesAuthKind);
                return (
                  <li key={provider.id}>
                    <MethodRow
                      providerID={provider.id}
                      label={provider.label}
                      hint={rowHint(conn, accountSubtitle(provider))}
                      health={healthFor(conn)}
                      recommended={recommendsKind(provider.producesAuthKind)}
                      onClick={() => {
                        const next = methodForKind(provider.producesAuthKind);
                        if (next) setMethod(next);
                      }}
                    />
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {showApiKeyDoor && (
          <section className="space-y-3">
            <DoorHeader
              title="Use an API key"
              description="Bring your own key from any provider."
            />
            <InputGroupSearch>
              <InputGroupSearchIcon>
                <Search />
              </InputGroupSearchIcon>
              <InputGroupSearchInput
                type="text"
                placeholder="Search providers…"
                autoComplete="off"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <InputGroupSearchClear onClick={() => setSearch('')} />
            </InputGroupSearch>
            {anyApiKeyMatch ? (
              <ul className="space-y-2">
                {anthropicMatches && (
                  <li>
                    <MethodRow
                      providerID="anthropic"
                      label="Anthropic"
                      hint={rowHint(
                        connectionFor(connections, 'anthropic_api_key'),
                        worksWithLabel('anthropic_api_key') ?? 'Claude via your own API key',
                      )}
                      health={healthFor(connectionFor(connections, 'anthropic_api_key'))}
                      recommended={recommendsKind('anthropic_api_key')}
                      onClick={() => setMethod({ kind: 'anthropic_api_key' })}
                    />
                  </li>
                )}
                {openaiMatches && (
                  <li>
                    <MethodRow
                      providerID="openai"
                      label="OpenAI"
                      hint={rowHint(
                        connectionFor(connections, 'openai_api_key'),
                        worksWithLabel('openai_api_key') ?? 'GPT models via your own API key',
                      )}
                      health={healthFor(connectionFor(connections, 'openai_api_key'))}
                      recommended={recommendsKind('openai_api_key')}
                      onClick={() => setMethod({ kind: 'openai_api_key' })}
                    />
                  </li>
                )}
                {showOtherProviders &&
                  filteredOtherProviders.map((provider) => (
                    <li key={provider.id}>
                      <MethodRow
                        providerID={provider.id}
                        label={PROVIDER_LABELS[provider.id] ?? provider.label}
                        hint={provider.hint}
                        health={
                          isConnectedProvider(provider.id) ? CONNECTION_STATUS.connected : null
                        }
                        onClick={() =>
                          setMethod({ kind: 'other_provider', providerId: provider.id })
                        }
                      />
                    </li>
                  ))}
                {customMatches && (
                  <li>
                    <MethodRow
                      providerID="custom"
                      label="OpenAI-compatible endpoint"
                      hint="Custom base URL — OpenCode and Pi"
                      health={healthFor(connectionFor(connections, 'openai_compatible'))}
                      recommended={recommendsKind('openai_compatible')}
                      onClick={() => setMethod({ kind: 'openai_compatible' })}
                    />
                  </li>
                )}
              </ul>
            ) : (
              <div className="text-muted-foreground rounded-md border border-dashed px-3 py-8 text-center text-xs">
                No providers match &ldquo;{search}&rdquo;
              </div>
            )}
          </section>
        )}

        {accountRows.length === 0 && !showApiKeyDoor && (
          <EmptyState size="sm" title="No compatible connection methods" />
        )}
      </div>
    );
  } else if (method.kind === 'claude_subscription') {
    body = (
      <ClaudeSubscriptionForm
        projectId={projectId}
        runtimes={runtimes}
        onConnected={handleConnected}
      />
    );
  } else if (method.kind === 'codex_subscription') {
    const provider = findAuthProviderPublic('openai', 'account');
    body = provider ? (
      <DeviceCodeForm
        projectId={projectId}
        provider={provider}
        runtimes={runtimes}
        onConnected={handleConnected}
      />
    ) : null;
  } else if (method.kind === 'anthropic_api_key') {
    const provider = LLM_PROVIDER_BY_ID.get('anthropic');
    body = provider ? (
      <ApiKeyForm
        projectId={projectId}
        provider={provider}
        connectionKind="anthropic_api_key"
        compatibleHarnesses={METHOD_COMPATIBLE_HARNESSES.anthropic_api_key}
        runtimes={runtimes}
        onConnected={handleConnected}
      />
    ) : null;
  } else if (method.kind === 'openai_api_key') {
    const provider = LLM_PROVIDER_BY_ID.get('openai');
    body = provider ? (
      <ApiKeyForm
        projectId={projectId}
        provider={provider}
        connectionKind="openai_api_key"
        compatibleHarnesses={METHOD_COMPATIBLE_HARNESSES.openai_api_key}
        runtimes={runtimes}
        onConnected={handleConnected}
      />
    ) : null;
  } else if (method.kind === 'other_provider') {
    const provider = LLM_PROVIDER_BY_ID.get(method.providerId);
    body = provider ? (
      <ApiKeyForm
        projectId={projectId}
        provider={provider}
        runtimes={runtimes}
        onConnected={handleConnected}
      />
    ) : null;
  } else {
    body = (
      <CustomEndpointForm
        projectId={projectId}
        runtimes={runtimes}
        initialProtocol={method.kind === 'openai_compatible' ? 'openai' : 'anthropic'}
        onDone={handleConnected}
      />
    );
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} depth={2}>
      <ModalContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden lg:max-w-3xl">
        <ModalHeader className="space-y-1 pb-4">
          <ModalTitle className="text-lg">Connect a model service</ModalTitle>
          <ModalDescription className="text-balance">
            Sign in with an account or paste an API key. We&apos;ll show which harnesses each one
            works with.
          </ModalDescription>
        </ModalHeader>
        <ModalBody className="min-h-0 flex-1 overflow-y-auto">
          {method && (
            <Button
              variant="outline-ghost"
              size="sm"
              className="-ml-1.5 gap-1 self-start"
              onClick={() => setMethod(null)}
            >
              <ChevronLeft className="size-4 shrink-0" />
              All connection methods
            </Button>
          )}
          {body}
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}

function DoorHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="space-y-0.5">
      <h3 className="text-foreground text-sm font-medium">{title}</h3>
      <p className="text-muted-foreground text-xs text-pretty">{description}</p>
    </div>
  );
}

function MethodRow({
  providerID,
  label,
  hint,
  health,
  recommended = false,
  onClick,
}: {
  providerID: string;
  label: string;
  hint: string;
  health: RowHealth;
  /** When set, the harness the caller is connecting for can use this method —
   *  a subtle "Recommended" badge highlights it without hiding anything else. */
  recommended?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={ROW} onClick={onClick}>
      <ProviderLogo providerID={providerID} name={label} size="large" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-foreground truncate text-sm font-medium">{label}</span>
          {health ? (
            <Badge variant={health.variant} size="sm">
              {health.label}
            </Badge>
          ) : recommended ? (
            <Badge variant="kortix" size="sm">
              Recommended
            </Badge>
          ) : null}
        </div>
        <p className="text-muted-foreground mt-0.5 truncate text-xs text-pretty">{hint}</p>
      </div>
      <ChevronRight className="text-muted-foreground/40 size-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}
