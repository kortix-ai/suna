'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
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
  CaretDownIcon as ChevronDown,
  KeyIcon as KeyRound,
  PlugIcon as PlugZap,
  SlidersHorizontalIcon as SlidersHorizontal,
  WarningIcon as TriangleAlert,
} from '@phosphor-icons/react';
import { useState } from 'react';

import type {
  SessionScopeConnectorOption,
  SessionScopeDraft,
  SessionScopeSelectionCatalog,
} from './session-scope-model';

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

export function setSessionConnectorEnabled(
  draft: SessionScopeDraft,
  connector: SessionScopeConnectorOption,
  enabled: boolean,
): SessionScopeDraft {
  if (!enabled) {
    return setSessionConnectorAuthorization(draft, connector.slug, null);
  }

  if (draft.connector_bindings?.[connector.slug]) {
    return draft;
  }

  const authorization =
    connector.authorizations.find((candidate) => candidate.is_default) ??
    connector.authorizations[0];

  return authorization
    ? setSessionConnectorAuthorization(draft, connector.slug, authorization.authorization_id)
    : draft;
}

function secretSummary(draft: SessionScopeDraft): string {
  if (draft.secrets === null) return 'All allowed';
  if (draft.secrets === undefined) return 'Unchanged';
  if (draft.secrets.length === 0) return 'None selected';
  return `${draft.secrets.length} selected`;
}

