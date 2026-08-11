'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { InfoBanner } from '@/components/ui/info-banner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ArrowCounterClockwiseIcon as ArrowCounterClockwise } from '@phosphor-icons/react';

import {
  type SessionScopeConnectorOption,
  type SessionScopeDraft,
  type SessionScopeSelectionCatalog,
} from './session-scope-model';

export interface SessionScopeEditorProps {
  draft: SessionScopeDraft;
  catalog: SessionScopeSelectionCatalog;
  disabled?: boolean;
  onChange: (draft: SessionScopeDraft) => void;
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

export function setSessionConnectorConnection(
  draft: SessionScopeDraft,
  connectorConnection: string,
  connectionId: string | null,
): SessionScopeDraft {
  const connectorBindings = { ...(draft.connector_bindings ?? {}) };

  if (connectionId === null) {
    delete connectorBindings[connectorConnection];
  } else {
    connectorBindings[connectorConnection] = { connection_id: connectionId };
  }

  return {
    ...draft,
    connector_bindings: connectorBindings,
    connector_bindings_inherited: false,
  };
}

export function setSessionConnectorEnabled(
  draft: SessionScopeDraft,
  connector: SessionScopeConnectorOption,
  enabled: boolean,
): SessionScopeDraft {
  const withoutRequirement = (base: SessionScopeDraft): SessionScopeDraft =>
    base.require_connectors?.includes(connector.slug)
      ? {
          ...base,
          require_connectors: base.require_connectors.filter((slug) => slug !== connector.slug),
        }
      : base;

  if (!enabled) {
    return withoutRequirement(setSessionConnectorConnection(draft, connector.slug, null));
  }

  if (draft.connector_bindings?.[connector.slug]) {
    return draft;
  }

  const connection =
    connector.connections.find((candidate) => candidate.is_default) ?? connector.connections[0];

  if (connection) {
    return withoutRequirement(
      setSessionConnectorConnection(draft, connector.slug, connection.connection_id),
    );
  }

  // Nothing connected to this connector yet — and selecting it anyway is the
  // point. It used to be un-checkable, so the only way to say "this session
  // needs Gmail" was to already have Gmail working. Recorded as a REQUIREMENT
  // instead of a binding (a binding needs a connection id it does not have),
  // which makes the next turn stop at a connect prompt rather than letting the
  // agent discover it mid-answer.
  return draft.require_connectors?.includes(connector.slug)
    ? draft
    : {
        ...draft,
        connector_bindings_inherited: false,
        require_connectors: [...(draft.require_connectors ?? []), connector.slug],
      };
}

/**
 * The way OUT of an override. An override you cannot switch off is a trap: the
 * session keeps a frozen selection while the workspace's own defaults move on.
 *
 * Rendered by the overrides panel BESIDE an axis editor, never inside it: an
 * empty catalog must not be able to hide the only way back to the default.
 */
export function ResetAxisButton({
  disabled = false,
  onReset,
  label = 'Reset to default',
}: {
  disabled?: boolean;
  onReset: () => void;
  /** Names where the default comes from — "Reset to agent default" etc. */
  label?: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={disabled}
      className="text-muted-foreground -ml-1 h-8"
      onClick={onReset}
    >
      <ArrowCounterClockwise className="size-3.5 shrink-0" />
      {label}
    </Button>
  );
}

/**
 * The secrets checklist. `null` (every box checked) is the INHERITED state, not
 * "all selected by hand" — unchecking one converts the axis into an explicit
 * allowlist, which is the only way an override is ever created here.
 */
export function SessionSecretsEditor({
  draft,
  catalog,
  disabled = false,
  onChange,
}: SessionScopeEditorProps) {
  if (catalog.secrets.status === 'unavailable') {
    return (
      <InfoBanner tone="neutral" title="Secret access is unavailable">
        The current secret selection stays unchanged.
      </InfoBanner>
    );
  }

  return (
    <div className="space-y-1">
      <Checkbox
        checked={draft.secrets === null}
        disabled={disabled}
        className="min-h-10"
        label="Use the workspace default"
        onCheckedChange={(checked) => onChange(setAllSessionSecrets(draft, checked === true))}
      />
      {catalog.secrets.items.length > 0 ? (
        <div className="border-border border-t pt-1">
          {catalog.secrets.items.map((secret) => {
            const checked =
              draft.secrets === null || draft.secrets?.includes(secret.identifier) === true;
            return (
              <Checkbox
                key={secret.identifier}
                checked={checked}
                disabled={disabled}
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
                  onChange(toggleSessionSecret(draft, catalog, secret.identifier, nextChecked === true))
                }
              />
            );
          })}
        </div>
      ) : (
        <p className="text-muted-foreground border-border border-t px-1 py-3 text-xs text-pretty">
          No secrets are available for this agent.
        </p>
      )}
    </div>
  );
}

