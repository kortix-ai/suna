'use client';

/**
 * Project page.
 *
 * Tabs: Overview, Tasks, Files, Sessions — pre-mounted, CSS-hidden when inactive.
 * All real UI lives in extracted components.
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
} from '@/hooks/kortix/use-kortix-projects';
import {
  useKortixTasks,
  useStartKortixTask,
  useApproveKortixTask,
  useDeleteKortixTask,
  type KortixTask,
  type KortixTaskStatus,
} from '@/hooks/kortix/use-kortix-tasks';
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
import { ProjectMembersTab } from '@/components/kortix/project-members-tab';
import { TasksTab } from '@/components/kortix/tasks-tab';
import { TaskDetailView } from '@/components/kortix/task-detail-view';
import { NewTaskDialog } from '@/components/kortix/new-task-dialog';
import { useIsRouteActive } from '@/hooks/utils/use-is-route-active';

export default function ProjectPage({ params }: { params?: Promise<{ id: string }> }) {
  const { id: raw } = params ? use(params) : { id: '' };
  const pid = raw ? decodeURIComponent(raw) : '';
  const projectFilesStoreRef = useRef(createFilesStore());
  const projectFilesStore = projectFilesStoreRef.current;

  // ── Tabs ────────────────────────────────────────────────────
  const [tab, setTabState] = useState<ProjectTab>('about');
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const isProjectRouteActive = useIsRouteActive(`/projects/${encodeURIComponent(pid)}`);
  const shouldLoadProjectSessions = isProjectRouteActive && tab === 'sessions';
  const shouldLoadProjectTasks = isProjectRouteActive && tab === 'tasks';

  // ── Data ────────────────────────────────────────────────────
  const { data: project, isLoading } = useKortixProject(pid);
  const { data: sessions } = useKortixProjectSessions(pid, {
    enabled: shouldLoadProjectSessions,
  });
  const { data: tasks } = useKortixTasks(project?.id, undefined, {
    enabled: shouldLoadProjectTasks,
    pollingEnabled: shouldLoadProjectTasks,
  });
  const startTask = useStartKortixTask();
  const approveTask = useApproveKortixTask();
  const deleteTask = useDeleteKortixTask();

  const sessionList = useMemo(() => sessions ?? [], [sessions]);
  const taskList = useMemo<KortixTask[]>(() => tasks ?? [], [tasks]);

  // ── File explorer scoping ───────────────────────────────────
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

  const setTab = useCallback((next: ProjectTab) => {
    setTabState(next);
  }, []);
  const openTask = useCallback((task: KortixTask) => {
    setOpenTaskId(task.id);
  }, []);
  const closeTask = useCallback(() => setOpenTaskId(null), []);

  // Re-navigate file explorer when files tab activated
  useEffect(() => {
    if (tab === 'files' && project?.path && project.path !== '/') {
      projectFilesStore.getState().navigateToPath(project.path);
    }
  }, [tab, project?.path, projectFilesStore]);

  // ── Tasks view state ────────────────────────────────────────
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  // ── New task dialog ─────────────────────────────────────────
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newTaskDefault, setNewTaskDefault] = useState<KortixTaskStatus | undefined>();
  const openNewTask = useCallback((status?: KortixTaskStatus) => {
    setNewTaskDefault(status);
    setNewTaskOpen(true);
  }, []);

  // ── Filtered tasks ──────────────────────────────────────────
  const filteredTasks = useMemo(() => {
    if (!search.trim()) return taskList;
    const q = search.toLowerCase();
    return taskList.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        (t.description || '').toLowerCase().includes(q),
    );
  }, [taskList, search]);

  // ── Keyboard shortcuts (tasks tab only) ─────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isProjectRouteActive || newTaskOpen || e.repeat) return;

      const inField =
        document.activeElement?.tagName === 'INPUT' ||
        document.activeElement?.tagName === 'TEXTAREA' ||
        (document.activeElement as HTMLElement | null)?.isContentEditable;

      if (e.key === '/' && tab === 'tasks' && !inField) {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (
        (e.key === 'c' || e.key === 'C') &&
        !inField &&
        !e.metaKey &&
        !e.ctrlKey
      ) {
        e.preventDefault();
        setNewTaskOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab, isProjectRouteActive, newTaskOpen]);

  // ── Loading / 404 ───────────────────────────────────────────
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
        onNewTask={() => openNewTask()}
      />

      {/* ── Pre-mounted tab bodies ─────────────────────────── */}
      <div className="flex-1 min-h-0 relative">
        <TabPanel active={tab === 'about'}>
          <ProjectAbout project={project} />
        </TabPanel>

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

        <TabPanel active={tab === 'members'}>
          <ProjectMembersTab project={project} />
        </TabPanel>
      </div>

      {/* New task dialog — always mounted */}
      <NewTaskDialog
        open={newTaskOpen}
        onOpenChange={setNewTaskOpen}
        projectId={project.id}
        projectName={project.name}
        projectPath={project.path}
        defaultStatus={newTaskDefault}
      />

      {/* Task detail modal */}
      <TaskDetailView
        taskId={openTaskId}
        onClose={closeTask}
        projectName={project.name}
        pollingEnabled={isProjectRouteActive && !!openTaskId}
      />
    </div>
  );
}

// ───────────────────────────────────────────────────────────────
// Tiny helpers
// ───────────────────────────────────────────────────────────────

function TabPanel({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('absolute inset-0 flex flex-col overflow-hidden', !active && 'hidden')}>
      {children}
    </div>
  );
}

function SessionsList({ sessions }: { sessions: any[] }) {
  if (sessions.length === 0)
    return <EmptyState text="No sessions linked" sub="Sessions appear here when you select this project" />;

  // Separate parent and child sessions
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
  // Orphaned children (parent not in our list)
  const parentIds = new Set(parents.map((p) => p.id));
  const orphans = children.filter((c) => !parentIds.has(c.parentID));

  const openSession = (s: any) =>
    openTabAndNavigate({
      id: s.id,
      title: s.title || 'Session',
      type: 'session',
      href: `/sessions/${s.id}`,
    });

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
                  <TableRow
                    onClick={() => openSession(s)}
                    className="cursor-pointer group"
                  >
                    <TableCell className="text-[13px] text-foreground/85 truncate max-w-0 group-hover:text-foreground">
                      {s.title || 'Untitled session'}
                    </TableCell>
                    <TableCell className="text-[11px] text-muted-foreground/35 tabular-nums text-right">
                      {relativeTime(s.time?.updated)}
                    </TableCell>
                  </TableRow>
                  {kids.map((child: any) => (
                    <TableRow
                      key={child.id}
                      onClick={() => openSession(child)}
                      className="cursor-pointer group"
                    >
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
              <TableRow
                key={s.id}
                onClick={() => openSession(s)}
                className="cursor-pointer group"
              >
                <TableCell className="text-[13px] truncate max-w-0 pl-8">
                  <span className="text-muted-foreground/30 mr-2">└</span>
                  <span className="text-foreground/70 group-hover:text-foreground">
                    {s.task ? s.task.title : (s.title || 'Worker session')}
                  </span>
                  {s.task && (
                    <span className="ml-2 text-[10px] text-muted-foreground/40 font-mono">
                      {s.task.status}
                    </span>
                  )}
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
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-6 w-16 rounded" />
          ))}
        </div>
        <Skeleton className="h-[400px] rounded-lg" />
      </div>
    </div>
  );
}
