'use client';

/**
 * Settings › MCP: the page form of `ConnectMcpModal` (KRTX-1997). The modal is
 * reachable only from a dismissible sidebar promo; this page always is.
 *
 * Same facts as the modal, from the same source: the one MCP URL per person
 * (`mcpUrl`), and one row per client with its own one-click action (`CLIENTS`,
 * `ClientAction`). Below them, the MCP clients this person already approved —
 * the same `ConnectedApps` list the Personal access keys pane shows, where it
 * answers "did it work?".
 */

import { useState } from 'react';

import { SettingsRow, SettingsRowGroup } from '@kortix/ui/settings-row';
import { SettingsSubsectionHeader } from '@kortix/ui/settings-subsection-header';
import { Button } from '@kortix/ui/button';
import { Copy } from '@kortix/ui/icons';
import { SolidCheckIcon } from '@kortix/ui/internal/icons/solid-check-icon';
import { CLIENTS, ClientAction, mcpUrl } from '@kortix/ui/internal/layout/connect-mcp-modal';
import { useCopy } from '@kortix/ui/internal/hooks/use-copy';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { getEnv } from '@/lib/env-config';

import { SettingsTabHeader } from '@kortix/ui/customize/settings/settings-tab-header';
import { ConnectedApps } from '@kortix/ui/customize/settings/tabs/connected-apps';
import { localizedRelativeTime } from '@kortix/ui/customize/settings/tabs/tokens-tab';

export function McpTab() {
  const t = useTranslations('settings.mcp');
  const tConnect = useTranslations('connectMcp');
  const locale = useLocale();
  const [renderedAt] = useState(() => Date.now());
  // The button itself confirms the copy; no toast.
  const { copy, copied } = useCopy({ toast: false });
  const url = mcpUrl(getEnv().BACKEND_URL);

  return (
    <div className="mx-auto w-full max-w-2xl space-y-8">
      <SettingsTabHeader tab="mcp" />

      <section className="space-y-3">
        <SettingsSubsectionHeader title={t('serverTitle')} description={t('serverDescription')} />
        <SettingsRowGroup>
          <SettingsRow
            label={t('urlLabel')}
            description={<span className="font-mono break-all">{url}</span>}
          >
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="gap-1.5"
              onClick={() => copy(url)}
            >
              {copied ? <SolidCheckIcon className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied ? tConnect('copied') : tConnect('copyUrl')}
            </Button>
          </SettingsRow>
        </SettingsRowGroup>
      </section>

      <section className="space-y-3">
        <SettingsSubsectionHeader title={t('clientsTitle')} description={t('clientsDescription')} />
        <SettingsRowGroup>
          {CLIENTS.map((client) => (
            <div key={client.id} className="flex items-center gap-3 px-4 py-3">
              <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-sm">
                <client.Logo className="size-5" />
              </span>
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="text-sm font-medium">{client.name ?? tConnect('anyClient')}</p>
                <p className="text-muted-foreground truncate text-xs">
                  {tConnect(`via.${client.id}`)}
                </p>
              </div>
              <ClientAction client={client} url={url} />
            </div>
          ))}
        </SettingsRowGroup>
      </section>

      <ConnectedApps relativeTime={(iso) => localizedRelativeTime(iso, locale, renderedAt)} />
    </div>
  );
}