function connectorSummary(draft: SessionScopeDraft): string {
  if (draft.connector_bindings === undefined) return 'Unchanged';
  const count = Object.keys(draft.connector_bindings).length;
  return count === 0 ? 'None selected' : `${count} selected`;
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
  const [openSection, setOpenSection] = useState<'secrets' | 'connectors' | null>(null);

  return (
    <div className="flex max-h-[min(500px,calc(100vh-2rem))] flex-col">
      <div className="border-border border-b px-4 py-3.5">
        <h3 className="text-foreground text-sm font-medium text-balance">Session access</h3>
        <p className="text-muted-foreground mt-1 text-xs leading-relaxed text-pretty">
          Share only the secrets and connectors this session needs.
        </p>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
        <Disclosure
          open={openSection === 'secrets'}
          onOpenChange={(open) => setOpenSection(open ? 'secrets' : null)}
          variant="outline"
          className="overflow-hidden"
        >
          <DisclosureTrigger variant="outline">
            <Button
              type="button"
              variant="popover"
              className="min-h-12 w-full justify-start rounded-none px-3 py-2 text-left"
            >
              <span className="bg-foreground/5 flex size-8 shrink-0 items-center justify-center rounded-sm">
                <KeyRound className="text-muted-foreground size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-foreground block truncate text-sm font-medium">Secrets</span>
                <span className="text-muted-foreground mt-0.5 block truncate text-xs font-normal">
                  Environment values
                </span>
              </span>
              <Badge variant="secondary" size="xs" className="tabular-nums">
                {catalog.secrets.status === 'ready' ? secretSummary(draft) : 'Unavailable'}
              </Badge>
              <ChevronDown className="text-muted-foreground size-3.5 transition-transform group-data-[state=open]:rotate-180" />
            </Button>
          </DisclosureTrigger>
          <DisclosureContent variant="outline" contentClassName="border-border border-t">
            {catalog.secrets.status === 'unavailable' ? (
              <div className="p-2">
                <InfoBanner tone="neutral" title="Secret access is unavailable">
                  The current secret selection stays unchanged.
                </InfoBanner>
              </div>
            ) : (
              <div className="p-1">
                <Checkbox
                  checked={draft.secrets === null}
                  disabled={controlsDisabled}
                  className="min-h-10"
                  label="Allow every available secret"
                  onCheckedChange={(checked) =>
                    onChange(setAllSessionSecrets(draft, checked === true))
                  }
                />
                {catalog.secrets.items.length > 0 ? (
                  <div className="border-border mt-1 border-t pt-1">
                    {catalog.secrets.items.map((secret) => {
                      const checked =
                        draft.secrets === null ||
                        draft.secrets?.includes(secret.identifier) === true;
                      return (
                        <Checkbox
                          key={secret.identifier}
                          checked={checked}
                          disabled={controlsDisabled}
                          className="min-h-10"
                          label={
                            <span className="flex min-w-0 flex-col gap-0.5">
                              <span className="text-foreground truncate">{secret.name}</span>
                              {secret.name !== secret.identifier ? (
                                <code className="text-muted-foreground truncate text-xs">
                                  {secret.identifier}
                                </code>
                              ) : null}
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
                  <p className="text-muted-foreground border-border mt-1 border-t px-3 py-3 text-xs text-pretty">
                    No secrets are available for this agent.
                  </p>
                )}
              </div>
            )}
          </DisclosureContent>
        </Disclosure>

        <Disclosure
          open={openSection === 'connectors'}
          onOpenChange={(open) => setOpenSection(open ? 'connectors' : null)}
          variant="outline"
          className="overflow-hidden"
        >
          <DisclosureTrigger variant="outline">
            <Button
              type="button"
              variant="popover"
              className="min-h-12 w-full justify-start rounded-none px-3 py-2 text-left"
            >
              <span className="bg-foreground/5 flex size-8 shrink-0 items-center justify-center rounded-sm">
                <PlugZap className="text-muted-foreground size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-foreground block truncate text-sm font-medium">
                  Connectors
                </span>
                <span className="text-muted-foreground mt-0.5 block truncate text-xs font-normal">
                  Authorized accounts
                </span>
              </span>
              <Badge variant="secondary" size="xs" className="tabular-nums">
                {catalog.connector_profiles.status === 'ready'
                  ? connectorSummary(draft)
                  : 'Unavailable'}
              </Badge>
              <ChevronDown className="text-muted-foreground size-3.5 transition-transform group-data-[state=open]:rotate-180" />
            </Button>
          </DisclosureTrigger>
          <DisclosureContent variant="outline" contentClassName="border-border border-t">
            {catalog.connector_profiles.status === 'unavailable' ? (
              <div className="p-2">
                <InfoBanner tone="neutral" title="Connector access is unavailable">
                  The current connector selection stays unchanged.
                </InfoBanner>
              </div>
            ) : catalog.connector_profiles.items.length === 0 ? (
              <p className="text-muted-foreground px-3 py-3 text-xs text-pretty">
                No connector profiles are available for this agent.
              </p>
            ) : (
              <ul className="space-y-1 p-1">
                {catalog.connector_profiles.items.map((connector) => {
                  const currentAuthorization =
                    draft.connector_bindings?.[connector.slug]?.authorization_id;
                  const currentAuthorizationIsAvailable = connector.authorizations.some(
                    (authorization) => authorization.authorization_id === currentAuthorization,
                  );
                  const selected = currentAuthorization !== undefined;
                  const canSelect = selected || connector.authorizations.length > 0;

                  return (
                    <li key={connector.slug}>
                      <Checkbox
                        checked={selected}
                        disabled={controlsDisabled || !canSelect}
                        className="min-h-10"
                        label={
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="text-foreground truncate">{connector.name}</span>
                            <Badge variant="outline" size="xs">
                              {connector.authorization_strategy === 'user' ? 'Private' : 'Project'}
                            </Badge>
                            {!canSelect ? (
                              <span className="text-muted-foreground truncate text-xs font-normal">
                                No authorization
                              </span>
                            ) : null}
                          </span>
                        }
                        onCheckedChange={(checked) =>
                          onChange(setSessionConnectorEnabled(draft, connector, checked === true))
                        }
                      />
                      {selected ? (
                        <div className="pr-2 pb-2 pl-10">
                          <Select
                            value={currentAuthorization}
                            disabled={controlsDisabled}
                            onValueChange={(authorizationId) =>
                              onChange(
                                setSessionConnectorAuthorization(
                                  draft,
                                  connector.slug,
                                  authorizationId,
                                ),
                              )
                            }
                          >
                            <SelectTrigger
                              size="md"
                              variant="outline"
                              className="w-full"
                              aria-label={`Authorization for ${connector.name}`}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent align="end">
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
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </DisclosureContent>
        </Disclosure>

        {retroactive === false ? (
          <InfoBanner tone="warning" icon={TriangleAlert} title="Existing context is unchanged">
            Removed secret values can remain in the current conversation or existing shells.
          </InfoBanner>
        ) : null}
      </div>

      <div className="border-border flex items-center justify-between gap-3 border-t px-4 py-3">
        <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
          Changes apply to the next prompt.
        </p>
        <Button
          type="button"
          className="h-10 px-4"
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
        className="w-[352px] max-w-[calc(100vw-2rem)] overflow-hidden p-0 shadow-md"
      >
        <SessionScopeControlContent {...contentProps} />
      </PopoverContent>
    </Popover>
  );
}
