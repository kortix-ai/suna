'use client';

/**
 * Project page.
 *
 * v1 projects: legacy tabs — About · Tasks · Files · Sessions.
 * v2 projects: new tabs — About · Board · Team · Settings · Files · Sessions.
 *
 * Branching is purely frontend-driven by `project.structure_version`. New
 * projects default to v2 server-side; v1 projects continue using the original
 * task system untouched.
 */

import { use, useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { FolderGit2, MessageSquareText, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useKortixProject,
  useKortixProjectSessions,
  usePatchProject,
} from '@/hooks/kortix/use-kortix-projects';
import {
  useKortixTasks,
  useStartKortixTask,
  useApproveKortixTask,
  useDeleteKortixTask,
  type KortixTask,
  type KortixTaskStatus,
} from '@/hooks/kortix/use-kortix-tasks';
import {
  useTickets,
  useColumns,
  useProjectAgents,
  useFields,
  useUpdateTicketStatus,
  useDeleteTicket,
  useUserHandle,
  useProjectActivity,
  useEnsurePmSession,
  computeUnread,
  readLastSeen,
  writeLastSeen,
  type Ticket,
} from '@/hooks/kortix/use-kortix-tickets';
import { openTabAndNavigate } from '@/stores/tab-store';
import {
  createFilesStore,
  FilesStoreProvider,
} from '@/features/files/store/files-store';
import { FileExplorerPage } from '@/features/files/components/file-explorer-page';
import { relativeTime } from '@/lib/kortix/task-meta';
import { classifySession } from '@/lib/kortix/session-category';
import type { ProjectAgent } from '@/hooks/kortix/use-kortix-tickets';
import { useTriggers } from '@/hooks/scheduled-tasks';
import { useQueries } from '@tanstack/react-query';
import { getClient } from '@/lib/opencode-sdk';
import { formatCost, formatTokens } from '@/ui/turns';
import { AgentAvatar } from '@/components/kortix/agent-avatar';
import { ChevronDown, TimerIcon, Webhook as WebhookIcon } from 'lucide-react';
import {
  ProjectHeader,
  type ProjectTab,
} from '@/components/kortix/project-header';
import { ProjectAbout } from '@/components/kortix/project-about';
import { ProjectMembersTab } from '@/components/kortix/project-members-tab';
import { TasksTab } from '@/components/kortix/tasks-tab';
import { TaskDetailView } from '@/components/kortix/task-detail-view';
import { NewTaskDialog } from '@/components/kortix/new-task-dialog';
import { TicketBoard } from '@/components/kortix/ticket-board';
import { TicketDetailDrawer } from '@/components/kortix/ticket-detail-drawer';
import { NewTicketDialog } from '@/components/kortix/new-ticket-dialog';
import { MilestonesTab } from '@/components/kortix/milestones-tab';
import { ProjectSettingsTab } from '@/components/kortix/project-settings-tab';
import { NotificationsBell } from '@/components/kortix/notifications-bell';
import { useIsRouteActive } from '@/hooks/utils/use-is-route-active';

export default function ProjectPage({ params }: { params?: Promise<{ id: string }> }) {
  const { id: raw } = params ? use(params) : { id: '' };
  const pid = raw ? decodeURIComponent(raw) : '';
  const projectFilesStoreRef = useRef(createFilesStore());
  const projectFilesStore = projectFilesStoreRef.current;

  const { data: project, isLoading } = useKortixProject(pid);
  const isV2 = project?.structure_version === 2;
  const userHandle = useUserHandle();
  const patchProject = usePatchProject();

  // Auto-sync user_handle once per project: projects are created by the
  // project_create agent tool which doesn't know the logged-in human's handle,
  // so the frontend backfills it on first load of a v2 project.
  const syncedHandleRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!project || !isV2) return;
    if ((project as any).user_handle === userHandle) return;
    if (syncedHandleRef.current.has(project.id)) return;
    syncedHandleRef.current.add(project.id);
    patchProject.mutate({ id: project.id, user_handle: userHandle });
    // patchProject is a stable mutation object; excluding from deps avoids a re-sync loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, isV2, userHandle, (project as any)?.user_handle]);

  const [tab, setTabState] = useState<ProjectTab>('about');
  // Team/Credentials/Triggers live inside Settings now. If any caller passes
  // those legacy values, route to Settings and pre-select the matching section.
  const [settingsSection, setSettingsSection] = useState<'team' | 'credentials' | 'triggers' | 'board'>('team');
  const isProjectRouteActive = useIsRouteActive(`/projects/${encodeURIComponent(pid)}`);

  // ─── v1 state ──────────────────────────────────────────────────────────
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const shouldLoadProjectSessions = isProjectRouteActive && tab === 'sessions';
  const shouldLoadProjectTasks = !isV2 && isProjectRouteActive && tab === 'tasks';

  const { data: sessions } = useKortixProjectSessions(pid, { enabled: shouldLoadProjectSessions });
  const { data: tasks } = useKortixTasks(project?.id, undefined, {
    enabled: shouldLoadProjectTasks,
    pollingEnabled: shouldLoadProjectTasks,
  });
  const startTask = useStartKortixTask();
  const approveTask = useApproveKortixTask();
  const deleteTask = useDeleteKortixTask();

  const sessionList = useMemo(() => sessions ?? [], [sessions]);
  const taskList = useMemo<KortixTask[]>(() => tasks ?? [], [tasks]);

  // ─── v2 state ──────────────────────────────────────────────────────────
  const [openTicketId, setOpenTicketId] = useState<string | null>(null);
  const [focusEventId, setFocusEventId] = useState<string | null>(null);
  const [newTicketDefaultStatus, setNewTicketDefaultStatus] = useState<string | undefined>();
  const [newTicketOpen, setNewTicketOpen] = useState(false);

  const loadV2 = !!isV2 && isProjectRouteActive;
  const { data: tickets = [] } = useTickets(project?.id, {
    enabled: loadV2 && tab === 'board',
    pollingEnabled: loadV2 && tab === 'board',
  });
  const { data: columns = [] } = useColumns(loadV2 ? project?.id : undefined);
  const { data: agents = [] } = useProjectAgents(loadV2 ? project?.id : undefined);
  const { data: fields = [] } = useFields(loadV2 ? project?.id : undefined);
  const { data: activity } = useProjectActivity(loadV2 ? project?.id : undefined, {
    enabled: loadV2,
    pollingEnabled: loadV2 && isProjectRouteActive,
  });
  const updateTicketStatus = useUpdateTicketStatus();
  const deleteTicket = useDeleteTicket();
  const ensurePmSession = useEnsurePmSession();

  const openPmChat = useCallback(() => {
    if (!project?.id) return;
    ensurePmSession.mutate(
      { projectId: project.id },
      {
        onSuccess: (data) => {
          openTabAndNavigate({
            id: data.session_id,
            title: `PM · ${project.name}`,
            type: 'session',
            href: `/sessions/${data.session_id}`,
          });
        },
        onError: (err) => {
          toast.error('Could not open PM chat', { description: err instanceof Error ? err.message : String(err) });
        },
      },
    );
  }, [project?.id, project?.name, ensurePmSession]);

  // Unread notifications for the current user. Recomputed on every activity
  // tick against the last-seen timestamp saved in localStorage. We don't
  // auto-clear on tab visit — the user wanted this strictly driven by the
  // bell (open the panel → click an entry → read).
  const [lastSeenAt, setLastSeenAt] = useState<string | null>(null);
  useEffect(() => {
    if (!loadV2 || !project?.id || !userHandle) return;
    setLastSeenAt(readLastSeen(project.id, userHandle));
  }, [loadV2, project?.id, userHandle]);
  const unread = useMemo(
    () => computeUnread(activity, userHandle, lastSeenAt),
    [activity, userHandle, lastSeenAt],
  );

  // ─── File explorer scoping ─────────────────────────────────────────────
  useEffect(() => {
    const { setRootPath, navigateToPath } = projectFilesStore.getState();
    if (project?.path && project.path !== '/') {
      setRootPath(project.path);
      navigateToPath(project.path);
    }
    return () => {
      setRootPath(null);
      projectFilesStore.setState({ currentPath: '/workspace' });
    };
  }, [project?.path, projectFilesStore]);

  useEffect(() => {
    if (tab === 'files' && project?.path && project.path !== '/') {
      projectFilesStore.getState().navigateToPath(project.path);
    }
  }, [tab, project?.path, projectFilesStore]);

  const setTab = useCallback((next: ProjectTab) => {
    // Legacy values from before the tab collapse — route them into Settings
    // with the matching section pre-selected so old bookmarks / links still
    // land on the right config pane.
    if (next === 'team' || next === 'credentials' || next === 'triggers') {
      setSettingsSection(next);
      setTabState('settings');
      return;
    }
    setTabState(next);
  }, []);
  const openTask = useCallback((task: KortixTask) => setOpenTaskId(task.id), []);
  const closeTask = useCallback(() => setOpenTaskId(null), []);
  const openTicket = useCallback((t: Ticket) => setOpenTicketId(t.id), []);
  const closeTicket = useCallback(() => { setOpenTicketId(null); setFocusEventId(null); }, []);

  // ─── v1 tasks search ───────────────────────────────────────────────────
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  // ─── v1 new-task dialog ────────────────────────────────────────────────
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newTaskDefault, setNewTaskDefault] = useState<KortixTaskStatus | undefined>();
  const openNewTask = useCallback((status?: KortixTaskStatus) => {
    setNewTaskDefault(status);
    setNewTaskOpen(true);
  }, []);

  const openNewTicket = useCallback((status?: string) => {
    setNewTicketDefaultStatus(status);
    setNewTicketOpen(true);
  }, []);

  const filteredTasks = useMemo(() => {
    if (!search.trim()) return taskList;
    const q = search.toLowerCase();
    return taskList.filter((t) => t.title.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q));
  }, [taskList, search]);

  // ─── Keyboard shortcuts ────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isProjectRouteActive || newTaskOpen || newTicketOpen || e.repeat) return;
      const inField =
        document.activeElement?.tagName === 'INPUT' ||
        document.activeElement?.tagName === 'TEXTAREA' ||
        (document.activeElement as HTMLElement | null)?.isContentEditable;

      if (e.key === '/' && tab === 'tasks' && !inField) { e.preventDefault(); searchRef.current?.focus(); }
      if ((e.key === 'c' || e.key === 'C') && !inField && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        if (isV2) setNewTicketOpen(true);
        else setNewTaskOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab, isProjectRouteActive, newTaskOpen, newTicketOpen, isV2]);

  if (isLoading && !project) return <ProjectSkeleton />;
  if (!project)
    return (
      <div className="flex-1 flex items-center justify-center flex-col gap-3">
        <FolderGit2 className="h-12 w-12 text-muted-foreground/10" />
        <p className="text-sm font-medium text-muted-foreground/40">Project not found</p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            openTabAndNavigate({
              id: 'page:/workspace',
              title: 'Workspace',
              type: 'page',
              href: '/workspace',
            })
          }
        >
          Back to Workspace
        </Button>
      </div>
    );

  const hasFiles = project.path && project.path !== '/';

  return (
    <div className="flex-1 bg-background flex flex-col overflow-hidden">
      <ProjectHeader
        project={project}
        tab={tab}
        onTabChange={setTab}
        structureVersion={project.structure_version}
        onNewTask={isV2 ? () => openNewTicket() : () => openNewTask()}
        newActionLabel={isV2 ? 'New ticket' : 'New task'}
        rightSlot={isV2 ? (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={openPmChat}
              disabled={ensurePmSession.isPending}
              className="h-7 px-2.5 text-[12px] gap-1.5 border-border/40 hover:border-border/60 hover:bg-muted/30"
              title="Open a chat with the Project Manager agent"
            >
              {ensurePmSession.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <MessageSquareText className="h-3.5 w-3.5" />
              )}
              <span className="hidden sm:inline">Ask PM</span>
            </Button>
          <NotificationsBell
            projectId={project.id}
            userHandle={userHandle}
            events={activity}
            tickets={tickets}
            agents={agents}
            lastSeenAt={lastSeenAt}
            onMarkAllRead={(iso) => {
              writeLastSeen(project.id, userHandle, iso);
              setLastSeenAt(iso);
            }}
            onOpenTicket={(id, focusId) => {
              setOpenTicketId(id);
              setFocusEventId(focusId ?? null);
              // Clicking a notification is the "read" signal. Advance lastSeen
              // to that event's timestamp so it (and anything older) drops
              // from the unread count. Newer events stay unread.
              if (focusId && activity) {
                const ev = activity.find((e) => e.id === focusId);
                if (ev && (!lastSeenAt || ev.created_at > lastSeenAt)) {
                  writeLastSeen(project.id, userHandle, ev.created_at);
                  setLastSeenAt(ev.created_at);
                }
              }
            }}
          />
          </>
        ) : undefined}
      />

      <div className="flex-1 min-h-0 relative">
        <TabPanel active={tab === 'about'}>
          <ProjectAbout project={project} />
        </TabPanel>

        {!isV2 && (
          <TabPanel active={tab === 'tasks'}>
            <TasksTab
              tasks={taskList}
              filteredTasks={filteredTasks}
              search={search}
              setSearch={setSearch}
              searchRef={searchRef}
              onStartTask={(id) => startTask.mutate({ id })}
              onApproveTask={(id) => approveTask.mutate(id)}
              onOpenTask={openTask}
              onNewTask={openNewTask}
              onDeleteTask={(id) => deleteTask.mutate(id)}
            />
          </TabPanel>
        )}

        {isV2 && (
          <>
            <TabPanel active={tab === 'board'}>
              <TicketBoard
                tickets={tickets}
                columns={columns}
                agents={agents}
                onOpenTicket={openTicket}
                onNewTicket={openNewTicket}
                onUpdateStatus={(id, status) => updateTicketStatus.mutate({ id, status })}
                onDeleteTicket={(id) => deleteTicket.mutate(id)}
              />
            </TabPanel>
            <TabPanel active={tab === 'milestones'}>
              <MilestonesTab projectId={project.id} />
            </TabPanel>
            <TabPanel active={tab === 'settings'}>
              <ProjectSettingsTab
                projectId={project.id}
                projectPath={project.path}
                section={settingsSection}
                onSectionChange={setSettingsSection}
              />
            </TabPanel>
          </>
        )}

        <TabPanel active={tab === 'files'}>
          {hasFiles ? (
            <div className="flex-1 min-h-0">
              <FilesStoreProvider store={projectFilesStore}>
                <FileExplorerPage />
              </FilesStoreProvider>
            </div>
          ) : (
            <EmptyState text="No project path configured" />
          )}
        </TabPanel>

        <TabPanel active={tab === 'sessions'}>
          <SessionsList
            sessions={sessionList}
            agents={agents}
            projectId={project.id}
          />
        </TabPanel>

        <TabPanel active={tab === 'members'}>
          <ProjectMembersTab project={project} />
        </TabPanel>
      </div>

      {/* v1 dialogs */}
      {!isV2 && (
        <NewTaskDialog
          open={newTaskOpen}
          onOpenChange={setNewTaskOpen}
          projectId={project.id}
          projectName={project.name}
          projectPath={project.path}
          defaultStatus={newTaskDefault}
        />
      )}
      {!isV2 && (
        <TaskDetailView
          taskId={openTaskId}
          onClose={closeTask}
          projectName={project.name}
          pollingEnabled={isProjectRouteActive && !!openTaskId}
        />
      )}

      {/* v2 dialogs */}
      {isV2 && (
        <NewTicketDialog
          open={newTicketOpen}
          onOpenChange={setNewTicketOpen}
          projectId={project.id}
          columns={columns}
          defaultStatus={newTicketDefaultStatus}
        />
      )}
      {isV2 && (
        <TicketDetailDrawer
          ticketId={openTicketId}
          onClose={closeTicket}
          columns={columns}
          fields={fields}
          agents={agents}
          pollingEnabled={isProjectRouteActive && !!openTicketId}
          focusEventId={focusEventId}
        />
      )}
    </div>
  );
}

