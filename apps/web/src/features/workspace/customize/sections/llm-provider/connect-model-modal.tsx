'use client';

import { Badge } from '@/components/ui/badge';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import { Modal, ModalBody, ModalContent, ModalDescription, ModalHeader, ModalTitle } from '@/components/ui/modal';
import { EmptyState } from '@/features/layout/section/empty-state';
import { PROVIDER_LABELS, ProviderLogo } from '@/features/providers/provider-branding';
import { LLM_PROVIDERS, LLM_PROVIDER_BY_ID } from '@/lib/llm-providers';
import type { HarnessAuthKind, HarnessId } from '@kortix/sdk/projects-client';
import type { ModelsPageConnection, ModelsPageRuntime } from '@kortix/sdk/react';
import { Plus, Search } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';

import { ApiKeyForm } from './forms/api-key-form';
import { ChatGptSubscriptionForm } from './forms/chatgpt-subscription-form';
import { ClaudeSubscriptionForm } from './forms/claude-subscription-form';
import { CustomEndpointForm } from './forms/custom-endpoint-form';

type ConnectMethod =
  | { kind: 'claude_subscription' }
  | { kind: 'codex_subscription' }
  | { kind: 'anthropic_api_key' }
  | { kind: 'openai_api_key' }
  | { kind: 'other_provider'; providerId: string }
  | { kind: 'openai_compatible' }
  | { kind: 'anthropic_compatible' };

const METHOD_COMPATIBLE_HARNESSES: Record<HarnessAuthKind, HarnessId[]> = {
  managed_gateway: ['claude', 'codex', 'opencode', 'pi'],
  claude_subscription: ['claude'],
  codex_subscription: ['codex'],
  anthropic_api_key: ['claude', 'opencode', 'pi'],
  openai_api_key: ['codex', 'opencode', 'pi'],
  openai_compatible: ['codex', 'opencode', 'pi'],
  anthropic_compatible: ['claude'],
  native_config: ['claude', 'codex', 'opencode', 'pi'],
};

const ROW =
  'group bg-popover hover:bg-muted/40 flex min-h-10 w-full items-center gap-3 rounded-md border px-4 py-2.5 text-left transition-[color,background-color,transform] active:scale-[0.96]';

const OTHER_PROVIDER_IDS = new Set(
  LLM_PROVIDERS.filter(
    (provider) => !['claude-subscription', 'codex', 'anthropic', 'openai', 'kortix'].includes(provider.id),
  ).map((provider) => provider.id),
);
const OTHER_PROVIDERS = LLM_PROVIDERS.filter((provider) => OTHER_PROVIDER_IDS.has(provider.id));

