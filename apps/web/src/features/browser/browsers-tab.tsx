'use client';

import type { BrowserAccessMode, BrowserTabScope, KortixBrowser } from '@kortix/sdk';
import { useBrowsers, useDeleteBrowser, useUpdateBrowser } from '@kortix/sdk/react';
import { GlobeIcon, PencilSimpleIcon, PlusIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InlineMeta } from '@/components/ui/inline-meta';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
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
} from './browser-connect';

const ACCESS_MODES: readonly BrowserAccessMode[] = ['always', 'ask', 'off'];
const TAB_SCOPES: readonly BrowserTabScope[] = ['own', 'all'];

/**
 * Settings › Browsers: the browsers this person connected with the Kortix
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
            <Button size="sm" variant="secondary" className="gap-1.5" onClick={() => setConnectOpen(true)}>
              <PlusIcon className="size-4 shrink-0" />
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
        <div className="bg-popover flex flex-col gap-5 rounded-md border px-4 py-5">
          <BrowserConnectSteps />
        </div>
      ) : (
        <ul className="space-y-2">
          {list.map((browser) => (
            <BrowserRow key={browser.id} browser={browser} />
          ))}
        </ul>
      )}

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

  const save = (change: { name?: string; accessMode?: BrowserAccessMode; tabScope?: BrowserTabScope }) =>
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
    <li className="bg-popover space-y-3 rounded-md border px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="bg-muted text-foreground flex size-9 shrink-0 items-center justify-center rounded-sm">
          <GlobeIcon className="size-5" />
        </span>
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
            {browser.online ? t('online') : lastSeen ? t('lastSeen', { time: lastSeen }) : t('offline')}
            {sessions > 0 ? t('usedBy', { count: sessions }) : ''}
          </InlineMeta>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(true)}>
          {t('disconnect')}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-2">
          <span className="text-muted-foreground text-xs">{t('access.label')}</span>
          <Select
            value={browser.accessMode}
            disabled={update.isPending}
            onValueChange={(value) => save({ accessMode: value as BrowserAccessMode })}
          >
            <SelectTrigger size="sm" className="w-36 shrink-0" aria-label={t('access.label')}>
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
        </label>
        <label className="flex items-center gap-2">
          <span className="text-muted-foreground text-xs">{t('scope.label')}</span>
          <Select
            value={browser.tabScope}
            disabled={update.isPending}
            onValueChange={(value) => save({ tabScope: value as BrowserTabScope })}
          >
            <SelectTrigger size="sm" className="w-32 shrink-0" aria-label={t('scope.label')}>
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
        </label>
      </div>

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
