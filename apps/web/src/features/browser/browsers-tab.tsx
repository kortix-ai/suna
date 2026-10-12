'use client';

import type { BrowserAccessMode, BrowserTabScope, KortixBrowser } from '@kortix/sdk';
import { useBrowsers, useDeleteBrowser, useUpdateBrowser } from '@kortix/sdk/react';
import { PencilSimpleIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InlineMeta } from '@/components/ui/inline-meta';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingsRow, SettingsRowGroup } from '@/components/ui/settings-row';
import { SettingsSubsectionHeader } from '@/components/ui/settings-subsection-header';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { ErrorState } from '@/features/layout/section/error-state';
import { SettingsTabHeader } from '@/features/workspace/settings/settings-tab-header';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { relativeTime } from '@/lib/relative-time';
import {
  BrowserConnectModal,
  BrowserConnectSteps,
  BrowserOnlineDot,
  ChromeButtonMark,
} from './browser-connect';
import { BrowserLogoTile } from './browser-icon';
import { BrowserMock } from './browser-mock';

const ACCESS_MODES: readonly BrowserAccessMode[] = ['always', 'ask', 'off'];
// `all` first: it is the recommended default.
const TAB_SCOPES: readonly BrowserTabScope[] = ['all', 'own'];

/**
 * Settings › Chrome extension: the browsers this person connected with the Kortix
 * extension. With none, the three connect steps stand inline.
 */
export function BrowsersTab() {
  const t = useTranslations('browsers');
  const browsers = useBrowsers();
  const [connectOpen, setConnectOpen] = useState(false);
  const list = browsers.data ?? [];

  return (
    // `max-w-2xl`: the form tier every person-scoped pane in this dialog uses.
    <div className="mx-auto w-full max-w-2xl space-y-5">
      <SettingsTabHeader
        tab="browsers"
        action={
          list.length > 0 ? (
            <Button
              size="sm"
              variant="secondary"
              className="gap-1.5"
              onClick={() => setConnectOpen(true)}
            >
              <ChromeButtonMark />
              {t('connectAnother')}
            </Button>
          ) : undefined
        }
      />

      {browsers.isPending ? (
        <div className="space-y-2">
          <Skeleton className="h-24 rounded-md" />
        </div>
      ) : browsers.isError ? (
        <ErrorState
          size="sm"
          title={t('loadFailed')}
          action={
            <Button variant="outline" size="sm" onClick={() => browsers.refetch()}>
              {t('retry')}
            </Button>
          }
        />
      ) : list.length === 0 ? (
        <div className="space-y-4">
          <BrowserMock className="mx-auto max-w-md" />
          <div className="bg-popover flex flex-col gap-5 rounded-md border px-4 py-5">
            <BrowserConnectSteps />
          </div>
        </div>
      ) : (
        <section className="space-y-3">
          <SettingsSubsectionHeader title={t('listTitle')} />
          <ul className="space-y-3">
            {list.map((browser) => (
              <BrowserRow key={browser.id} browser={browser} />
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-2">
        <SettingsSubsectionHeader title={t('how.title')} />
        <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-sm text-pretty">
          <li>{t('how.group')}</li>
          <li>{t('how.control')}</li>
          <li>{t('how.own')}</li>
        </ul>
      </section>

      <BrowserConnectModal open={connectOpen} onOpenChange={setConnectOpen} />
    </div>
  );
}

function BrowserRow({ browser }: { browser: KortixBrowser }) {
  const t = useTranslations('browsers');
  const locale = useLocale();
  const update = useUpdateBrowser();
  const remove = useDeleteBrowser();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);

  const save = (change: {
    name?: string;
    accessMode?: BrowserAccessMode;
    tabScope?: BrowserTabScope;
  }) =>
    update.mutate({ id: browser.id, ...change }, { onError: () => errorToast(t('updateFailed')) });

  const commitName = () => {
    const name = draft?.trim();
    setDraft(null);
    if (name && name !== browser.name) save({ name });
  };

  const sessions = browser.activeSessions.length;
  const lastSeen = browser.lastSeenAt ? relativeTime(browser.lastSeenAt, locale) : '';
  const maker = [browser.brand, browser.os].filter(Boolean).join(' · ');

  return (
    <li>
      <SettingsRowGroup>
        <div className="flex items-center gap-3 px-4 py-3">
          <BrowserLogoTile brand={browser.brand} />
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex items-center gap-2">
              <BrowserOnlineDot online={browser.online} />
              {draft === null ? (
                <button
                  type="button"
                  aria-label={t('rename', { name: browser.name })}
                  className="group/name flex min-w-0 items-center gap-1.5 text-left"
                  onClick={() => setDraft(browser.name)}
                >
                  <span className="truncate text-sm font-medium">{browser.name}</span>
                  <PencilSimpleIcon className="text-muted-foreground size-3.5 shrink-0" />
                </button>
              ) : (
                <Input
                  autoFocus
                  value={draft}
                  maxLength={255}
                  aria-label={t('renameLabel')}
                  className="h-7"
                  onChange={(event) => setDraft(event.target.value)}
                  onBlur={commitName}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitName();
                    if (event.key === 'Escape') setDraft(null);
                  }}
                />
              )}
            </div>
            <InlineMeta>
              {maker}
              {browser.online
                ? t('online')
                : lastSeen
                  ? t('lastSeen', { time: lastSeen })
                  : t('offline')}
              {sessions > 0 ? t('usedBy', { count: sessions }) : ''}
            </InlineMeta>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(true)}>
            {t('disconnect')}
          </Button>
        </div>

        <SettingsRow label={t('access.label')} description={t('access.description')}>
          <Select
            value={browser.accessMode}
            disabled={update.isPending}
            onValueChange={(value) => save({ accessMode: value as BrowserAccessMode })}
          >
            <SelectTrigger size="sm" className="w-44" aria-label={t('access.label')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACCESS_MODES.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {t(`access.${mode}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow label={t('scope.label')} description={t('scope.description')}>
          <Select
            value={browser.tabScope}
            disabled={update.isPending}
            onValueChange={(value) => save({ tabScope: value as BrowserTabScope })}
          >
            <SelectTrigger size="sm" className="w-44" aria-label={t('scope.label')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TAB_SCOPES.map((scope) => (
                <SelectItem key={scope} value={scope}>
                  {t(`scope.${scope}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsRowGroup>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('disconnectTitle', { name: browser.name })}
        description={t('disconnectDescription')}
        confirmLabel={t('disconnect')}
        confirmVariant="destructive"
        isPending={remove.isPending}
        onConfirm={() =>
          remove.mutate(browser.id, {
            onSuccess: () => {
              setConfirmOpen(false);
              successToast(t('disconnected'));
            },
            onError: () => errorToast(t('disconnectFailed')),
          })
        }
      />
    </li>
  );
}