function connectionFor(connections: ModelsPageConnection[], kind: HarnessAuthKind) {
  return connections.find((connection) => connection.id === kind) ?? null;
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

function compatibleWithFilter(kind: HarnessAuthKind, harnessFilter: HarnessId | null): boolean {
  if (!harnessFilter) return true;
  return METHOD_COMPATIBLE_HARNESSES[kind].includes(harnessFilter);
}

export function ConnectModelModal({
  projectId,
  open,
  onOpenChange,
  runtimes,
  connections,
  harnessFilter = null,
  initialKind = null,
  onConnected,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  runtimes: ModelsPageRuntime[];
  connections: ModelsPageConnection[];
  harnessFilter?: HarnessId | null;
  /** Pre-selects a form (used by "Reconnect"/"Replace key" from the manage
   *  modal) instead of landing on the method list. */
  initialKind?: HarnessAuthKind | null;
  onConnected?: () => void;
}) {
  const [method, setMethod] = useState<ConnectMethod | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (open) {
      setMethod(initialKind ? methodForKind(initialKind) : null);
      setSearch('');
    }
  }, [open, initialKind]);

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
              provider.label.toLowerCase().includes(query) || provider.id.toLowerCase().includes(query),
          )
        : OTHER_PROVIDERS,
    [query],
  );

  const showSubscriptions =
    compatibleWithFilter('claude_subscription', harnessFilter) ||
    compatibleWithFilter('codex_subscription', harnessFilter);
  const showAnthropicKey = compatibleWithFilter('anthropic_api_key', harnessFilter);
  const showOpenaiKey = compatibleWithFilter('openai_api_key', harnessFilter);
  const showOtherProviders = !harnessFilter;
  const showOpenaiCompatible = compatibleWithFilter('openai_compatible', harnessFilter);
  const showAnthropicCompatible = compatibleWithFilter('anthropic_compatible', harnessFilter);

  let body: ReactNode;
  if (!method) {
    body = (
      <div className="space-y-6">
        {showSubscriptions && (
          <section className="space-y-2">
            <Label>Subscriptions</Label>
            <ul className="space-y-2">
              {compatibleWithFilter('claude_subscription', harnessFilter) && (
                <li>
                  <MethodRow
                    providerID="anthropic"
                    label="Claude Code"
                    hint="Claude Pro, Max, Team, or Enterprise"
                    connected={connectionFor(connections, 'claude_subscription')?.status === 'ready'}
                    onClick={() => setMethod({ kind: 'claude_subscription' })}
                  />
                </li>
              )}
              {compatibleWithFilter('codex_subscription', harnessFilter) && (
                <li>
                  <MethodRow
                    providerID="codex"
                    label="ChatGPT / Codex"
                    hint="ChatGPT Plus, Pro, Business, Edu, or Enterprise"
                    connected={connectionFor(connections, 'codex_subscription')?.status === 'ready'}
                    onClick={() => setMethod({ kind: 'codex_subscription' })}
                  />
                </li>
              )}
            </ul>
          </section>
        )}

        {(showAnthropicKey || showOpenaiKey || showOtherProviders || showOpenaiCompatible || showAnthropicCompatible) && (
          <section className="space-y-2">
            <Label>API keys & endpoints</Label>
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
            <ul className="max-h-80 space-y-2 overflow-y-auto">
              {showAnthropicKey && matchesSearch('anthropic claude api key') && (
                <li>
                  <MethodRow
                    providerID="anthropic"
                    label="Anthropic"
                    hint="Claude via your own API key"
                    connected={connectionFor(connections, 'anthropic_api_key')?.status === 'ready'}
                    onClick={() => setMethod({ kind: 'anthropic_api_key' })}
                  />
                </li>
              )}
              {showOpenaiKey && matchesSearch('openai gpt api key') && (
                <li>
                  <MethodRow
                    providerID="openai"
                    label="OpenAI"
                    hint="GPT models via your own API key"
                    connected={connectionFor(connections, 'openai_api_key')?.status === 'ready'}
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
                      connected={false}
                      onClick={() => setMethod({ kind: 'other_provider', providerId: provider.id })}
                    />
                  </li>
                ))}
              {showOpenaiCompatible && matchesSearch('custom openai-compatible endpoint local vllm ollama') && (
                <li>
                  <MethodRow
                    providerID="custom"
                    label="OpenAI-compatible endpoint"
                    hint="Custom base URL — Codex, OpenCode, and Pi"
                    connected={connectionFor(connections, 'openai_compatible')?.status === 'ready'}
                    onClick={() => setMethod({ kind: 'openai_compatible' })}
                  />
                </li>
              )}
              {showAnthropicCompatible && matchesSearch('custom anthropic-compatible endpoint local proxy') && (
                <li>
                  <MethodRow
                    providerID="custom"
                    label="Anthropic-compatible endpoint"
                    hint="Custom base URL — Claude Code"
                    connected={connectionFor(connections, 'anthropic_compatible')?.status === 'ready'}
                    onClick={() => setMethod({ kind: 'anthropic_compatible' })}
                  />
                </li>
              )}
              {query &&
                filteredOtherProviders.length === 0 &&
                !matchesSearch('anthropic claude api key') &&
                !matchesSearch('openai gpt api key') &&
                !matchesSearch('custom openai-compatible endpoint local vllm ollama') &&
                !matchesSearch('custom anthropic-compatible endpoint local proxy') && (
                  <li className="text-muted-foreground px-3 py-4 text-center text-xs">
                    No providers match &ldquo;{search}&rdquo;
                  </li>
                )}
            </ul>
          </section>
        )}

        {!showSubscriptions && !showAnthropicKey && !showOpenaiKey && !showOpenaiCompatible && !showAnthropicCompatible && (
          <EmptyState size="sm" title="No compatible connection methods" />
        )}
      </div>
    );
  } else if (method.kind === 'claude_subscription') {
    body = (
      <ClaudeSubscriptionForm
        projectId={projectId}
        runtimes={runtimes}
        onBack={() => setMethod(null)}
        onConnected={handleConnected}
      />
    );
  } else if (method.kind === 'codex_subscription') {
    body = (
      <ChatGptSubscriptionForm
        projectId={projectId}
        runtimes={runtimes}
        onBack={() => setMethod(null)}
        onConnected={handleConnected}
      />
    );
  } else if (method.kind === 'anthropic_api_key') {
    body = (
      <ApiKeyForm
        projectId={projectId}
        provider={LLM_PROVIDER_BY_ID.get('anthropic')!}
        connectionKind="anthropic_api_key"
        compatibleHarnesses={METHOD_COMPATIBLE_HARNESSES.anthropic_api_key}
        runtimes={runtimes}
        onBack={() => setMethod(null)}
        onConnected={handleConnected}
      />
    );
  } else if (method.kind === 'openai_api_key') {
    body = (
      <ApiKeyForm
        projectId={projectId}
        provider={LLM_PROVIDER_BY_ID.get('openai')!}
        connectionKind="openai_api_key"
        compatibleHarnesses={METHOD_COMPATIBLE_HARNESSES.openai_api_key}
        runtimes={runtimes}
        onBack={() => setMethod(null)}
        onConnected={handleConnected}
      />
    );
  } else if (method.kind === 'other_provider') {
    const provider = LLM_PROVIDER_BY_ID.get(method.providerId);
    body = provider ? (
      <ApiKeyForm
        projectId={projectId}
        provider={provider}
        runtimes={runtimes}
        onBack={() => setMethod(null)}
        onConnected={handleConnected}
      />
    ) : null;
  } else {
    body = (
      <CustomEndpointForm
        projectId={projectId}
        runtimes={runtimes}
        initialProtocol={method.kind === 'openai_compatible' ? 'openai' : 'anthropic'}
        onBack={() => setMethod(null)}
        onDone={handleConnected}
      />
    );
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="flex max-h-[85vh] w-[calc(100vw-2rem)] max-w-[520px] flex-col gap-0 overflow-hidden lg:max-w-[520px]">
        <ModalHeader>
          <ModalTitle>Connect a model service</ModalTitle>
          <ModalDescription>Use a subscription, API key, or compatible endpoint.</ModalDescription>
        </ModalHeader>
        <ModalBody className="overflow-y-auto">{body}</ModalBody>
      </ModalContent>
    </Modal>
  );
}

function MethodRow({
  providerID,
  label,
  hint,
  connected,
  onClick,
}: {
  providerID: string;
  label: string;
  hint: string;
  connected: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={ROW} onClick={onClick}>
      <ProviderLogo providerID={providerID} name={label} size="default" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-foreground truncate text-sm font-medium">{label}</span>
          {connected && (
            <Badge variant="success" size="sm">
              Connected
            </Badge>
          )}
        </div>
        <p className="text-muted-foreground mt-0.5 truncate text-xs">{hint}</p>
      </div>
      <Plus className="text-muted-foreground/40 size-4 shrink-0" />
    </button>
  );
}
