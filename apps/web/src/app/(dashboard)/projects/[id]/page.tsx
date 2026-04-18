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

import { Fragment, use, useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { FolderGit2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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
import {
  ProjectHeader,
  type ProjectTab,
} from '@/components/kortix/project-header';
import { ProjectAbout } from '@/components/kortix/project-about';
import { TasksTab } from '@/components/kortix/tasks-tab';
import { TaskDetailView } from '@/components/kortix/task-detail-view';
import { NewTaskDialog } from '@/components/kortix/new-task-dialog';
import { TicketBoard } from '@/components/kortix/ticket-board';
import { TicketDetailDrawer } from '@/components/kortix/ticket-detail-drawer';
import { NewTicketDialog } from '@/components/kortix/new-ticket-dialog';
import { TeamTab } from '@/components/kortix/team-tab';
import { TicketSettingsTab } from '@/components/kortix/ticket-settings-tab';
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

  // Unread notifications for the current user. Recomputed on every activity
  // tick against the last-seen timestamp saved in localStorage.
  const [lastSeenAt, setLastSeenAt] = useState<string | null>(null);
  useEffect(() => {
    if (!loadV2 || !project?.id || !userHandle) return;
    setLastSeenAt(readLastSeen(project.id, userHandle));
  }, [loadV2, project?.id, userHandle]);
  const unread = useMemo(
    () => computeUnread(activity, userHandle, lastSeenAt),
    [activity, userHandle, lastSeenAt],
  );

  // Clear notifications once the user has the board visible — a short delay
  // so they actually see the badge before it zeroes out, and only if the
  // route is currently active (not when the project page is a hidden tab).
  useEffect(() => {
    if (!loadV2 || !project?.id || !userHandle) return;
    if (tab !== 'board' || !isProjectRouteActive) return;
    if (!unread.latestAt) return;
    const t = setTimeout(() => {
      const iso = unread.latestAt!;
      writeLastSeen(project.id, userHandle, iso);
      setLastSeenAt(iso);
    }, 2000);
    return () => clearTimeout(t);
  }, [tab, isProjectRouteActive, loadV2, project?.id, userHandle, unread.latestAt]);

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

  const setTab = useCallback((next: ProjectTab) => setTabState(next), []);
  const openTask = useCallback((task: KortixTask) => setOpenTaskId(task.id), []);
  const closeTask = useCallback(() => setOpenTaskId(null), []);
  const openTicket = useCallback((t: Ticket) => setOpenTicketId(t.id), []);
  const closeTicket = useCallback(() => setOpenTicketId(null), []);

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
        tabBadges={isV2 ? { board: unread.total } : undefined}
        rightSlot={isV2 ? (
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
            onOpenTicket={(id) => setOpenTicketId(id)}
          />
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
            <TabPanel active={tab === 'team'}>
              <TeamTab projectId={project.id} />
            </TabPanel>
            <TabPanel active={tab === 'settings'}>
              <TicketSettingsTab projectId={project.id} />
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
          <SessionsList sessions={sessionList} />
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

function SessionsList({ sessions }: { sessions: any[] }) {
  if (sessions.length === 0)
    return <EmptyState text="No sessions linked" sub="Sessions appear here when you select this project" />;
  const parents = sessions
    .filter((s) => !s.parentID)
    .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
  const children = sessions.filter((s) => !!s.parentID);
  const childrenByParent = new Map<string, any[]>();
  for (const c of children) {
    const list = childrenByParent.get(c.parentID) || [];
    list.push(c);
    childrenByParent.set(c.parentID, list);
  }
  const parentIds = new Set(parents.map((p) => p.id));
  const orphans = children.filter((c) => !parentIds.has(c.parentID));
  const openSession = (s: any) =>
    openTabAndNavigate({ id: s.id, title: s.title || 'Session', type: 'session', href: `/sessions/${s.id}` });

  return (
    <div className="flex-1 overflow-y-auto bg-background">
      <div className="container mx-auto max-w-7xl px-3 sm:px-4 py-4">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Session</TableHead>
              <TableHead className="w-[90px] text-right">Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {parents.map((s: any) => {
              const kids = childrenByParent.get(s.id) || [];
              return (
                <Fragment key={s.id}>
                  <TableRow onClick={() => openSession(s)} className="cursor-pointer group">
                    <TableCell className="text-[13px] text-foreground/85 truncate max-w-0 group-hover:text-foreground">
                      {s.title || 'Untitled session'}
                    </TableCell>
                    <TableCell className="text-[11px] text-muted-foreground/35 tabular-nums text-right">
                      {relativeTime(s.time?.updated)}
                    </TableCell>
                  </TableRow>
                  {kids.map((child: any) => (
                    <TableRow key={child.id} onClick={() => openSession(child)} className="cursor-pointer group">
                      <TableCell className="text-[13px] truncate max-w-0 pl-8">
                        <span className="text-muted-foreground/30 mr-2">└</span>
                        <span className="text-foreground/70 group-hover:text-foreground">
                          {child.task ? child.task.title : (child.title || 'Worker session')}
                        </span>
                        {child.task && (
                          <span className="ml-2 text-[10px] text-muted-foreground/40 font-mono">
                            {child.task.status}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-[11px] text-muted-foreground/35 tabular-nums text-right">
                        {relativeTime(child.time?.updated)}
                      </TableCell>
                    </TableRow>
                  ))}
                </Fragment>
              );
            })}
            {orphans.map((s: any) => (
              <TableRow key={s.id} onClick={() => openSession(s)} className="cursor-pointer group">
                <TableCell className="text-[13px] truncate max-w-0 pl-8">
                  <span className="text-muted-foreground/30 mr-2">└</span>
                  <span className="text-foreground/70 group-hover:text-foreground">
                    {s.task ? s.task.title : (s.title || 'Worker session')}
                  </span>
                </TableCell>
                <TableCell className="text-[11px] text-muted-foreground/35 tabular-nums text-right">
                  {relativeTime(s.time?.updated)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
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
