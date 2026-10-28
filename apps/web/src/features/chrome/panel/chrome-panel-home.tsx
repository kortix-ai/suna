'use client';

/**
 * `/panel`: the new chat in the Kortix in Chrome side panel. It opens fresh
 * every time. The person picks a project, the active tab rides along as a
 * chip, and Send hands the prompt to that project's home composer, which
 * sends it exactly like a typed message (agent, model, billing gate) and opens
 * the session in the panel. Read attaches the page text; Act hands the tab to
 * the session's Kortix tab group.
 */

import {
  ArrowUpIcon,
  CameraIcon,
  CaretDownIcon,
  ColumnsIcon,
  EnvelopeSimpleIcon,
  GlobeIcon,
  PlusIcon,
  QuotesIcon,
  TableIcon,
  TextAlignLeftIcon,
  XIcon,
} from '@phosphor-icons/react';
import { flattenProjectSessionPages, useProjectSessions } from '@kortix/sdk/react';
import { Button } from '@kortix/ui/button';
import { Checkbox } from '@kortix/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@kortix/ui/dropdown-menu';
import { Hint } from '@kortix/ui/hint';
import { readLastProjectId } from '@kortix/ui/internal/lib/onboarding/last-project-cookie';
import { useComposerPrefillStore } from '@kortix/ui/internal/stores/composer-prefill-store';
import { cn } from '@kortix/ui/lib/utils';
import Loading from '@kortix/ui/loading';
import { Popover, PopoverContent, PopoverTrigger } from '@kortix/ui/popover';
import { Skeleton } from '@kortix/ui/skeleton';
import { Tabs, TabsListCompact, TabsTriggerCompact } from '@kortix/ui/tabs';
import { errorToast } from '@kortix/ui/toast';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { quickEntryRecentSessions } from '@/components/desktop/desktop-quick-entry';
import { useAuth } from '@/features/providers/auth-provider';
import { useProjectSelectorData } from '@/features/workspace/project-selector/use-project-selector-data';
import { useTranslations } from '@/i18n/use-translations';
import { isInExtensionPanel } from '@/lib/supabase/panel-cookies';

import { usePanelChannel, type PanelContext, type PanelTab } from './panel-channel';
import {
  isReadPage,
  pageAttachment,
  screenshotAttachment,
  sendTabs,
  withActTab,
  withQuote,
  type PanelMode,
} from './panel-prompt';

/** How many of the project's sessions the new chat lists. */
const RECENT_SESSIONS = 3;
const projectKey = (userId: string) => `kortix.panel.project.${userId}`;

function rememberedProject(userId: string): string | null {
  try {
    return window.localStorage.getItem(projectKey(userId));
  } catch {
    return null;
  }
}

function rememberProject(userId: string, projectId: string) {
  try {
    window.localStorage.setItem(projectKey(userId), projectId);
  } catch {
    // A blocked store only loses the remembered project.
  }
}

