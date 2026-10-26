'use client';

import { CaretLeftIcon, CaretRightIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { useTranslations } from '../../../i18n';
import { ComputerCapabilities, ComputerConnectModal, useProjectComputerAccounts } from '../../../internal/tunnel/computer-connect';
import { Button } from '../../../primitives/button';
import { UiLink as Link } from '../../../providers/ui-provider';
import { ChannelHeroFrame, ChannelHeroStatus } from '../../sections/component/channel-hero-frame';
import { ComputerTerminalMock } from '../../sections/component/channel-mocks';
import { connectorHref, connectorsHref } from '../connector-routes';
import { DetailPageShell } from './detail-page-shell';

/** The facts on how a computer connection works, in the order a person asks them. */
const HOW_IT_WORKS = ['computerHow1', 'computerHow2', 'computerHow3', 'computerHow4'] as const;

/**
 * The Computer hero, the same frame as every Kortix channel's: not connected,
 * it pairs this machine (the sidebar's "Connect your computer" flow);
 * connected, it names the machines and opens them. On the Computer page and in
 * the Kortix tab of Connectors.
 */
export function ComputerHero({ projectId }: { projectId: string }) {
  const t = useTranslations('connectorPages');
  const tComputers = useTranslations('computers');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [connectOpen, setConnectOpen] = useState(false);
  const { accounts, connectorAlias } = useProjectComputerAccounts(projectId, { refetchInterval: 15_000 });
  const connected = accounts.length > 0;
  const names = accounts.map((account) => account.label?.trim()).filter(Boolean).join(', ');

  return (
    <>
      <ChannelHeroFrame
        app="computer"
        title={connected ? t('computerConnectedTitle', { count: accounts.length }) : t('computerHeroTitle')}
        lede={t('computerHeroLede')}
        status={connected ? <ChannelHeroStatus label={tI18nComplete.raw('text22965568d22a')} detail={names || null} /> : undefined}
        actions={
          connected ? (
            <>
              <Button size="sm" asChild>
                <Link href={connectorHref(projectId, connectorAlias)}>
                  {t('computerManage')}
                  <CaretRightIcon className="size-3.5 shrink-0" />
                </Link>
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setConnectOpen(true)}>
                {t('computerAddAnother')}
              </Button>
            </>
          ) : (
            <Button className="transition-transform active:scale-96" onClick={() => setConnectOpen(true)}>
              {tComputers('connectYourComputer')}
            </Button>
          )
        }
        preview={<ComputerTerminalMock />}
      />
      <ComputerConnectModal projectId={projectId} open={connectOpen} onOpenChange={setConnectOpen} />
    </>
  );
}

/**
 * `…/connectors/computer?id=native:computer`: the Computer card's page, drawn
 * like a Kortix channel's: the hero, then how it works and what agents may do.
 */
export function ComputerAppPage({ projectId }: { projectId: string }) {
  const t = useTranslations('connectorPages');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');

  return (
    <DetailPageShell>
      <Button asChild variant="text" size="sm" className="-ml-1 w-fit px-0 has-[>svg]:px-0">
        <Link href={connectorsHref(projectId)}>
          <CaretLeftIcon className="size-3.5 shrink-0" />
          {tI18nComplete.raw('textc3d2e79ebdd0')}
        </Link>
      </Button>

      <ComputerHero projectId={projectId} />

      <section className="space-y-3">
        <h2 className="text-foreground text-sm font-medium">{t('computerHowTitle')}</h2>
        <ol className="bg-popover divide-y overflow-hidden rounded-md border">
          {HOW_IT_WORKS.map((key, index) => (
            <li key={key} className="flex gap-3 px-4 py-3">
              <span className="text-muted-foreground w-4 shrink-0 text-sm tabular-nums">{index + 1}</span>
              <p className="text-foreground text-sm text-pretty">{t(key)}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="space-y-3">
        <h2 className="text-foreground text-sm font-medium">{t('computerCanDoTitle')}</h2>
        <div className="bg-popover rounded-md border px-4">
          <ComputerCapabilities />
        </div>
      </section>
    </DetailPageShell>
  );
}
