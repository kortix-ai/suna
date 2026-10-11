'use client';

import { InfoIcon } from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { useTranslations } from '@/i18n/use-translations';

/** The Provider value: Kortix for a managed app, else the app itself. */
export function providerName(appName: string, managedBy: string | null): string {
  return managedBy ? 'Kortix' : appName;
}

/**
 * The info button on the Provider label that explains who manages what.
 *
 * Managed (Composio, Pipedream): Kortix holds the login through the provider,
 * and the app runs the actions. Direct (MCP, OpenAPI, …): agents call the app
 * itself, and Kortix attaches the stored credential to each call.
 */
export function ProviderInfo({
  appName,
  managedBy,
}: {
  appName: string;
  /** The managed provider's name ("Composio"), or `null` for a direct app. */
  managedBy: string | null;
}) {
  const t = useTranslations('connectorPages');
  const rows = managedBy
    ? [
        [t('providerInfoLogin'), t('providerInfoLoginManaged', { provider: managedBy })],
        [t('providerInfoActions'), t('providerInfoActionsApp', { name: appName })],
        [t('providerInfoSecrets'), t('providerInfoSecretsManaged')],
      ]
    : [
        [t('providerInfoLogin'), t('providerInfoLoginDirect')],
        [t('providerInfoActions'), t('providerInfoActionsApp', { name: appName })],
        [t('providerInfoSecrets'), t('providerInfoSecretsDirect')],
      ];

  return (
    <HoverCard openDelay={150}>
      <HoverCardTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground"
          aria-label={t('providerInfoLabel')}
        >
          <InfoIcon className="size-3.5" />
        </Button>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-72 space-y-3 p-4">
        <p className="text-foreground text-sm font-medium">{t('providerInfoTitle')}</p>
        <dl className="space-y-2">
          {rows.map(([label, value]) => (
            <div key={label} className="space-y-0.5">
              <dt className="text-foreground text-xs font-medium">{label}</dt>
              <dd className="text-muted-foreground text-xs text-pretty">{value}</dd>
            </div>
          ))}
        </dl>
      </HoverCardContent>
    </HoverCard>
  );
}