export function ChromePanelHome() {
  const t = useTranslations('chrome.panel');
  const router = useRouter();
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const { sections, listsLoading } = useProjectSelectorData();
  const projects = useMemo(() => sections.flatMap((section) => section.projects), [sections]);
  const [picked, setPicked] = useState<string | null>(null);
  const projectId = useMemo(() => {
    const known = (id: string | null) => (id && projects.some((p) => p.project_id === id) ? id : null);
    const stored = userId ? known(rememberedProject(userId)) ?? known(readLastProjectId(userId)) : null;
    return known(picked) ?? stored ?? projects[0]?.project_id ?? null;
  }, [picked, projects, userId]);
  const project = projects.find((p) => p.project_id === projectId);

  const [text, setText] = useState('');
  const [mode, setMode] = useState<PanelMode>('read');
  const [follow, setFollow] = useState(true);
  const [added, setAdded] = useState<PanelTab[]>([]);
  const [quote, setQuote] = useState<PanelContext | null>(null);
  const [sending, setSending] = useState(false);
  /** Send also attaches a JPEG of the visible tab. */
  const [shot, setShot] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);

  // A right-click on "Ask Kortix": that tab, and the selection as a quote.
  const onContext = (context: PanelContext) => {
    setFollow(false);
    setAdded(context.quote || !context.tab ? [] : [context.tab]);
    setQuote(context.quote ? context : null);
    input.current?.focus();
  };
  const channel = usePanelChannel(onContext);
  const tabs = sendTabs(channel.activeTab, follow, added);

  const { data: sessionPages } = useProjectSessions(projectId ?? '', {
    parent: 'root',
    startedBy: 'me',
    enabled: projectId !== null,
  });
  const recent = useMemo(
    () => quickEntryRecentSessions(flattenProjectSessionPages(sessionPages)).slice(0, RECENT_SESSIONS),
    [sessionPages],
  );

  useEffect(() => {
    // Outside the side panel there is no tab to talk about: /panel is not a page of its own.
    // nav-contract: prefetch-only — a stray visit leaves at once
    if (!isInExtensionPanel()) router.replace('/projects');
    else input.current?.focus();
  }, [router]);

  const pickProject = (id: string) => {
    setPicked(id);
    if (userId) rememberProject(userId, id);
  };

  // A quick action reads the page whatever the switch says.
  const send = async (override?: string, sendMode: PanelMode = mode) => {
    const body = (override ?? text).trim();
    if (!body || !projectId || sending) return;
    setSending(true);
    try {
      let prompt = quote?.quote ? withQuote(body, quote.quote, quote.tab) : body;
      const readable = tabs.filter((tab) => tab.readable);
      let files: ReturnType<typeof pageAttachment>[] = [];
      if (sendMode === 'act') {
        const tab = readable[0] ?? quote?.tab;
        if (tab?.readable) {
          prompt = withActTab(prompt, tab);
          channel.handAct(tab.id);
        }
      } else if (readable.length) {
        const pages = await channel.readTabs(readable.map((tab) => tab.id));
        const read = pages.filter(isReadPage);
        if (!read.length) throw new Error(t('readFailed'));
        const readAt = new Date();
        files = read.map((page) => pageAttachment(page, readAt));
      }
      if (shot) {
        // Chrome captures the window's visible tab: the one the first chip shows.
        const dataUrl = await channel.capture();
        if (!dataUrl) throw new Error(t('captureFailed'));
        files = [...files, screenshotAttachment(dataUrl, channel.activeTab?.title ?? '', new Date())];
      }
      // Project home sends it as if the person pressed Enter there, then opens the session here.
      // 'when-ready': a one-shot submit on landing is dropped when the composer is still loading.
      useComposerPrefillStore
        .getState()
        .setPrefill(projectId, prompt, { submit: 'when-ready', ...(files.length ? { files } : {}) });
      // nav-contract: prefetch-only — project home consumes the prefill and opens the new session
      router.push(`/projects/${projectId}`);
    } catch (error) {
      errorToast(error instanceof Error && error.message ? error.message : t('readFailed'));
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  };

  const quickActions = [
    { key: 'summarize', icon: TextAlignLeftIcon },
    { key: 'tables', icon: TableIcon },
    { key: 'email', icon: EnvelopeSimpleIcon },
  ] as const;
  const hasContext = tabs.length > 0 || quote !== null;

  return (
    <main className="bg-background text-foreground flex min-h-svh flex-col">
      <header className="flex h-12 shrink-0 items-center px-2">
        {listsLoading && !project ? (
          <Skeleton className="h-6 w-32 rounded-md" />
        ) : projects.length ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" title={t('project')} className="max-w-full min-w-0">
                <span className="truncate font-medium">{project?.name}</span>
                <CaretDownIcon className="text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-80 w-64">
              <DropdownMenuRadioGroup value={projectId ?? ''} onValueChange={pickProject}>
                {sections
                  .filter((section) => section.projects.length)
                  .map((section) => (
                    <div key={section.accountId}>
                      {sections.length > 1 ? <DropdownMenuLabel>{section.accountName}</DropdownMenuLabel> : null}
                      {section.projects.map((p) => (
                        <DropdownMenuRadioItem key={p.project_id} value={p.project_id}>
                          <span className="truncate">{p.name}</span>
                        </DropdownMenuRadioItem>
                      ))}
                    </div>
                  ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </header>

      <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-4 pt-2 pb-4">
        {!listsLoading && !projects.length ? (
          <div className="space-y-2">
            <p className="text-muted-foreground text-sm text-pretty">{t('noProjects')}</p>
            <Button asChild variant="outline" size="sm">
              <Link href="/projects/start">{t('createProject')}</Link>
            </Button>
          </div>
        ) : (
          <>
            <div className="space-y-1">
              <h1 className="text-sm font-medium text-balance">{quote ? t('selectionTitle') : t('title')}</h1>
              <p className="text-muted-foreground text-xs text-pretty">{quote ? t('selectionBody') : t('body')}</p>
            </div>
            {!quote ? (
              <ul className="space-y-2">
                {quickActions.map(({ key, icon: Icon }) => (
                  <li key={key}>
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full justify-start"
                      disabled={!projectId || sending || !tabs.some((tab) => tab.readable)}
                      onClick={() => void send(t(`prompts.${key}`), 'read')}
                    >
                      <Icon className="text-muted-foreground" />
                      {t(`actions.${key}`)}
                    </Button>
                  </li>
                ))}
                <li>
                  <TabPicker
                    listTabs={channel.listTabs}
                    inPanel={channel.inPanel}
                    chosen={tabs}
                    onAdd={(more) => {
                      setAdded((current) => [...current, ...more]);
                      if (!text.trim()) setText(t('prompts.compare'));
                      input.current?.focus();
                    }}
                    trigger={
                      <Button variant="outline" size="sm" className="w-full justify-start" disabled={!channel.inPanel}>
                        <ColumnsIcon className="text-muted-foreground" />
                        {t('actions.compare')}
                      </Button>
                    }
                  />
                </li>
              </ul>
            ) : null}
            {recent.length && project ? (
              <div className="space-y-1">
                <p className="text-muted-foreground text-xs">{t('recent', { project: project.name })}</p>
                <ul>
                  {recent.map((session) => (
                    <li key={session.id}>
                      <Link
                        href={`/projects/${projectId}/sessions/${session.id}`}
                        className="hover:bg-muted -mx-2 flex items-center rounded-md px-2 py-1.5 text-sm"
                      >
                        <span className="truncate">{session.title}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </div>

      <form
        className="shrink-0 px-3 pb-3"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <div className="bg-popover border-border flex flex-col gap-2 rounded-xl border p-2">
          {quote?.quote ? (
            <div className="bg-muted flex items-start gap-2 rounded-md py-1.5 pr-1 pl-2">
              <QuotesIcon className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
              <p className="line-clamp-4 flex-1 text-xs">{quote.quote}</p>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t('removeQuote')}
                onClick={() => setQuote(null)}
              >
                <XIcon />
              </Button>
            </div>
          ) : null}
          {hasContext || channel.inPanel ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {tabs.map((tab) => (
                <TabChip
                  key={tab.id}
                  tab={tab}
                  removeLabel={t('removeTab', { title: tab.title })}
                  unreadableLabel={t('unreadable')}
                  onRemove={() => {
                    if (follow && tab.id === channel.activeTab?.id) setFollow(false);
                    setAdded((current) => current.filter((other) => other.id !== tab.id));
                  }}
                />
              ))}
              {quote?.tab && !tabs.some((tab) => tab.id === quote.tab?.id) ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="text-muted-foreground"
                  onClick={() => quote.tab && setAdded((current) => [...current, quote.tab as PanelTab])}
                >
                  <PlusIcon />
                  {t('wholePage')}
                </Button>
              ) : null}
              {channel.inPanel ? (
                <TabPicker
                  listTabs={channel.listTabs}
                  inPanel={channel.inPanel}
                  chosen={tabs}
                  onAdd={(more) => setAdded((current) => [...current, ...more])}
                  trigger={
                    <Button type="button" variant="ghost" size="xs" className="text-muted-foreground">
                      <PlusIcon />
                      {t('addTab')}
                    </Button>
                  }
                />
              ) : null}
              {channel.inPanel && channel.activeTab?.readable ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  aria-pressed={shot}
                  className={cn(shot ? 'bg-muted text-foreground' : 'text-muted-foreground')}
                  onClick={() => setShot((on) => !on)}
                >
                  <CameraIcon />
                  {t('screenshot')}
                </Button>
              ) : null}
            </div>
          ) : null}
          <label htmlFor="panel-prompt" className="sr-only">
            {t('message')}
          </label>
          <textarea
            id="panel-prompt"
            ref={input}
            rows={2}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={tabs.length ? t('placeholder') : t('placeholderNoTab')}
            className="placeholder:text-muted-foreground max-h-48 min-h-12 resize-none bg-transparent px-1 text-sm outline-none"
          />
          <div className="flex items-center gap-2">
            <Tabs value={mode} onValueChange={(value) => setMode(value as PanelMode)}>
              <TabsListCompact aria-label={t('modeLabel')}>
                <TabsTriggerCompact value="read">{t('read')}</TabsTriggerCompact>
                <TabsTriggerCompact value="act">{t('act')}</TabsTriggerCompact>
              </TabsListCompact>
            </Tabs>
            <span className="flex-1" />
            <Hint label={t('send')} side="top">
              <Button
                type="submit"
                size="icon-sm"
                aria-label={t('send')}
                disabled={!text.trim() || !projectId || sending}
              >
                {sending ? <Loading className="size-4 shrink-0" /> : <ArrowUpIcon />}
              </Button>
            </Hint>
          </div>
        </div>
        <p className="text-muted-foreground mt-2 px-1 text-xs text-pretty">
          {mode === 'act' ? t('actHint') : t('readHint')}
        </p>
      </form>
    </main>
  );
}

function TabChip({
  tab,
  removeLabel,
  unreadableLabel,
  onRemove,
}: {
  tab: PanelTab;
  removeLabel: string;
  unreadableLabel: string;
  onRemove: () => void;
}) {
  const chip = (
    <span
      className={cn(
        'bg-muted inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md pr-0.5 pl-2 text-xs',
        !tab.readable && 'text-muted-foreground',
      )}
    >
      <GlobeIcon className="size-3.5 shrink-0" />
      <span className="max-w-48 truncate">{tab.title}</span>
      <Button type="button" variant="ghost" size="icon-xs" aria-label={removeLabel} onClick={onRemove}>
        <XIcon />
      </Button>
    </span>
  );
  return tab.readable ? chip : <Hint label={unreadableLabel} side="top">{chip}</Hint>;
}

function TabPicker({
  listTabs,
  inPanel,
  chosen,
  onAdd,
  trigger,
}: {
  listTabs: () => Promise<PanelTab[]>;
  inPanel: boolean;
  chosen: readonly PanelTab[];
  onAdd: (tabs: PanelTab[]) => void;
  trigger: React.ReactNode;
}) {
  const t = useTranslations('chrome.panel');
  const [open, setOpen] = useState(false);
  const [tabs, setTabs] = useState<PanelTab[] | null>(null);
  const [ticked, setTicked] = useState<Set<number>>(new Set());

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next || !inPanel) return;
    setTabs(null);
    setTicked(new Set());
    listTabs().then(
      (all) => setTabs(all.filter((tab) => tab.readable && !chosen.some((c) => c.id === tab.id))),
      () => {
        setOpen(false);
        errorToast(t('tabsFailed'));
      },
    );
  };

  const toggle = (id: number, on: boolean) =>
    setTicked((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-72 p-2">
        <div className="space-y-1 px-2 pt-1 pb-2">
          <p className="text-sm font-medium">{t('addTabsTitle')}</p>
          <p className="text-muted-foreground text-xs">{t('addTabsHint')}</p>
        </div>
        {tabs === null ? (
          <div className="flex justify-center py-3">
            <Loading className="text-muted-foreground size-4" />
          </div>
        ) : tabs.length ? (
          <ul className="max-h-64 overflow-y-auto">
            {tabs.map((tab) => (
              <li key={tab.id}>
                <label className="hover:bg-muted flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5">
                  <Checkbox checked={ticked.has(tab.id)} onCheckedChange={(on) => toggle(tab.id, on === true)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{tab.title}</span>
                    <span className="text-muted-foreground block truncate text-xs">{hostOf(tab.url)}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground px-2 pb-2 text-xs">{t('noTabs')}</p>
        )}
        <div className="flex justify-end gap-2 px-1 pt-2">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            {t('cancel')}
          </Button>
          <Button
            size="sm"
            disabled={!ticked.size}
            onClick={() => {
              onAdd((tabs ?? []).filter((tab) => ticked.has(tab.id)));
              setOpen(false);
            }}
          >
            {t('addTabs', { count: ticked.size })}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
