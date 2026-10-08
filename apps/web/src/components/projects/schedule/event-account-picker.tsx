'use client';

/**
 * Which account of a connector feeds an app event trigger. Only shared
 * accounts (project-owned, open to the whole project) can; the connector's
 * default is what a trigger uses when it names none. One list for the create
 * modal's App step and the detail sheet.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { connectorConnectionQueryKeys } from '@/features/workspace/customize/sections/connector-connection-form';
import { usePipedreamConnectProject } from '@/hooks/connectors/use-pipedream-connect-project';
import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
import type { ProjectTriggerEventConnector } from '@kortix/sdk';
import { projectTriggerEventAppsKey, qk } from '@kortix/sdk/react';
import { PlusIcon } from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { accountToStore, describeAccount, selectedAccountLabel } from './event-trigger-copy';

/** "Connect another account": asks for a label, then signs in as a new shared account on the connector. */
function ConnectAnotherAccount({
  projectId,
  connector,
  onConnected,
}: {
  projectId: string;
  connector: ProjectTriggerEventConnector;
  onConnected: (label: string) => void;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const refresh = () => {
    const keys = [
      ...connectorConnectionQueryKeys(projectId),
      projectTriggerEventAppsKey(projectId),
      qk.project.triggers(projectId),
    ];
    for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey });
  };
  const connect = usePipedreamConnectProject(projectId, connector.slug, refresh);
  const trimmed = label.trim();
  // The same label would re-point that account instead of adding one.
  const taken = connector.accounts.some((a) => a.label.toLowerCase() === trimmed.toLowerCase());

  if (!open) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="w-fit gap-1.5"
        onClick={() => setOpen(true)}
      >
        <PlusIcon className="size-3.5 shrink-0" />
        {tI18nComplete.raw('text261b28a3c6bf')}
      </Button>
    );
  }
  return (
    <form
      className="space-y-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!trimmed || taken || connect.isPending) return;
        connect.mutate(
          { label: trimmed },
          {
            onSuccess: (result) => {
              if (!result.connected) return;
              setOpen(false);
              setLabel('');
              onConnected(trimmed);
            },
          },
        );
      }}
    >
      <div className="flex items-center gap-2">
        <Input
          value={label}
          autoFocus
          disabled={connect.isPending}
          aria-label={tI18nComplete.raw('text19646ef1ab9d')}
          placeholder={tI18nComplete.raw('text0ade71c64183')}
          onChange={(e) => setLabel(e.target.value)}
        />
        <Button
          type="submit"
          size="sm"
          className="shrink-0 gap-1.5"
          disabled={!trimmed || taken || connect.isPending}
        >
          {connect.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
          {tI18nComplete.raw('text1a2303ede074')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline-ghost"
          disabled={connect.isPending}
          onClick={() => setOpen(false)}
        >
          {tI18nComplete.raw('text19766ed6ccb2')}
        </Button>
      </div>
      {taken ? (
        <p className="text-destructive text-xs">
          {tI18nComplete.raw('texta8f89bda4dfc')}
        </p>
      ) : null}
    </form>
  );
}

/**
 * The shared accounts of one connector as radio rows. `value` is the account a
 * trigger declares (null = the connector default). `onChange` gets the value to
 * store: null for the default, else the label.
 */
export function EventAccountRows({
  projectId,
  connector,
  value,
  onChange,
  canConnect,
  disabled,
  active = true,
}: {
  projectId: string;
  connector: ProjectTriggerEventConnector;
  value: string | null;
  onChange: (account: string | null) => void;
  canConnect: boolean;
  disabled?: boolean;
  /** False when another connector holds the pick: no radio here is checked. */
  active?: boolean;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const selected = active ? (selectedAccountLabel(connector, value) ?? '') : '';
  return (
    <div className="space-y-1.5">
      <RadioGroup
        value={selected}
        onValueChange={(label) => onChange(accountToStore(connector, label))}
        aria-label={tI18nComplete.raw('text7e1b0d5641f2')}
        disabled={disabled}
      >
        {connector.accounts.map((account) => {
          const { title, detail } = describeAccount(account);
          return (
            <RadioGroupItem
              key={account.label}
              value={account.label}
              size="sm"
              variant="outline"
              label={
                <span className="flex flex-wrap items-center gap-2">
                  <span className="truncate">{title}</span>
                  {account.is_default ? (
                    <Badge variant="outline" size="xs">
                      {tI18nComplete.raw('text21b111cbfe6e')}
                    </Badge>
                  ) : null}
                  {account.connected ? null : (
                    <Badge variant="warning" size="xs">
                      {tI18nComplete.raw('text0303e1824670')}
                    </Badge>
                  )}
                </span>
              }
              description={detail ?? undefined}
            />
          );
        })}
      </RadioGroup>
      {canConnect && !disabled ? (
        <ConnectAnotherAccount
          projectId={projectId}
          connector={connector}
          onConnected={(label) => onChange(label)}
        />
      ) : null}
    </div>
  );
}
