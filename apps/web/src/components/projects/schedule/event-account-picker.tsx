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
import { cn } from '@/lib/utils';
import type { ProjectTriggerEventConnector } from '@kortix/sdk';
import { projectTriggerEventAppsKey, qk } from '@kortix/sdk/react';
import { PlusIcon } from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { accountToStore, selectedAccountLabel } from './event-trigger-copy';

/** "Connect another account": asks for a label, then signs in as a new shared account on the connector. */
function ConnectAnotherAccount({
  projectId,
  connector,
  first = false,
  onConnected,
}: {
  projectId: string;
  connector: ProjectTriggerEventConnector;
  /** The connector has no account yet: the button says "Connect an account". */
  first?: boolean;
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
        {first ? tI18nComplete.raw('textefeac437f989') : tI18nComplete.raw('text261b28a3c6bf')}
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
        <p className="text-destructive text-xs">{tI18nComplete.raw('texta8f89bda4dfc')}</p>
      ) : null}
    </form>
  );
}

/** Sentence-case status chip: the badge's mono uppercase reads as code, not status. */
const STATUS_BADGE = 'font-sans normal-case';

/**
 * The shared accounts of ONE connector (profile) as radio rows. `value` is the
 * account a trigger declares (null = the connector default, which is selected
 * when none is chosen). `onChange` gets the value to store: null for the
 * default, else the label. A connector with no account shows one line and
 * "Connect an account", never an empty list.
 */
export function EventAccountRows({
  projectId,
  connector,
  value,
  onChange,
  canConnect,
  disabled,
}: {
  projectId: string;
  connector: ProjectTriggerEventConnector;
  value: string | null;
  onChange: (account: string | null) => void;
  canConnect: boolean;
  disabled?: boolean;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const selected = selectedAccountLabel(connector, value) ?? '';
  const connectButton =
    canConnect && !disabled ? (
      <ConnectAnotherAccount
        projectId={projectId}
        connector={connector}
        first={connector.accounts.length === 0}
        onConnected={(label) => onChange(label)}
      />
    ) : null;
  if (connector.accounts.length === 0) {
    return (
      <div className="space-y-1.5">
        <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
          {tI18nComplete('textf4d17716fd3b', { name: connector.name })}
        </p>
        {connectButton}
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <RadioGroup
        value={selected}
        onValueChange={(label) => onChange(accountToStore(connector, label))}
        aria-label={tI18nComplete.raw('text7e1b0d5641f2')}
        disabled={disabled}
      >
        {connector.accounts.map((account) => {
          const identity = account.connected_as?.trim();
          return (
            <RadioGroupItem
              key={account.label}
              value={account.label}
              size="sm"
              variant="outline"
              label={
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate">{account.label}</span>
                  {account.is_default ? (
                    <Badge variant="outline" size="xs" className={STATUS_BADGE}>
                      {tI18nComplete.raw('text21b111cbfe6e')}
                    </Badge>
                  ) : null}
                  <Badge
                    variant={account.connected ? 'success' : 'outline'}
                    size="xs"
                    className={cn(STATUS_BADGE, 'ml-auto')}
                  >
                    {account.connected
                      ? tI18nComplete.raw('text22965568d22a')
                      : tI18nComplete.raw('text0303e1824670')}
                  </Badge>
                </span>
              }
              description={identity && identity !== account.label ? identity : undefined}
            />
          );
        })}
      </RadioGroup>
      {connectButton}
    </div>
  );
}
