'use client';

import type { ChromeAccessMode, ChromeTabScope, ChromeConnection } from '@kortix/sdk';
import { useChromeConnections, useDeleteChromeConnection, useUpdateChromeConnection } from '@kortix/sdk/react';
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
  ChromeConnectModal,
  ChromeConnectSteps,
  ChromeOnlineDot,
  ChromeButtonMark,
} from './chrome-connect';
import { BrowserLogoTile } from './browser-icon';
import { ChromeMock } from './chrome-mock';

const ACCESS_MODES: readonly ChromeAccessMode[] = ['always', 'ask', 'off'];
// `all` first: it is the recommended default.
const TAB_SCOPES: readonly ChromeTabScope[] = ['all', 'own'];

/**
 * Settings › Chrome extension: the browsers this person connected with the Kortix
 * extension. With none, the three connect steps stand inline.
 */
export function ChromeConnectionsTab() {
  const t = useTranslations('chrome');
  const connections = useChromeConnections();
  const [connectOpen, setConnectOpen] = useState(false);
  const list = connections.data ?? [];

  return (
    // `max-w-2xl`: the form tier every person-scoped pane in this dialog uses.
    <div className="mx-auto w-full max-w-2xl space-y-5">
      <SettingsTabHeader
        tab="chrome"
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

      {connections.isPending ? (
        <div className="space-y-2">
          <Skeleton className="h-24 rounded-md" />
        </div>
      ) : connections.isError ? (
        <ErrorState
          size="sm"
          title={t('loadFailed')}
          action={
            <Button variant="outline" size="sm" onClick={() => connections.refetch()}>
              {t('retry')}
            </Button>
          }
        />
      ) : list.length === 0 ? (
        <div className="space-y-4">
          <ChromeMock className="mx-auto max-w-md" />
          <div className="bg-popover flex flex-col gap-5 rounded-md border px-4 py-5">
            <ChromeConnectSteps />
          </div>
        </div>
      ) : (
        <section className="space-y-3">
          <SettingsSubsectionHeader title={t('listTitle')} />
          <ul className="space-y-3">
            {list.map((chrome) => (
              <ChromeRow key={chrome.id} chrome={chrome} />
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

      <ChromeConnectModal open={connectOpen} onOpenChange={setConnectOpen} />
    </div>
  );
}

function ChromeRow({ chrome }: { chrome: ChromeConnection }) {
  const t = useTranslations('chrome');
  const locale = useLocale();
  const update = useUpdateChromeConnection();
  const remove = useDeleteChromeConnection();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);

  const save = (change: {
    name?: string;
    accessMode?: ChromeAccessMode;
    tabScope?: ChromeTabScope;
  }) =>
    update.mutate({ id: chrome.id, ...change }, { onError: () => errorToast(t('updateFailed')) });

  const commitName = () => {
    const name = draft?.trim();
    setDraft(null);
    if (name && name !== chrome.name) save({ name });
  };

  const sessions = chrome.activeSessions.length;
  const lastSeen = chrome.lastSeenAt ? relativeTime(chrome.lastSeenAt, locale) : '';
  const maker = [chrome.brand, chrome.os].filter(Boolean).join(' · ');

  return (
    <li>
      <SettingsRowGroup>
        <div className="flex items-center gap-3 px-4 py-3">
          <BrowserLogoTile brand={chrome.brand} />
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex items-center gap-2">
              <ChromeOnlineDot online={chrome.online} />
              {draft === null ? (
                <button
                  type="button"
                  aria-label={t('rename', { name: chrome.name })}
                  className="group/name flex min-w-0 items-center gap-1.5 text-left"
                  onClick={() => setDraft(chrome.name)}
                >
                  <span className="truncate text-sm font-medium">{chrome.name}</span>
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
              {chrome.online
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
            value={chrome.accessMode}
            disabled={update.isPending}
            onValueChange={(value) => save({ accessMode: value as ChromeAccessMode })}
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
            value={chrome.tabScope}
            disabled={update.isPending}
            onValueChange={(value) => save({ tabScope: value as ChromeTabScope })}
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
        title={t('disconnectTitle', { name: chrome.name })}
        description={t('disconnectDescription')}
        confirmLabel={t('disconnect')}
        confirmVariant="destructive"
        isPending={remove.isPending}
        onConfirm={() =>
          remove.mutate(chrome.id, {
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
