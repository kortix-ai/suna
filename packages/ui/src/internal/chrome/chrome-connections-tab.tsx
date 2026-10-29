'use client';

import type { ChromeAccessMode, ChromeTabScope, ChromeConnection } from '@kortix/sdk';
import { useChromeConnections, useDeleteChromeConnection, useUpdateChromeConnection } from '@kortix/sdk/react';
import { PencilSimpleIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { Button } from '../../primitives/button';
import { ConfirmDialog } from '../../primitives/confirm-dialog';
import { InlineMeta } from '../../primitives/inline-meta';
import { Input } from '../../primitives/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../primitives/select';
import { SettingsRow, SettingsRowGroup } from '../../primitives/settings-row';
import { SettingsSubsectionHeader } from '../../primitives/settings-subsection-header';
import { Skeleton } from '../../primitives/skeleton';
import { errorToast, successToast } from '../../primitives/toast';
import { ErrorState } from '../../primitives/error-state';
import { SettingsTabHeader } from '../../customize/settings/settings-tab-header';
import { useLocale, useTranslations } from '../../i18n';
import { relativeTime } from '../lib/relative-time';
import {
  ChromeButtonMark,
  ChromeConnectModal,
  ChromeConnectSteps,
  ChromeCopyLink,
  ChromeInstallActions,
  ChromeOnlineDot,
  useChromeConnect,
} from './chrome-connect';
import { BrowserLogoTile } from './browser-icon';
import { chromeDisplayNames, offlineLongerThan } from './chrome-names';
import { ChromeMock } from './chrome-mock';

const ACCESS_MODES: readonly ChromeAccessMode[] = ['always', 'ask', 'off'];
// `all` first: it is the recommended default.
const TAB_SCOPES: readonly ChromeTabScope[] = ['all', 'own'];

/** Offline longer than this shows when the browser was last seen. Shorter is just "Offline". */
const LAST_SEEN_AFTER_MS = 10 * 60_000;

/**
 * Settings → Kortix in Chrome: the browsers this person connected with the
 * Kortix extension. With none, the three connect steps stand inline and the
 * connect action sits in the page header.
 */
export function ChromeConnectionsTab() {
  const t = useTranslations('chrome');
  const connections = useChromeConnections();
  const [connectOpen, setConnectOpen] = useState(false);
  const list = connections.data ?? [];

  if (connections.isSuccess && list.length === 0) return <ChromeEmptyTab />;

  const names = chromeDisplayNames(list);
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
      ) : (
        <>
          <section className="space-y-3">
            <SettingsSubsectionHeader title={t('listTitle')} />
            <ul className="space-y-3">
              {list.map((chrome) => (
                <ChromeRow key={chrome.id} chrome={chrome} displayName={names.get(chrome.id) ?? chrome.name} />
              ))}
            </ul>
          </section>

          <section className="space-y-2">
            <SettingsSubsectionHeader title={t('how.title')} />
            <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-sm text-pretty">
              <li>{t('how.group')}</li>
              <li>{t('how.control')}</li>
              <li>{t('how.own')}</li>
            </ul>
          </section>
        </>
      )}

      <ChromeConnectModal open={connectOpen} onOpenChange={setConnectOpen} fresh />
    </div>
  );
}

/** No browser yet: the steps stand inline, the one action is in the header. */
function ChromeEmptyTab() {
  const state = useChromeConnect();
  return (
    <div className="mx-auto w-full max-w-2xl space-y-5">
      <SettingsTabHeader
        tab="chrome"
        action={
          state.environment === 'unsupported' ? (
            <ChromeCopyLink />
          ) : (
            <ChromeInstallActions state={state} showGuide={false} />
          )
        }
      />
      <div className="space-y-4">
        <ChromeMock className="mx-auto max-w-md" />
        <div className="bg-popover flex flex-col gap-5 rounded-md border px-4 py-5">
          <ChromeConnectSteps state={state} showActions={false} />
        </div>
      </div>
    </div>
  );
}

/** "Chromium on macOS · Work · v1.0.0": what tells two browsers apart. The name is not repeated. */
function chromeMeta(chrome: ChromeConnection, displayName: string): string[] {
  // The profile label already sits in the display name of a duplicate: say it once.
  const profile = chrome.profileLabel && !displayName.includes(chrome.profileLabel) ? chrome.profileLabel : null;
  return [profile, chrome.extensionVersion ? `v${chrome.extensionVersion}` : null].filter(
    (part): part is string => Boolean(part),
  );
}

function ChromeRow({ chrome, displayName }: { chrome: ChromeConnection; displayName: string }) {
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
    // An empty name is not a name: keep the field open and flag it. Blur reverts.
    if (!name) return false;
    setDraft(null);
    if (name !== chrome.name) save({ name });
    return true;
  };

  const sessions = chrome.activeSessions.length;
  // "Last seen just now" beside "Offline" contradicts itself: say it only once it is a while ago.
  const longOffline = !chrome.online && offlineLongerThan(chrome.lastSeenAt, LAST_SEEN_AFTER_MS);
  const status = chrome.online
    ? t('online')
    : longOffline
      ? t('lastSeen', { time: relativeTime(chrome.lastSeenAt as string, locale) })
      : t('offline');
  const meta = [...chromeMeta(chrome, displayName), status];

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
                  aria-label={t('rename', { name: displayName })}
                  title={displayName}
                  className="focus-visible:ring-ring/50 -mx-1 flex min-w-0 items-center gap-1.5 rounded-sm px-1 text-left outline-none focus-visible:ring-3"
                  onClick={() => setDraft(chrome.name)}
                >
                  <span className="truncate text-sm font-medium">{displayName}</span>
                  <PencilSimpleIcon className="text-muted-foreground size-3.5 shrink-0" />
                </button>
              ) : (
                <Input
                  autoFocus
                  value={draft}
                  maxLength={255}
                  aria-label={t('renameLabel')}
                  className="h-6 py-0"
                  aria-invalid={draft.trim() === '' ? true : undefined}
                  onChange={(event) => setDraft(event.target.value)}
                  onBlur={() => {
                    if (!commitName()) setDraft(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitName();
                    // Closes the field only. The settings dialog ignores Escape from a text field.
                    if (event.key === 'Escape') setDraft(null);
                  }}
                />
              )}
            </div>
            <InlineMeta>
              {meta}
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
        title={t('disconnectTitle', { name: displayName })}
        description={
          <>
            <span className="text-muted-foreground mb-2 block text-xs">{meta.join(' · ')}</span>
            {t('disconnectDescription')}
          </>
        }
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