/**
 * The connector checklist, plus a connection picker per selected connector.
 * Untouched, it PREVIEWS what the workspace resolves today — see
 * `connector_bindings_inherited`. Touching any row turns the preview into an
 * explicit, fail-closed override.
 */
export function SessionConnectorsEditor({
  draft,
  catalog,
  disabled = false,
  onChange,
}: SessionScopeEditorProps) {
  if (catalog.connector_connections.status === 'unavailable') {
    return (
      <InfoBanner tone="neutral" title="Connector access is unavailable">
        The current connector selection stays unchanged.
      </InfoBanner>
    );
  }

  if (catalog.connector_connections.items.length === 0) {
    return (
      <p className="text-muted-foreground px-1 py-3 text-xs text-pretty">
        No connectors are available for this agent.
      </p>
    );
  }

  return (
    <div className="space-y-1">
      <ul className="space-y-1">
        {catalog.connector_connections.items.map((connector) => {
          const currentConnection = draft.connector_bindings?.[connector.slug]?.connection_id;
          const currentConnectionIsAvailable = connector.connections.some(
            (connection) => connection.connection_id === currentConnection,
          );
          const bound = currentConnection !== undefined;
          // Required but not connected: the session declares it and the
          // next turn will stop for a connect prompt.
          const requiredUnconnected =
            !bound && (draft.require_connectors?.includes(connector.slug) ?? false);
          const selected = bound || requiredUnconnected;
          const hasConnection = connector.connections.length > 0;

          return (
            <li key={connector.slug}>
              <Checkbox
                checked={selected}
                // Selectable with nothing connected. Greying it out meant
                // you could only require a connector that already worked,
                // which is precisely backwards — needing one you have not
                // connected yet is the case worth expressing.
                disabled={disabled}
                className="min-h-10"
                label={
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="text-foreground truncate">{connector.name}</span>
                    <Badge variant="outline" size="xs">
                      {connector.authorization_strategy === 'user' ? 'Private' : 'Workspace'}
                    </Badge>
                    {!hasConnection ? (
                      <span className="text-muted-foreground truncate text-xs font-normal">
                        {requiredUnconnected ? 'Required — connect to continue' : 'Not connected'}
                      </span>
                    ) : null}
                  </span>
                }
                onCheckedChange={(checked) =>
                  onChange(setSessionConnectorEnabled(draft, connector, checked === true))
                }
              />
              {requiredUnconnected ? (
                // No connection exists, so there is nothing for the
                // Select to offer — rendering it would show an empty
                // dropdown that looks broken. Say what will happen instead.
                <p className="text-muted-foreground pr-2 pb-2 pl-10 text-xs text-pretty">
                  Nothing is connected to {connector.name} yet. This session will ask you to connect
                  it before its next reply.
                </p>
              ) : null}
              {selected && !requiredUnconnected ? (
                <div className="pr-2 pb-2 pl-10">
                  <Select
                    value={currentConnection}
                    disabled={disabled}
                    onValueChange={(connectionId) =>
                      onChange(setSessionConnectorConnection(draft, connector.slug, connectionId))
                    }
                  >
                    <SelectTrigger
                      size="md"
                      variant="outline"
                      className="w-full"
                      aria-label={`Connection for ${connector.name}`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="end">
                      {currentConnection && !currentConnectionIsAvailable ? (
                        <SelectItem value={currentConnection}>Current connection</SelectItem>
                      ) : null}
                      {connector.connections.map((connection) => (
                        <SelectItem key={connection.connection_id} value={connection.connection_id}>
                          {connection.label}
                          {connection.is_default ? ' · Default' : ''}
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
    </div>
  );
}
