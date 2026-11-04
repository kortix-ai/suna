'use client';

import { CheckIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

import { useTranslations } from '../../../i18n';
import { needsReconnection } from '../../../internal/lib/account-secret-access';
import { LLM_PROVIDER_BY_ID } from '../../../internal/lib/llm-providers';
import { uiRoutes } from '../../../lib/routes';
import { cn } from '../../../lib/utils';
import { Button } from '../../../primitives/button';
import Loading from '../../../primitives/loading';
import { useUiLink } from '../../../providers/ui-provider';
import { useProviderKeyChoices } from '../../overrides/provider-secret-pool-editor';
import {
  setAllSessionSecrets,
  setSessionConnectorConnection,
  toggleSessionSecret,
} from '../../scope/session-scope-control';
import { resetSessionConnectorBindings } from '../../scope/session-scope-model';
import type { ChatInputOverrides } from './chat-input-overrides';

/** A choice in the right pane: the arrow keys walk them (see `ChatInputControl`). */
export const OPTION_ATTR = 'data-chat-input-option';

/** Keys per provider the gateway rotates through at most (the pools route refuses more). */
const MAX_KEYS_PER_PROVIDER = 10;

/**
 * One row in the right pane: an agent, an effort, a secret, a key, an
 * account. A radio row is one choice of several; a checkbox row is one of a
 * set. Either way the mark sits right and the row tints when chosen.
 */
export function ChoiceRow({
  kind = 'radio',
  checked,
  disabled = false,
  onSelect,
  icon,
  label,
  description,
  trailing,
}: {
  kind?: 'radio' | 'checkbox';
  checked: boolean;
  disabled?: boolean;
  onSelect: () => void;
  icon?: ReactNode;
  label: ReactNode;
  description?: ReactNode;
  /** Beside the mark: a "Default" tag. */
  trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      role={kind}
      aria-checked={checked}
      disabled={disabled}
      tabIndex={kind === 'checkbox' || checked ? 0 : -1}
      {...{ [OPTION_ATTR]: '' }}
      onClick={onSelect}
      className={cn(
        'focus-visible:ring-ring flex w-full min-w-0 shrink-0 items-center gap-2.5 rounded-md px-2 text-left outline-none focus-visible:ring-2 disabled:pointer-events-none',
        description ? 'py-1.5' : 'min-h-8 py-1',
        checked ? 'bg-active' : 'hover:bg-hover',
      )}
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span className="text-foreground block truncate text-sm font-medium">{label}</span>
        {description ? (
          <span className="text-muted-foreground block truncate text-xs">{description}</span>
        ) : null}
      </span>
      {trailing}
      <span
        aria-hidden
        className={cn(
          'flex size-4 shrink-0 items-center justify-center',
          // A square box (4px corners) so a set reads apart from a one-of-many radio.
          kind === 'checkbox' && 'border-border rounded-[calc(var(--radius)-6px)] border',
          kind === 'checkbox' && checked && 'bg-foreground text-background border-foreground',
        )}
      >
        {checked ? (
          <CheckIcon className={cn('size-3', kind === 'radio' && 'text-foreground size-3.5')} />
        ) : null}
      </span>
    </button>
  );
}

/** A group's name inside a pane: an app, a provider. */
function GroupLabel({ children }: { children: ReactNode }) {
  return <p className="text-foreground px-2 pt-2.5 pb-1 text-xs font-medium">{children}</p>;
}

function PaneNote({ children, loading = false }: { children: ReactNode; loading?: boolean }) {
  return (
    <p
      role="status"
      className="text-muted-foreground flex items-center gap-2 px-2 py-2 text-xs text-pretty"
    >
      {loading ? <Loading className="size-3.5 shrink-0" /> : null}
      {children}
    </p>
  );
}

type Scope = NonNullable<ChatInputOverrides['scope']>;

/** How many secrets reach the session: the agent's whole grant, or the chosen set. */
export function secretsInEffect(scope: Scope): number | null {
  if (scope.catalog.secrets.status !== 'ready') return null;
  if (scope.draft.secrets === null || scope.draft.secrets === undefined) {
    return scope.catalog.secrets.items.length;
  }
  return scope.draft.secrets.length;
}

/**
 * Secrets: "Agent default" (every secret the agent's grant allows, which is
 * what an untouched session gets), then each secret with its mark. Under
 * the default every secret is marked, because every one is sent; unmarking
 * one turns the axis into an explicit list.
 */
export function SecretsPane({ scope }: { scope: Scope }) {
  const t = useTranslations('threads');
  const { draft, catalog, loading, disabled, onChange } = scope;
  if (loading) return <PaneNote loading>{t('chatInputLoading')}</PaneNote>;
  if (catalog.secrets.status !== 'ready')
    return <PaneNote>{t('chatInputSecretsUnavailable')}</PaneNote>;
  const items = catalog.secrets.items;
  const inherited = draft.secrets === null || draft.secrets === undefined;
  const chosen = new Set(draft.secrets ?? []);
  return (
    <div className="flex flex-col gap-px">
      <div role="radiogroup" aria-label={t('chatInputSecrets')}>
        <ChoiceRow
          checked={inherited}
          disabled={disabled}
          onSelect={() => onChange(setAllSessionSecrets(draft, true))}
          label={t('chatInputAgentDefault')}
          description={t('chatInputSecretsAll', { count: items.length })}
        />
      </div>
      {items.length === 0 ? (
        <PaneNote>{t('chatInputSecretsEmpty')}</PaneNote>
      ) : (
        <div
          role="group"
          aria-label={t('chatInputSecrets')}
          className="mt-1.5 flex flex-col gap-px"
        >
          {items.map((secret) => {
            const checked = inherited || chosen.has(secret.identifier);
            return (
              <ChoiceRow
                key={secret.identifier}
                kind="checkbox"
                checked={checked}
                disabled={disabled}
                onSelect={() =>
                  onChange(toggleSessionSecret(draft, catalog, secret.identifier, !checked))
                }
                label={secret.name}
                description={
                  secret.name !== secret.identifier ? (
                    <code className="font-mono">{secret.identifier}</code>
                  ) : undefined
                }
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

/** How many apps run on an account other than their default. `null`: all defaults. */
export function connectorsChanged(scope: Scope): number | null {
  if (scope.draft.connector_bindings_inherited === true) return null;
  if (scope.catalog.connector_connections.status !== 'ready') return null;
  const bindings = scope.draft.connector_bindings ?? {};
  return scope.catalog.connector_connections.items.filter((connector) => {
    const fallback =
      connector.connections.find((connection) => connection.is_default) ?? connector.connections[0];
    return bindings[connector.slug]?.connection_id !== fallback?.connection_id;
  }).length;
}

/**
 * Connectors: which account each app runs as in this session. "Agent
 * default" is every app on its default account (server-resolved, so a
 * disconnected account drops out on its own); picking another account for
 * one app pins the whole set.
 */
export function ConnectorsPane({ scope }: { scope: Scope }) {
  const t = useTranslations('threads');
  const { draft, catalog, loading, disabled, onChange } = scope;
  if (loading) return <PaneNote loading>{t('chatInputLoading')}</PaneNote>;
  if (catalog.connector_connections.status !== 'ready') {
    return <PaneNote>{t('chatInputConnectorsUnavailable')}</PaneNote>;
  }
  const connectors = catalog.connector_connections.items.filter(
    (connector) => connector.connections.length > 0,
  );
  const inherited = draft.connector_bindings_inherited === true;
  return (
    <div className="flex flex-col gap-px">
      <div role="radiogroup" aria-label={t('chatInputConnectors')}>
        <ChoiceRow
          checked={inherited}
          disabled={disabled}
          onSelect={() => onChange(resetSessionConnectorBindings(draft, catalog))}
          label={t('chatInputAgentDefault')}
          description={t('chatInputConnectorsAll')}
        />
      </div>
      {connectors.map((connector) => {
        const bound = draft.connector_bindings?.[connector.slug]?.connection_id;
        return (
          <div
            key={connector.slug}
            role="radiogroup"
            aria-label={connector.name}
            className="flex flex-col gap-px"
          >
            <GroupLabel>{connector.name}</GroupLabel>
            {connector.connections.map((connection) => (
              <ChoiceRow
                key={connection.connection_id}
                checked={bound === connection.connection_id}
                disabled={disabled}
                onSelect={() =>
                  onChange(
                    setSessionConnectorConnection(draft, connector.slug, connection.connection_id),
                  )
                }
                label={connection.label}
                trailing={
                  connection.is_default ? (
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {t('chatInputDefaultAccount')}
                    </span>
                  ) : null
                }
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

type ProviderKeys = NonNullable<ChatInputOverrides['providerKeys']>;

/** How many keys are pinned across providers. 0: the agent default. */
export function providerKeysInEffect(providerKeys: ProviderKeys): number {
  return Object.values(providerKeys.selection).reduce((count, ids) => count + ids.length, 0);
}

function providerLabel(providerId: string): string {
  return providerId === 'codex'
    ? 'ChatGPT'
    : (LLM_PROVIDER_BY_ID.get(providerId)?.label ?? providerId);
}

/**
 * Provider keys: "Agent default", then the keys this session may use,
 * grouped by provider. Marking keys pins the gateway to them for that
 * provider (it rotates through them on a rate limit); unmarking the last one
 * hands that provider back to the default.
 */
export function ProviderKeysPane({ providerKeys }: { providerKeys: ProviderKeys }) {
  const t = useTranslations('threads');
  const tPooled = useTranslations('pooledSecrets');
  const Link = useUiLink();
  const { keys, loading, error } = useProviderKeyChoices(
    providerKeys.projectId,
    providerKeys.sessionId,
  );
  const { selection, canEdit, onChange } = providerKeys;
  if (loading || providerKeys.loading) return <PaneNote loading>{t('chatInputLoading')}</PaneNote>;
  if (error) return <PaneNote>{tPooled('keysLoadError')}</PaneNote>;
  const providers = [
    ...new Set([...keys.map((key) => key.provider_id!), ...Object.keys(selection)]),
  ].sort();
  const inherited = providerKeysInEffect(providerKeys) === 0;
  const manageHref = uiRoutes().customize(providerKeys.projectId, 'models');
  return (
    <div className="flex flex-col gap-px">
      <div role="radiogroup" aria-label={tPooled('providerKeys')}>
        <ChoiceRow
          checked={inherited}
          disabled={!canEdit}
          onSelect={() => {
            for (const providerId of Object.keys(selection)) onChange(providerId, null);
          }}
          label={t('chatInputAgentDefault')}
          description={t('chatInputProviderKeysAll')}
        />
      </div>
      {providers.length === 0 ? (
        <PaneNote>{t('chatInputProviderKeysEmpty')}</PaneNote>
      ) : (
        providers.map((providerId) => {
          const chosen = selection[providerId] ?? [];
          const providerKeyList = keys.filter((key) => key.provider_id === providerId);
          return (
            <div
              key={providerId}
              role="group"
              aria-label={providerLabel(providerId)}
              className="flex flex-col gap-px"
            >
              <GroupLabel>{providerLabel(providerId)}</GroupLabel>
              {providerKeyList.map((key) => {
                const checked = chosen.includes(key.secret_id);
                const atLimit = !checked && chosen.length >= MAX_KEYS_PER_PROVIDER;
                return (
                  <ChoiceRow
                    key={key.secret_id}
                    kind="checkbox"
                    checked={checked}
                    disabled={!canEdit || atLimit}
                    onSelect={() => {
                      const next = checked
                        ? chosen.filter((id) => id !== key.secret_id)
                        : [...chosen, key.secret_id];
                      onChange(providerId, next.length > 0 ? next : null);
                    }}
                    label={key.label}
                    description={
                      providerId === 'codex' && needsReconnection(key)
                        ? tPooled('needsReconnection')
                        : undefined
                    }
                  />
                );
              })}
            </div>
          );
        })
      )}
      {manageHref ? (
        <Button
          size="xs"
          variant="ghost"
          asChild
          className="text-muted-foreground hover:text-foreground mt-1.5 self-start"
        >
          <Link href={manageHref}>{tPooled('manageKeys')}</Link>
        </Button>
      ) : null}
    </div>
  );
}
