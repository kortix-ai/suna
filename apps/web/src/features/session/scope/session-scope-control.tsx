'use client';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { InfoBanner } from '@/components/ui/info-banner';
import { ArrowCounterClockwiseIcon as ArrowCounterClockwise } from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';

import { type SessionScopeDraft, type SessionScopeSelectionCatalog } from './session-scope-model';

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
    const secrets: string[] = [];
    for (const secret of catalog.secrets.items) {
      if (secret.identifier !== identifier) secrets.push(secret.identifier);
    }
    return {
      ...draft,
      secrets,
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

/**
 * The way OUT of an override. An override you cannot switch off is a trap: the
 * session keeps a frozen selection while the project's own defaults move on.
 *
 * Rendered by the overrides panel BESIDE an axis editor, never inside it: an
 * empty catalog must not be able to hide the only way back to the default.
 */
export function ResetAxisButton({
  disabled = false,
  onReset,
  label,
}: {
  disabled?: boolean;
  onReset: () => void;
  /** Names where the default comes from — "Reset to agent default" etc. */
  label?: string;
}) {
  const t = useTranslations('sessionScope');
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
      {label ?? t('resetDefault')}
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
  const t = useTranslations('sessionScope');
  if (catalog.secrets.status === 'unavailable') {
    return (
      <InfoBanner tone="neutral" title={t('secrets.unavailableTitle')}>
        {t('secrets.unavailableDescription')}
      </InfoBanner>
    );
  }

  const selectedSecrets = new Set(draft.secrets ?? []);

  return (
    <div className="space-y-1">
      <Checkbox
        checked={draft.secrets === null}
        disabled={disabled}
        className="min-h-10"
        label={t('secrets.useProjectDefault')}
        onCheckedChange={(checked) => onChange(setAllSessionSecrets(draft, checked === true))}
      />
      {catalog.secrets.items.length > 0 ? (
        <div className="border-border border-t pt-1">
          {catalog.secrets.items.map((secret) => {
            const checked = draft.secrets === null || selectedSecrets.has(secret.identifier);
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
                  onChange(
                    toggleSessionSecret(draft, catalog, secret.identifier, nextChecked === true),
                  )
                }
              />
            );
          })}
        </div>
      ) : (
        <p className="text-muted-foreground border-border border-t px-1 py-3 text-xs text-pretty">
          {t('secrets.empty')}
        </p>
      )}
    </div>
  );
}

// The connector checklist (`SessionConnectorsEditor`) that used to live here
// is gone — the overrides panel no longer has a Connectors axis at all (see
// `session-overrides-toolbar.tsx`). Credentials are not a session-minting
// decision: the agent may use every account it is entitled to and names one
// at call time (`kortix connectors call --account`, `accounts` to see them).
// `setSessionConnectorConnection` above stays — `connector_bindings` is still
// a real, programmatic-API concept (Kortix as a Backend).
