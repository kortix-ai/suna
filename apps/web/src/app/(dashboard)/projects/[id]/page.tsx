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
import { motion } from 'framer-motion';
import { FolderGit2, MessageSquareText, Loader2, Bot, Zap, Sparkles } from 'lucide-react';
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
import { ProjectFilesTab } from '@/components/kortix/project-files-tab';
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
  const [settingsSection, setSettingsSection] = useState<'team' | 'credentials' | 'triggers' | 'channels' | 'board'>('team');
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

  const isLive = useMemo(() => {
    if (sessionList.length === 0) return false;
    const fiveMinAgo = Date.now() - 5 * 60_000;
    return sessionList.some((s: any) => {
      const t = s?.time?.updated ?? Date.parse(s?.updated_at ?? '');
      return typeof t === 'number' && t > fiveMinAgo;
    });
  }, [sessionList]);

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
    if (next === 'team' || next === 'credentials' || next === 'triggers' || next === 'channels') {
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
  const newKeyLockRef = useRef(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isProjectRouteActive || newTaskOpen || newTicketOpen || e.repeat) return;
      const inField =
        document.activeElement?.tagName === 'INPUT' ||
        document.activeElement?.tagName === 'TEXTAREA' ||
        (document.activeElement as HTMLElement | null)?.isContentEditable;

      if (e.key === '/' && tab === 'tasks' && !inField) { e.preventDefault(); searchRef.current?.focus(); }
      if ((e.key === 'c' || e.key === 'C') && !inField && !e.metaKey && !e.ctrlKey) {
        if (Date.now() - newKeyLockRef.current < 300) return;
        newKeyLockRef.current = Date.now();
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
        onNewTask={isV2 ? () => openNewTicket() : () => openNewTask()}
        newActionLabel={isV2 ? 'New ticket' : 'New task'}
        structureVersion={isV2 ? 2 : 1}
        isLive={isLive}
        tabBadges={isV2 ? { board: unread.total } : undefined}
        rightSlot={isV2 ? (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={openPmChat}
              disabled={ensurePmSession.isPending}
              className="text-muted-foreground hover:text-foreground"
              title="Open a chat with the Project Manager agent"
            >
              {ensurePmSession.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                <MessageSquareText />
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
                if (focusId && activity) {
                  const ev = activity.find((e) => e.id === focusId);
                  if (ev && (!lastSeenAt || ev.created_at > lastSeenAt)) {
                    writeLastSeen(project.id, userHandle, ev.created_at);
                    setLastSeenAt(ev.created_at);
                  }
                }
              }}
            />
          </div>
        ) : undefined}
      />

      <div className="flex-1 min-h-0 relative">
        <TabPanel active={tab === 'about'}>
          <ProjectAbout
            project={project}
            onNavigate={setTab}
            onOpenTicket={(id) => setOpenTicketId(id)}
          />
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
                <ProjectFilesTab projectName={project.name} projectPath={project.path} />
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

  const tokens = totalTokens(totals.tokens);

  return (
    <div className="h-full overflow-y-auto">
      <motion.div
        initial="hidden"
        animate="show"
        variants={{
          hidden: {},
          show: { transition: { staggerChildren: 0.04, delayChildren: 0.04 } },
        }}
        className="mx-auto w-full max-w-3xl px-6 pt-12 pb-24"
      >
        <SessionsSection>
          <header>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">Sessions</h1>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
              Every conversation with your agents — grouped by who or what started it.
            </p>
          </header>
        </SessionsSection>

        <SessionsSection delay>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
            <SessionStatPill label={sessions.length === 1 ? 'session' : 'sessions'} value={sessions.length} dot="bg-violet-500" />
            <SessionStatPill label="messages" value={totals.messageCount} dot="bg-blue-500" muted={statsLoading} />
            <SessionStatPill label="tokens" value={formatTokens(tokens)} dot="bg-amber-500" muted={statsLoading} />
            <SessionStatPill label="spent" value={formatCost(totals.cost)} dot="bg-emerald-500" muted={statsLoading} />
          </div>
        </SessionsSection>

        {teamAgents.length > 0 && (
          <SessionsSection delay>
            <SessionsGroup icon={Bot} label="Team agents" count={totalAgentSessions}>
              {teamAgents.map((agent, i) => {
                const list = buckets.byAgent.get(agent.name.toLowerCase()) ?? [];
                return (
                  <AgentSessionsRow
                    key={agent.id}
                    agent={agent}
                    sessions={list}
                    statsById={statsById}
                    openSession={openSession}
                    isLast={i === teamAgents.length - 1}
                  />
                );
              })}
            </SessionsGroup>
          </SessionsSection>
        )}

        {activeTriggers.length > 0 && (
          <SessionsSection delay>
            <SessionsGroup icon={Zap} label="Trigger executions" count={totalTriggerSessions}>
              {activeTriggers.map((t: any, i: number) => {
                const list = buckets.byTrigger.get(t.name) ?? [];
                return (
                  <TriggerSessionsRow
                    key={t.id}
                    trigger={t}
                    sessions={list}
                    statsById={statsById}
                    openSession={openSession}
                    isLast={i === activeTriggers.length - 1}
                  />
                );
              })}
            </SessionsGroup>
          </SessionsSection>
        )}

        {buckets.onboarding.length > 0 && (
          <SessionsSection delay>
            <SessionsGroup icon={Sparkles} label="Onboarding" count={buckets.onboarding.length}>
              {buckets.onboarding.map((s, i) => (
                <PlainSessionRow
                  key={s.id}
                  session={s}
                  stats={statsById.get(s.id)}
                  onClick={() => openSession(s)}
                  isLast={i === buckets.onboarding.length - 1}
                />
              ))}
            </SessionsGroup>
          </SessionsSection>
        )}

        {buckets.human.length > 0 && (
          <SessionsSection delay>
            <SessionsGroup icon={MessageSquareText} label="Chats" count={buckets.human.length}>
              {buckets.human.map((s, i) => (
                <PlainSessionRow
                  key={s.id}
                  session={s}
                  stats={statsById.get(s.id)}
                  onClick={() => openSession(s)}
                  isLast={i === buckets.human.length - 1}
                />
              ))}
            </SessionsGroup>
          </SessionsSection>
        )}
      </motion.div>
    </div>
  );
}

