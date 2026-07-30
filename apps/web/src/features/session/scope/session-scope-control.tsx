'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { InfoBanner } from '@/components/ui/info-banner';
import Loading from '@/components/ui/loading';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  KeyIcon as KeyRound,
  PlugIcon as PlugZap,
  SlidersHorizontalIcon as SlidersHorizontal,
  WarningIcon as TriangleAlert,
} from '@phosphor-icons/react';

import type { SessionScopeDraft, SessionScopeSelectionCatalog } from './session-scope-model';

const NO_AUTHORIZATION = '__no_authorization__';

export interface SessionScopeControlContentProps {
  draft: SessionScopeDraft;
  catalog: SessionScopeSelectionCatalog;
  disabled?: boolean;
  saveDisabled?: boolean;
  saving?: boolean;
  retroactive?: boolean;
  onChange: (draft: SessionScopeDraft) => void;
  onSave: () => void;
}

export interface SessionScopeControlProps extends SessionScopeControlContentProps {
  triggerLabel?: string;
}

export function setAllSessionSecrets(
  draft: SessionScopeDraft,
  allowAll: boolean,
): SessionScopeDraft {
  return {
    ...draft,
    secrets: allowAll ? null : [],
  };
}

export function toggleSessionSecret(
  draft: SessionScopeDraft,
  catalog: SessionScopeSelectionCatalog,
  identifier: string,
  allowed: boolean,
): SessionScopeDraft {
  if (catalog.secrets.status !== 'ready') return draft;

  if (draft.secrets === null) {
    if (allowed) return draft;
    return {
      ...draft,
      secrets: catalog.secrets.items
        .map((secret) => secret.identifier)
        .filter((candidate) => candidate !== identifier),
    };
  }

  const current = draft.secrets ?? [];
  const next = allowed
    ? Array.from(new Set([...current, identifier]))
    : current.filter((candidate) => candidate !== identifier);

  return {
    ...draft,
    secrets: next,
  };
}

export function setSessionConnectorAuthorization(
  draft: SessionScopeDraft,
  connectorProfile: string,
  authorizationId: string | null,
): SessionScopeDraft {
  const connectorBindings = { ...(draft.connector_bindings ?? {}) };

  if (authorizationId === null) {
    delete connectorBindings[connectorProfile];
  } else {
    connectorBindings[connectorProfile] = { authorization_id: authorizationId };
  }

  return {
    ...draft,
    connector_bindings: connectorBindings,
  };
}

function secretSummary(draft: SessionScopeDraft): string {
  if (draft.secrets === null) return 'All allowed';
  if (draft.secrets === undefined) return 'Unchanged';
  if (draft.secrets.length === 0) return 'None allowed';
  return `${draft.secrets.length} selected`;
}