function TabPanel({ active, children }: { active: boolean; children: React.ReactNode }) {
  return (
    <div className={cn('absolute inset-0 flex flex-col overflow-hidden', !active && 'hidden')}>
      {children}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Sessions tab — Team-page aesthetic + per-agent token/cost stats
// ──────────────────────────────────────────────────────────────────────────────

type SessionStats = {
  messageCount: number;
  cost: number;
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
  lastUpdated: number | null;
};

const EMPTY_STATS: SessionStats = {
  messageCount: 0,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  lastUpdated: null,
};

// Step-finish parts report raw provider cost; credits deducted are ×1.2.
const COST_MARKUP = 1.2;

async function fetchSessionStats(sessionId: string): Promise<SessionStats> {
  const res = await getClient().session.messages({ sessionID: sessionId });
  const data = (res.data ?? []) as any[];
  let cost = 0, input = 0, output = 0, reasoning = 0, cacheRead = 0, cacheWrite = 0;
  let lastUpdated: number | null = null;
  for (const item of data) {
    const ts = item?.info?.time?.updated ?? item?.info?.time?.completed ?? item?.info?.time?.created;
    if (typeof ts === 'number' && (!lastUpdated || ts > lastUpdated)) lastUpdated = ts;
    for (const p of item.parts ?? []) {
      if (p.type === 'step-finish') {
        cost += p.cost || 0;
        input += p.tokens?.input || 0;
        output += p.tokens?.output || 0;
        reasoning += p.tokens?.reasoning || 0;
        cacheRead += p.tokens?.cache?.read || 0;
        cacheWrite += p.tokens?.cache?.write || 0;
      }
    }
  }
  return {
    messageCount: data.length,
    cost: cost * COST_MARKUP,
    tokens: { input, output, reasoning, cacheRead, cacheWrite },
    lastUpdated,
  };
}

function sumStats(items: SessionStats[]): SessionStats {
  const acc = { ...EMPTY_STATS, tokens: { ...EMPTY_STATS.tokens } };
  for (const s of items) {
    acc.messageCount += s.messageCount;
    acc.cost += s.cost;
    acc.tokens.input += s.tokens.input;
    acc.tokens.output += s.tokens.output;
    acc.tokens.reasoning += s.tokens.reasoning;
    acc.tokens.cacheRead += s.tokens.cacheRead;
    acc.tokens.cacheWrite += s.tokens.cacheWrite;
    if (s.lastUpdated && (!acc.lastUpdated || s.lastUpdated > acc.lastUpdated)) {
      acc.lastUpdated = s.lastUpdated;
    }
  }
  return acc;
}

function totalTokens(t: SessionStats['tokens']): number {
  return t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite;
}

function SessionsList({
  sessions,
  agents,
  projectId,
}: {
  sessions: any[];
  agents: ProjectAgent[];
  projectId: string;
}) {
  const { data: allTriggers } = useTriggers();
  const triggers = useMemo(
    () => (allTriggers ?? []).filter((t: any) => t.project_id === projectId),
    [allTriggers, projectId],
  );

  const agentNames = useMemo(() => agents.map((a) => a.name), [agents]);
  const triggerNames = useMemo(() => triggers.map((t: any) => t.name as string), [triggers]);

  const openSession = (s: any) =>
    openTabAndNavigate({ id: s.id, title: s.title || 'Session', type: 'session', href: `/sessions/${s.id}` });

  // Fan-out: one query per session for tokens + cost. staleTime keeps it quiet.
  const sessionIds = useMemo(() => sessions.map((s) => s.id), [sessions]);
  const statsQueries = useQueries({
    queries: sessionIds.map((id) => ({
      queryKey: ['kortix-session-stats', id],
      queryFn: () => fetchSessionStats(id),
      staleTime: 30_000,
      refetchInterval: 60_000,
    })),
  });
  const statsById = useMemo(() => {
    const m = new Map<string, SessionStats>();
    sessionIds.forEach((id, i) => {
      const q = statsQueries[i];
      if (q?.data) m.set(id, q.data);
    });
    return m;
  }, [sessionIds, statsQueries]);

  // Bucket sessions by classification. Newest-first within each bucket.
  const buckets = useMemo(() => {
    const byAgent = new Map<string, any[]>();
    const byTrigger = new Map<string, any[]>();
    const onboarding: any[] = [];
    const human: any[] = [];
    const sorted = [...sessions].sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
    for (const s of sorted) {
      const cls = classifySession(
        { id: s.id, title: s.title, parentID: s.parentID ?? null },
        { agentNames, triggerNames },
      );
      if (cls.category === 'agent_bound' && cls.agentName) {
        const list = byAgent.get(cls.agentName.toLowerCase()) ?? [];
        list.push(s);
        byAgent.set(cls.agentName.toLowerCase(), list);
      } else if (cls.category === 'trigger_fire' && cls.triggerName) {
        const list = byTrigger.get(cls.triggerName) ?? [];
        list.push(s);
        byTrigger.set(cls.triggerName, list);
      } else if (cls.category === 'onboarding') {
        onboarding.push(s);
      } else {
        human.push(s);
      }
    }
    return { byAgent, byTrigger, onboarding, human };
  }, [sessions, agentNames, triggerNames]);

  const totals = useMemo(() => sumStats(Array.from(statsById.values())), [statsById]);
  const totalAgentSessions = Array.from(buckets.byAgent.values()).reduce((n, l) => n + l.length, 0);
  const totalTriggerSessions = Array.from(buckets.byTrigger.values()).reduce((n, l) => n + l.length, 0);
  const statsLoading = statsQueries.some((q) => q?.isLoading);

  if (sessions.length === 0) {
    return <EmptyState text="No sessions linked" sub="Sessions appear here when you select this project" />;
  }

  const teamAgents = agents.filter((a) => buckets.byAgent.has(a.name.toLowerCase()));
  const activeTriggers = triggers.filter((t: any) => buckets.byTrigger.has(t.name));

  return (
    <div className="flex-1 overflow-y-auto bg-background">
      <div className="container mx-auto max-w-3xl px-3 sm:px-4 py-5 space-y-5">

        <SessionsSummaryCard
          totalSessions={sessions.length}
          totals={totals}
          loading={statsLoading}
        />

        {teamAgents.length > 0 && (
          <SessionsSection label="Team agents" count={totalAgentSessions}>
            {teamAgents.map((agent) => {
              const list = buckets.byAgent.get(agent.name.toLowerCase()) ?? [];
              return (
                <AgentSessionsRow
                  key={agent.id}
                  agent={agent}
                  sessions={list}
                  statsById={statsById}
                  openSession={openSession}
                />
              );
            })}
          </SessionsSection>
        )}

        {activeTriggers.length > 0 && (
          <SessionsSection label="Trigger executions" count={totalTriggerSessions}>
            {activeTriggers.map((t: any) => {
              const list = buckets.byTrigger.get(t.name) ?? [];
              return (
                <TriggerSessionsRow
                  key={t.id}
                  trigger={t}
                  sessions={list}
                  statsById={statsById}
                  openSession={openSession}
                />
              );
            })}
          </SessionsSection>
        )}

        {buckets.onboarding.length > 0 && (
          <SessionsSection label="Onboarding" count={buckets.onboarding.length}>
            {buckets.onboarding.map((s) => (
              <PlainSessionRow key={s.id} session={s} stats={statsById.get(s.id)} onClick={() => openSession(s)} />
            ))}
          </SessionsSection>
        )}

        {buckets.human.length > 0 && (
          <SessionsSection label="Chats" count={buckets.human.length}>
            {buckets.human.map((s) => (
              <PlainSessionRow key={s.id} session={s} stats={statsById.get(s.id)} onClick={() => openSession(s)} />
            ))}
          </SessionsSection>
        )}
      </div>
    </div>
  );
}

function SessionsSummaryCard({
  totalSessions,
  totals,
  loading,
}: {
  totalSessions: number;
  totals: SessionStats;
  loading: boolean;
}) {
  const tokens = totalTokens(totals.tokens);
  return (
    <section className="rounded-xl border border-border/40 bg-card px-4 py-3">
      <div className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/50 font-semibold mb-2">
        Project totals
      </div>
      <div className="grid grid-cols-4 gap-4">
        <Stat label="Sessions" value={String(totalSessions)} />
        <Stat label="Messages" value={String(totals.messageCount)} muted={loading} />
        <Stat label="Tokens" value={formatTokens(tokens)} muted={loading} />
        <Stat label="Cost" value={formatCost(totals.cost)} muted={loading} />
      </div>
    </section>
  );
}

function Stat({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/50">{label}</div>
      <div className={cn('text-[16px] font-semibold tabular-nums mt-0.5', muted && 'text-muted-foreground/50')}>
        {value}
      </div>
    </div>
  );
}

function SessionsSection({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
  return (
    <section>
      <div className="flex items-baseline gap-2 mb-2 px-1">
        <h3 className="text-[10px] uppercase tracking-[0.08em] font-semibold text-muted-foreground/60">{label}</h3>
        <span className="text-[11px] tabular-nums text-muted-foreground/40">{count}</span>
      </div>
      <div className="rounded-xl border border-border/40 bg-card divide-y divide-border/30 overflow-hidden">
        {children}
      </div>
    </section>
  );
}

function AgentSessionsRow({
  agent,
  sessions,
  statsById,
  openSession,
}: {
  agent: ProjectAgent;
  sessions: any[];
  statsById: Map<string, SessionStats>;
  openSession: (s: any) => void;
}) {
  const [open, setOpen] = useState(false);
  const aggregate = useMemo(
    () => sumStats(sessions.map((s) => statsById.get(s.id) ?? EMPTY_STATS)),
    [sessions, statsById],
  );
  const tokens = totalTokens(aggregate.tokens);
  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/20 transition-colors cursor-pointer text-left group"
      >
        <AgentAvatar hue={agent.color_hue} icon={agent.icon} slug={agent.slug} name={agent.name} size="md" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[13px] font-semibold truncate">@{agent.slug}</span>
            <span className="text-[11.5px] text-muted-foreground/50 truncate">{agent.name}</span>
          </div>
          <div className="flex items-center gap-3 mt-1 text-[11px] tabular-nums text-muted-foreground/70">
            <span>{sessions.length} session{sessions.length === 1 ? '' : 's'}</span>
            <span className="text-muted-foreground/25">·</span>
            <span>{formatTokens(tokens)} tokens</span>
            <span className="text-muted-foreground/25">·</span>
            <span>{formatCost(aggregate.cost)}</span>
            {aggregate.lastUpdated && (
              <>
                <span className="text-muted-foreground/25">·</span>
                <span className="text-muted-foreground/55">active {relativeTime(aggregate.lastUpdated)}</span>
              </>
            )}
          </div>
        </div>
        <ChevronDown className={cn('h-3.5 w-3.5 text-muted-foreground/40 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="bg-muted/10 border-t border-border/30 divide-y divide-border/20">
          {sessions.map((s) => (
            <PlainSessionRow
              key={s.id}
              session={s}
              stats={statsById.get(s.id)}
              onClick={() => openSession(s)}
              dense
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TriggerSessionsRow({
  trigger,
  sessions,
  statsById,
  openSession,
}: {
  trigger: any;
  sessions: any[];
  statsById: Map<string, SessionStats>;
  openSession: (s: any) => void;
}) {
  const [open, setOpen] = useState(false);
  const aggregate = useMemo(
    () => sumStats(sessions.map((s) => statsById.get(s.id) ?? EMPTY_STATS)),
    [sessions, statsById],
  );
  const tokens = totalTokens(aggregate.tokens);
  const isCron = trigger.type === 'cron';
  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/20 transition-colors cursor-pointer text-left group"
      >
        <div className="h-8 w-8 rounded-full bg-muted/40 text-muted-foreground/70 flex items-center justify-center shrink-0">
          {isCron ? <TimerIcon className="h-4 w-4" /> : <WebhookIcon className="h-4 w-4" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[13px] font-semibold truncate">{trigger.name}</span>
            <span className="inline-flex items-center h-4 px-1.5 rounded text-[10px] font-mono bg-muted/40 text-muted-foreground/70">
              {isCron ? (trigger.cronExpr || 'cron') : 'webhook'}
            </span>
          </div>
          <div className="flex items-center gap-3 mt-1 text-[11px] tabular-nums text-muted-foreground/70">
            <span>{sessions.length} fire{sessions.length === 1 ? '' : 's'}</span>
            <span className="text-muted-foreground/25">·</span>
            <span>{formatTokens(tokens)} tokens</span>
            <span className="text-muted-foreground/25">·</span>
            <span>{formatCost(aggregate.cost)}</span>
            {aggregate.lastUpdated && (
              <>
                <span className="text-muted-foreground/25">·</span>
                <span className="text-muted-foreground/55">last {relativeTime(aggregate.lastUpdated)}</span>
              </>
            )}
          </div>
        </div>
        <ChevronDown className={cn('h-3.5 w-3.5 text-muted-foreground/40 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="bg-muted/10 border-t border-border/30 divide-y divide-border/20">
          {sessions.map((s) => (
            <PlainSessionRow
              key={s.id}
              session={s}
              stats={statsById.get(s.id)}
              onClick={() => openSession(s)}
              dense
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PlainSessionRow({
  session,
  stats,
  onClick,
  dense,
}: {
  session: any;
  stats?: SessionStats;
  onClick: () => void;
  dense?: boolean;
}) {
  const tokens = stats ? totalTokens(stats.tokens) : 0;
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-3 text-left hover:bg-muted/20 transition-colors cursor-pointer',
        dense ? 'px-4 py-1.5' : 'px-4 py-2.5',
      )}
    >
      <span className="flex-1 min-w-0 text-[12.5px] text-foreground/85 truncate">
        {session.title || 'Untitled session'}
      </span>
      {stats && stats.messageCount > 0 && (
        <span className="text-[10.5px] tabular-nums text-muted-foreground/60 shrink-0">
          {formatTokens(tokens)} · {formatCost(stats.cost)}
        </span>
      )}
      <span className="text-[10.5px] tabular-nums text-muted-foreground/40 w-[70px] text-right shrink-0">
        {relativeTime(session.time?.updated)}
      </span>
    </button>
  );
}

function EmptyState({ text, sub }: { text: string; sub?: string }) {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center">
        <p className="text-[13px] text-muted-foreground">{text}</p>
        {sub && <p className="text-[12px] text-muted-foreground/50 mt-1">{sub}</p>}
      </div>
    </div>
  );
}

function ProjectSkeleton() {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[1100px] mx-auto px-6 lg:px-10 pt-12">
        <Skeleton className="h-3 w-24 rounded mb-6" />
        <Skeleton className="h-9 w-2/3 rounded mb-3" />
        <Skeleton className="h-4 w-3/4 rounded mb-2" />
        <Skeleton className="h-4 w-1/2 rounded mb-8" />
        <div className="flex gap-4 mb-6">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-6 w-16 rounded" />)}
        </div>
        <Skeleton className="h-[400px] rounded-lg" />
      </div>
    </div>
  );
}
