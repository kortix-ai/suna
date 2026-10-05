'use client';

import type { CaptureAskInput, CaptureAskSource } from '@kortix/sdk';
import { useCaptureAsk, useCaptureDevices, useCaptureEpisode } from '@kortix/sdk/react';
import { ArrowUpIcon, CaretDownIcon, CheckIcon, PlusIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { InfoBanner } from '@/components/ui/info-banner';
import Loading from '@/components/ui/loading';
import { Textarea, type AutosizeTextAreaRef } from '@/components/ui/textarea';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';

import {
  captureHref,
  deviceName,
  useCaptureArea,
  useCaptureDirectory,
} from '../area/use-capture-area';

type Scope =
  | { kind: 'org' }
  | { kind: 'me' }
  | { kind: 'person'; userId: string }
  | { kind: 'device'; deviceId: string };

/**
 * Ask (`/capture/[accountId]/ask`): questions about recorded work, answered
 * with citations to workflows, episodes and moments. The answer streams; each
 * `[n]` selects its source on the right, and a source opens its workflow or
 * the device timeline at its moment. Admins and viewers ask about the whole
 * organization, a person or a computer; a member asks about their own work.
 */
export function AskView({ accountId }: { accountId: string }) {
  const t = useTranslations('capture.ask');
  const area = useCaptureArea(accountId);
  const directory = useCaptureDirectory(accountId, true);
  const devices = useCaptureDevices(accountId, { scope: area.readsEveryone ? 'account' : 'mine' });
  const [scope, setScope] = useState<Scope>({ kind: 'org' });
  const effective: Scope = !area.readsEveryone && scope.kind !== 'device' ? { kind: 'me' } : scope;
  const askScope = useMemo<CaptureAskInput['scope']>(() => {
    if (effective.kind === 'me')
      return directory.viewerId ? { user_id: directory.viewerId } : undefined;
    if (effective.kind === 'person') return { user_id: effective.userId };
    if (effective.kind === 'device') return { device_id: effective.deviceId };
    return undefined;
  }, [effective, directory.viewerId]);
  const ask = useCaptureAsk(accountId, askScope);
  const [draft, setDraft] = useState('');
  const [selected, setSelected] = useState<{ turn: number; n: number } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<AutosizeTextAreaRef>(null);
  const lastAnswer = ask.turns[ask.turns.length - 1]?.answer;
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [ask.turns.length, lastAnswer]);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const allDevices = (devices.data?.devices ?? []).filter((d) => !d.revoked_at);
  const scopeLabel =
    effective.kind === 'org'
      ? t('scope.org', { name: area.accountName })
      : effective.kind === 'me'
        ? t('scope.me')
        : effective.kind === 'person'
          ? t('scope.person', { name: directory.personOf(effective.userId).email ?? t('aMember') })
          : t('scope.device', {
              name: deviceName(
                allDevices.find((d) => d.device_id === effective.deviceId) ?? {
                  name: null,
                  os: null,
                },
                t('unnamed'),
              ),
            });
  const send = () => {
    const question = draft.trim();
    if (!question || ask.streaming) return;
    setDraft('');
    setSelected(null);
    void ask.ask(question);
  };
  const current = selected ?? (ask.turns.length ? { turn: ask.turns.length - 1, n: -1 } : null);
  const turn = current ? ask.turns[current.turn] : undefined;
  const sources = turn ? (turn.citations.length ? turn.citations : turn.sources) : [];

  return (
    <main className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[14rem_minmax(0,1fr)_22rem]">
      <nav
        aria-label={t('questions')}
        className="bg-popover flex flex-col gap-2 border-r px-3 py-4 max-lg:hidden"
      >
        <Button
          variant="outline"
          size="sm"
          className="justify-start gap-1.5"
          onClick={() => {
            ask.reset();
            setSelected(null);
            inputRef.current?.focus();
          }}
        >
          <PlusIcon className="size-3.5 shrink-0" />
          {t('newQuestion')}
        </Button>
        {ask.turns.length > 0 ? (
          <>
            <p className="text-muted-foreground px-2 pt-3 text-xs">{t('thisConversation')}</p>
            <ul className="flex flex-col gap-0.5">
              {ask.turns.map((item, i) => (
                <li key={i}>
                  <a
                    href={`#capture-turn-${i}`}
                    className="hover:bg-hover text-foreground block truncate rounded-sm px-2 py-1.5 text-sm transition-colors"
                  >
                    {item.question}
                  </a>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </nav>

      <section
        aria-label={t('conversation')}
        className="flex min-h-[calc(100svh-3.5rem)] min-w-0 flex-col"
      >
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8">
          <div className="mx-auto flex max-w-3xl flex-col gap-8">
            {ask.turns.length === 0 ? (
              <div className="flex flex-col gap-4 pt-10">
                <h1 className="text-foreground text-xl font-medium">{t('title')}</h1>
                <p className="text-muted-foreground text-sm text-pretty">{t('intro')}</p>
                <div className="flex flex-col gap-2">
                  {(area.readsEveryone
                    ? ['example1', 'example2', 'example3']
                    : ['exampleMine1', 'exampleMine2']
                  ).map((key) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => {
                        setDraft(t(key));
                        inputRef.current?.focus();
                      }}
                      className="bg-background hover:bg-hover text-foreground rounded-md border px-4 py-2.5 text-left text-sm transition-colors"
                    >
                      {t(key)}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              ask.turns.map((item, i) => (
                <article
                  key={i}
                  id={`capture-turn-${i}`}
                  className="flex scroll-mt-4 flex-col gap-3"
                >
                  <p className="bg-muted text-foreground self-end rounded-md px-4 py-2.5 text-sm">
                    {item.question}
                  </p>
                  {item.status === 'error' ? (
                    <InfoBanner tone="destructive" title={t('failed')}>
                      <span className="text-sm wrap-anywhere">{item.error}</span>
                    </InfoBanner>
                  ) : item.answer ? (
                    <Answer
                      text={item.answer}
                      selected={current?.turn === i ? current.n : -1}
                      onCite={(n) => setSelected({ turn: i, n })}
                    />
                  ) : (
                    <p
                      className="text-muted-foreground flex items-center gap-2 text-sm"
                      role="status"
                    >
                      <Loading className="size-4 shrink-0" />
                      {item.sources.length
                        ? t('writing', { count: item.sources.length })
                        : t('searching')}
                    </p>
                  )}
                  {item.status === 'done' ? (
                    <p className="text-muted-foreground text-xs">
                      {t('cited', { count: item.citations.length })}
                    </p>
                  ) : null}
                </article>
              ))
            )}
            <div ref={endRef} />
          </div>
        </div>

        <form
          className="bg-background sticky bottom-0 border-t px-4 py-3 sm:px-8"
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <div className="bg-popover mx-auto flex max-w-3xl flex-col gap-2 rounded-md border px-3 py-2">
            <label htmlFor="capture-ask" className="sr-only">
              {t('label')}
            </label>
            <Textarea
              id="capture-ask"
              ref={inputRef}
              maxHeight={200}
              minHeight={48}
              value={draft}
              placeholder={t('placeholder')}
              className="min-h-12 resize-none border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  send();
                }
              }}
            />
            <div className="flex items-center justify-between gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground min-w-0 gap-1.5"
                  >
                    <span className="truncate">{t('answerFrom', { scope: scopeLabel })}</span>
                    <CaretDownIcon className="size-3 shrink-0" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-72">
                  {area.readsEveryone ? (
                    <>
                      <ScopeItem
                        on={effective.kind === 'org'}
                        onSelect={() => setScope({ kind: 'org' })}
                      >
                        {t('scope.org', { name: area.accountName })}
                      </ScopeItem>
                      <ScopeItem
                        on={effective.kind === 'me'}
                        onSelect={() => setScope({ kind: 'me' })}
                      >
                        {t('scope.me')}
                      </ScopeItem>
                      {directory.members.filter((m) => m.user_id !== directory.viewerId).length >
                      0 ? (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuLabel>{t('scope.people')}</DropdownMenuLabel>
                          {directory.members
                            .filter((m) => m.user_id !== directory.viewerId)
                            .map((m) => (
                              <ScopeItem
                                key={m.user_id}
                                on={effective.kind === 'person' && effective.userId === m.user_id}
                                onSelect={() => setScope({ kind: 'person', userId: m.user_id })}
                              >
                                {m.email ?? m.user_id}
                              </ScopeItem>
                            ))}
                        </>
                      ) : null}
                    </>
                  ) : (
                    <ScopeItem
                      on={effective.kind === 'me'}
                      onSelect={() => setScope({ kind: 'me' })}
                    >
                      {t('scope.me')}
                    </ScopeItem>
                  )}
                  {allDevices.length > 0 ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel>{t('scope.devices')}</DropdownMenuLabel>
                      {allDevices.map((d) => (
                        <ScopeItem
                          key={d.device_id}
                          on={effective.kind === 'device' && effective.deviceId === d.device_id}
                          onSelect={() => setScope({ kind: 'device', deviceId: d.device_id })}
                        >
                          {deviceName(d, t('unnamed'))}
                        </ScopeItem>
                      ))}
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                type="submit"
                size="icon-sm"
                aria-label={t('send')}
                disabled={!draft.trim() || ask.streaming}
              >
                {ask.streaming ? (
                  <Loading className="size-3.5 shrink-0" />
                ) : (
                  <ArrowUpIcon className="size-3.5 shrink-0" />
                )}
              </Button>
            </div>
          </div>
        </form>
      </section>

      <aside
        aria-labelledby="capture-sources"
        className="bg-popover flex min-w-0 flex-col border-l max-lg:border-t max-lg:border-l-0"
      >
        <div className="flex items-baseline justify-between px-4 pt-4 pb-3">
          <h2 id="capture-sources" className="text-foreground text-sm font-medium">
            {t('sources')}
          </h2>
          {sources.length ? (
            <span className="text-muted-foreground text-xs tabular-nums">
              {t('sourcesCount', { count: sources.length })}
            </span>
          ) : null}
        </div>
        {sources.length === 0 ? (
          <p className="text-muted-foreground px-4 pb-4 text-xs">{t('sourcesEmpty')}</p>
        ) : (
          <ol className="flex flex-col gap-0.5 px-2 pb-4">
            {sources.map((source) => (
              <SourceRow
                key={source.n}
                accountId={accountId}
                source={source}
                selected={current?.n === source.n}
                onSelect={() => current && setSelected({ turn: current.turn, n: source.n })}
              />
            ))}
          </ol>
        )}
      </aside>
    </main>
  );
}

function ScopeItem({
  on,
  onSelect,
  children,
}: {
  on: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <DropdownMenuItem onSelect={onSelect}>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {on ? <CheckIcon className="size-3.5 shrink-0" /> : null}
    </DropdownMenuItem>
  );
}

/** The answer's paragraphs, each `[n]` a button that selects its source. */
function Answer({
  text,
  selected,
  onCite,
}: {
  text: string;
  selected: number;
  onCite: (n: number) => void;
}) {
  const t = useTranslations('capture.ask');
  return (
    <div className="text-foreground flex flex-col gap-3 text-sm leading-relaxed">
      {text.split(/\n{2,}/).map((paragraph, p) => (
        <p key={p} className="text-pretty whitespace-pre-wrap">
          {paragraph.split(/(\[\d+\])/g).map((part, i) => {
            const match = /^\[(\d+)\]$/.exec(part);
            if (!match) return <Fragment key={i}>{part}</Fragment>;
            const n = Number(match[1]);
            return (
              <button
                key={i}
                type="button"
                aria-label={t('citation', { n })}
                aria-pressed={selected === n}
                onClick={() => onCite(n)}
                className={cn(
                  'mx-0.5 inline-flex h-4.5 min-w-5 items-center justify-center rounded-sm px-1 align-baseline font-mono text-xs transition-colors',
                  selected === n
                    ? 'bg-foreground text-background'
                    : 'bg-muted text-foreground hover:bg-foreground/15',
                )}
              >
                {n}
              </button>
            );
          })}
        </p>
      ))}
    </div>
  );
}

function SourceRow({
  accountId,
  source,
  selected,
  onSelect,
}: {
  accountId: string;
  source: CaptureAskSource;
  selected: boolean;
  onSelect: () => void;
}) {
  const t = useTranslations('capture.ask');
  const locale = useLocale();
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  // An episode source names no device: read the episode once it is selected.
  const episode = useCaptureEpisode(
    accountId,
    source.kind === 'episode' && selected ? source.episode_id : null,
  );
  const href =
    source.kind === 'workflow'
      ? captureHref(accountId, 'workflows', `/${source.workflow_id}`)
      : source.kind === 'moment'
        ? captureHref(
            accountId,
            'devices',
            `/${source.device_id}?at=${encodeURIComponent(source.ts)}`,
          )
        : episode.data?.device_id
          ? captureHref(
              accountId,
              'devices',
              `/${episode.data.device_id}?at=${encodeURIComponent(episode.data.start_at)}`,
            )
          : null;
  const when =
    source.kind === 'moment'
      ? new Date(source.ts).toLocaleString(locale, {
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      : source.kind === 'episode'
        ? new Date(source.start_at).toLocaleString(locale, {
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
          })
        : null;
  return (
    <li ref={ref}>
      <div
        className={cn(
          'flex gap-3 rounded-md px-2 py-2.5 transition-colors',
          selected ? 'bg-active' : 'hover:bg-hover',
        )}
      >
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={selected}
          aria-label={t('citation', { n: source.n })}
          className={cn(
            'flex size-5 shrink-0 items-center justify-center rounded-sm font-mono text-xs',
            selected ? 'bg-foreground text-background' : 'bg-muted text-foreground',
          )}
        >
          {source.n}
        </button>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-muted-foreground text-xs">
            {t(`kind.${source.kind}`)}
            {when ? ` · ${when}` : ''}
          </span>
          <button
            type="button"
            onClick={onSelect}
            className="text-foreground text-left text-sm font-medium"
          >
            {source.label}
          </button>
          {source.detail ? (
            <span className="text-muted-foreground text-xs text-pretty">{source.detail}</span>
          ) : null}
          {selected ? (
            href ? (
              <Link
                href={href}
                className="text-foreground mt-1 text-xs font-medium underline-offset-4 hover:underline"
              >
                {source.kind === 'workflow' ? t('openWorkflow') : t('openTimeline')}
              </Link>
            ) : episode.isLoading ? (
              <Loading className="mt-1 size-3.5 shrink-0" />
            ) : null
          ) : null}
        </div>
      </div>
    </li>
  );
}