export function SessionScopeControlContent({
  draft,
  catalog,
  disabled = false,
  saveDisabled = false,
  saving = false,
  retroactive,
  onChange,
  onSave,
}: SessionScopeControlContentProps) {
  const controlsDisabled = disabled || saving;

  return (
    <div className="flex max-h-[min(560px,calc(100vh-2rem))] flex-col">
      <div className="border-border border-b px-4 pt-4 pb-3">
        <h3 className="text-foreground text-sm font-semibold tracking-tight text-balance">
          Session scope
        </h3>
        <p className="text-muted-foreground mt-1 text-xs leading-relaxed text-pretty">
          Choose the secrets and connector authorizations available to this session.
        </p>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
        <section aria-labelledby="session-scope-secrets" className="space-y-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <KeyRound className="text-muted-foreground size-3.5 shrink-0" />
              <h4 id="session-scope-secrets" className="text-foreground text-sm font-medium">
                Secrets
              </h4>
            </div>
            {catalog.secrets.status === 'ready' ? (
              <Badge variant="outline" size="xs" className="tabular-nums">
                {secretSummary(draft)}
              </Badge>
            ) : null}
          </div>

          {catalog.secrets.status === 'unavailable' ? (
            <InfoBanner tone="neutral" title="Secret access is unavailable">
              The current secret selection stays unchanged.
            </InfoBanner>
          ) : (
            <div className="bg-popover overflow-hidden rounded-md border">
              <Checkbox
                checked={draft.secrets === null}
                disabled={controlsDisabled}
                className="min-h-10 rounded-none px-3 py-2"
                label="Allow every available secret"
                onCheckedChange={(checked) =>
                  onChange(setAllSessionSecrets(draft, checked === true))
                }
              />
              {catalog.secrets.items.length > 0 ? (
                <div className="border-border border-t px-1 py-1">
                  {catalog.secrets.items.map((secret) => {
                    const checked =
                      draft.secrets === null || draft.secrets?.includes(secret.identifier) === true;
                    return (
                      <Checkbox
                        key={secret.identifier}
                        checked={checked}
                        disabled={controlsDisabled}
                        className="min-h-10"
                        label={
                          <span className="flex min-w-0 flex-col gap-0.5">
                            <span className="text-foreground truncate">{secret.name}</span>
                            <code className="text-muted-foreground truncate text-xs">
                              {secret.identifier}
                            </code>
                          </span>
                        }
                        onCheckedChange={(nextChecked) =>
                          onChange(
                            toggleSessionSecret(
                              draft,
                              catalog,
                              secret.identifier,
                              nextChecked === true,
                            ),
                          )
                        }
                      />
                    );
                  })}
                </div>
              ) : (
                <p className="text-muted-foreground border-border border-t px-3 py-3 text-xs text-pretty">
                  No secrets are available for this agent.
                </p>
              )}
            </div>
          )}
        </section>

        <section aria-labelledby="session-scope-connectors" className="space-y-2.5">
          <div className="flex items-center gap-2">
            <PlugZap className="text-muted-foreground size-3.5 shrink-0" />
            <h4 id="session-scope-connectors" className="text-foreground text-sm font-medium">
              Connectors
            </h4>
          </div>

          {catalog.connector_profiles.status === 'unavailable' ? (
            <InfoBanner tone="neutral" title="Connector access is unavailable">
              The current connector selection stays unchanged.
            </InfoBanner>
          ) : catalog.connector_profiles.items.length === 0 ? (
            <div className="bg-popover rounded-md border px-3 py-3">
              <p className="text-muted-foreground text-xs text-pretty">
                No connector profiles are available for this agent.
              </p>
            </div>
          ) : (
            <ul className="space-y-2">
              {catalog.connector_profiles.items.map((connector) => {
                const currentAuthorization =
                  draft.connector_bindings?.[connector.slug]?.authorization_id;
                const currentAuthorizationIsAvailable = connector.authorizations.some(
                  (authorization) => authorization.authorization_id === currentAuthorization,
                );

                return (
                  <li
                    key={connector.slug}
                    className="bg-popover flex min-h-10 items-center gap-3 rounded-md border px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <p className="text-foreground truncate text-sm font-medium">
                          {connector.name}
                        </p>
                        <Badge variant="outline" size="xs">
                          {connector.authorization_strategy === 'user' ? 'Private' : 'Project'}
                        </Badge>
                      </div>
                      <p className="text-muted-foreground mt-0.5 truncate font-mono text-xs">
                        {connector.slug}
                      </p>
                    </div>

                    <Select
                      value={currentAuthorization ?? NO_AUTHORIZATION}
                      disabled={controlsDisabled}
                      onValueChange={(authorizationId) =>
                        onChange(
                          setSessionConnectorAuthorization(
                            draft,
                            connector.slug,
                            authorizationId === NO_AUTHORIZATION ? null : authorizationId,
                          ),
                        )
                      }
                    >
                      <SelectTrigger
                        variant="popover"
                        size="sm"
                        className="w-40 shrink-0"
                        aria-label={`Authorization for ${connector.name}`}
                      >
                        <SelectValue placeholder="No authorization" />
                      </SelectTrigger>
                      <SelectContent align="end">
                        <SelectItem value={NO_AUTHORIZATION}>No authorization</SelectItem>
                        {currentAuthorization && !currentAuthorizationIsAvailable ? (
                          <SelectItem value={currentAuthorization}>
                            Current authorization
                          </SelectItem>
                        ) : null}
                        {connector.authorizations.map((authorization) => (
                          <SelectItem
                            key={authorization.authorization_id}
                            value={authorization.authorization_id}
                          >
                            {authorization.label}
                            {authorization.is_default ? ' · Default' : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {retroactive === false ? (
          <InfoBanner tone="warning" icon={TriangleAlert} title="Existing context is unchanged">
            Removed secret values can remain in the current conversation or existing shells.
          </InfoBanner>
        ) : null}
      </div>

      <div className="border-border flex items-center justify-between gap-3 border-t px-4 py-3">
        <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
          Saved changes apply to the next prompt or tool call.
        </p>
        <Button
          type="button"
          size="sm"
          disabled={controlsDisabled || saveDisabled}
          onClick={onSave}
        >
          {saving ? <Loading className="size-3.5 shrink-0" /> : null}
          Save
        </Button>
      </div>
    </div>
  );
}

export function SessionScopeControl({
  triggerLabel = 'Scope',
  ...contentProps
}: SessionScopeControlProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="toolbar"
          disabled={contentProps.disabled || contentProps.saving}
          aria-label="Configure session scope"
        >
          <SlidersHorizontal className="size-3.5 shrink-0" />
          {triggerLabel}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-[380px] max-w-[calc(100vw-2rem)] overflow-hidden p-0 shadow-md"
      >
        <SessionScopeControlContent {...contentProps} />
      </PopoverContent>
    </Popover>
  );
}