function SessionsSection({ children, delay }: { children: React.ReactNode; delay?: boolean }) {
  return (
    <motion.section
      variants={{
        hidden: { opacity: 0, y: 6 },
        show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: 'easeOut' } },
      }}
      className={cn(delay && 'mt-10')}
    >
      {children}
    </motion.section>
  );
}

function SessionStatPill({
  label,
  value,
  dot,
  muted,
}: {
  label: string;
  value: number | string;
  dot: string;
  muted?: boolean;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs text-muted-foreground',
        muted && 'opacity-60',
      )}
    >
      <span className={cn('size-1.5 rounded-full', dot)} />
      <span className="font-semibold tabular-nums text-foreground">{value}</span>
      <span>{label}</span>
    </span>
  );
}

function SessionsGroup({
  icon: Icon,
  label,
  count,
  children,
}: {
  icon: typeof Bot;
  label: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Icon className="size-3.5 text-muted-foreground/60" />
        <h2 className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">{label}</h2>
        <span className="text-xs tabular-nums text-muted-foreground/45">{count}</span>
      </div>
      <div className="overflow-hidden rounded-2xl bg-muted/30">
        {children}
      </div>
    </div>
  );
}

function AgentSessionsRow({
  agent,
  sessions,
  statsById,
  openSession,
  isLast,
}: {
  agent: ProjectAgent;
  sessions: any[];
  statsById: Map<string, SessionStats>;
  openSession: (s: any) => void;
  isLast: boolean;
}) {
  const [open, setOpen] = useState(false);
  const aggregate = useMemo(
    () => sumStats(sessions.map((s) => statsById.get(s.id) ?? EMPTY_STATS)),
    [sessions, statsById],
  );
  const tokens = totalTokens(aggregate.tokens);
  return (
    <div className={cn(!isLast && 'border-b border-border/40')}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/60"
      >
        <AgentAvatar hue={agent.color_hue} icon={agent.icon} slug={agent.slug} name={agent.name} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium text-foreground truncate">@{agent.slug}</span>
            <span className="text-xs text-muted-foreground/60 truncate">{agent.name}</span>
          </div>
          <SessionMetaLine
            count={sessions.length}
            unit="session"
            tokens={tokens}
            cost={aggregate.cost}
            lastTimestamp={aggregate.lastUpdated}
            lastLabel="active"
          />
        </div>
        <ChevronDown className={cn('size-3.5 shrink-0 text-muted-foreground/40 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="border-t border-border/40 bg-muted/40">
          {sessions.map((s, i) => (
            <PlainSessionRow
              key={s.id}
              session={s}
              stats={statsById.get(s.id)}
              onClick={() => openSession(s)}
              dense
              isLast={i === sessions.length - 1}
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
  isLast,
}: {
  trigger: any;
  sessions: any[];
  statsById: Map<string, SessionStats>;
  openSession: (s: any) => void;
  isLast: boolean;
}) {
  const [open, setOpen] = useState(false);
  const aggregate = useMemo(
    () => sumStats(sessions.map((s) => statsById.get(s.id) ?? EMPTY_STATS)),
    [sessions, statsById],
  );
  const tokens = totalTokens(aggregate.tokens);
  const isCron = trigger.type === 'cron';
  return (
    <div className={cn(!isLast && 'border-b border-border/40')}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/60"
      >
        <div className="inline-flex size-7 items-center justify-center rounded-full bg-muted/60 text-muted-foreground/70 shrink-0">
          {isCron ? <TimerIcon className="size-3.5" /> : <WebhookIcon className="size-3.5" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium text-foreground truncate">{trigger.name}</span>
            <span className="inline-flex h-4 items-center rounded bg-muted/60 px-1.5 font-mono text-[10px] text-muted-foreground/70">
              {isCron ? (trigger.cronExpr || 'cron') : 'webhook'}
            </span>
          </div>
          <SessionMetaLine
            count={sessions.length}
            unit="fire"
            tokens={tokens}
            cost={aggregate.cost}
            lastTimestamp={aggregate.lastUpdated}
            lastLabel="last"
          />
        </div>
        <ChevronDown className={cn('size-3.5 shrink-0 text-muted-foreground/40 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="border-t border-border/40 bg-muted/40">
          {sessions.map((s, i) => (
            <PlainSessionRow
              key={s.id}
              session={s}
              stats={statsById.get(s.id)}
              onClick={() => openSession(s)}
              dense
              isLast={i === sessions.length - 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SessionMetaLine({
  count,
  unit,
  tokens,
  cost,
  lastTimestamp,
  lastLabel,
}: {
  count: number;
  unit: string;
  tokens: number;
  cost: number;
  lastTimestamp: number | null;
  lastLabel: string;
}) {
  const dot = <span className="text-muted-foreground/30">·</span>;
  return (
    <div className="mt-0.5 flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground/70">
      <span>{count} {unit}{count === 1 ? '' : 's'}</span>
      {dot}
      <span>{formatTokens(tokens)}</span>
      {dot}
      <span>{formatCost(cost)}</span>
      {lastTimestamp && (
        <>
          {dot}
          <span className="text-muted-foreground/55">{lastLabel} {relativeTime(lastTimestamp)}</span>
        </>
      )}
    </div>
  );
}

function PlainSessionRow({
  session,
  stats,
  onClick,
  dense,
  isLast,
}: {
  session: any;
  stats?: SessionStats;
  onClick: () => void;
  dense?: boolean;
  isLast?: boolean;
}) {
  const tokens = stats ? totalTokens(stats.tokens) : 0;
  return (
    <button
      onClick={onClick}
      className={cn(
        'group flex w-full items-center gap-3 text-left transition-colors hover:bg-muted/60',
        dense ? 'px-4 py-2' : 'px-4 py-3',
        !isLast && 'border-b border-border/40',
      )}
    >
      <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
      <span className="min-w-0 flex-1 truncate text-sm text-foreground/90">
        {session.title || 'Untitled session'}
      </span>
      {stats && stats.messageCount > 0 && (
        <span className="hidden shrink-0 items-center gap-1.5 text-xs tabular-nums text-muted-foreground/60 sm:inline-flex">
          <span>{formatTokens(tokens)}</span>
          <span className="text-muted-foreground/30">·</span>
          <span>{formatCost(stats.cost)}</span>
        </span>
      )}
      <span className="w-[70px] shrink-0 text-right text-xs tabular-nums text-muted-foreground/45">
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
