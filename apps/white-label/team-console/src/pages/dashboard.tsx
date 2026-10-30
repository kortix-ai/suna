import type { ProjectSession } from '@kortix/sdk';
import { ErrorState } from '@kortix/ui/error-state';
import Loading from '@kortix/ui/loading';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@kortix/ui/table';
import { useQueries } from '@tanstack/react-query';
import { PageTitle, RowLink, SessionStatus, When } from '../app';
import { kortix } from '../kortix';
import { useProjects } from './projects';

/**
 * The view Kortix does not ship: every session across every project you can
 * open, newest activity first, in one table. Built from two SDK calls.
 */
export function DashboardPage() {
  const projects = useProjects();
  const active = (projects.data ?? []).filter((p) => p.status === 'active');
  // ponytail: first 50 root sessions per project; page with listPage().next_cursor for more.
  const lists = useQueries({
    queries: active.map((p) => ({
      queryKey: ['sessions', p.project_id],
      queryFn: () => kortix.project(p.project_id).sessions.list({ parent: 'root', limit: 50 }),
      refetchInterval: 10_000,
    })),
  });

  if (projects.isPending || lists.some((l) => l.isPending)) return <Loading className="size-5 text-muted-foreground" />;
  if (projects.isError) return <ErrorState title="Could not load projects" description={String(projects.error)} />;

  // A project whose list failed (403, 5xx) drops out of the rows and the totals, so say so.
  const failedProjects = active.filter((_, i) => lists[i]?.isError).map((p) => p.name);
  if (active.length > 0 && failedProjects.length === active.length) {
    return <ErrorState title="Could not load sessions" description={String(lists[0]?.error)} />;
  }

  const names = new Map(active.map((p) => [p.project_id, p.name]));
  const rows: ProjectSession[] = lists
    .flatMap((l) => l.data ?? [])
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  const running = rows.filter((s) => s.status === 'running').length;
  const failed = rows.filter((s) => s.status === 'failed').length;

  return (
    <>
      <PageTitle title="Dashboard" />
      <div className="mb-5 grid grid-cols-3 gap-3">
        <Stat label="Sessions" value={rows.length} />
        <Stat label="Running" value={running} />
        <Stat label="Failed" value={failed} />
      </div>
      {failedProjects.length > 0 && (
        <p role="status" className="mb-3 text-sm text-destructive">
          Could not load sessions for {failedProjects.length} project{failedProjects.length === 1 ? '' : 's'} ({failedProjects.join(', ')}). The rows and totals leave them out.
        </p>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Session</TableHead>
            <TableHead>Project</TableHead>
            <TableHead>Agent</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Last activity</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((s) => (
            <TableRow key={s.session_id} className="relative">
              <TableCell className="max-w-72 truncate font-medium">
                <RowLink href={`/projects/${s.project_id}/sessions/${s.session_id}`}>{s.name ?? 'Untitled session'}</RowLink>
              </TableCell>
              <TableCell className="text-muted-foreground">{names.get(s.project_id)}</TableCell>
              <TableCell className="text-muted-foreground">{s.agent_name ?? 'default'}</TableCell>
              <TableCell><SessionStatus status={s.status} /></TableCell>
              <TableCell className="text-right text-muted-foreground"><When value={s.updated_at} /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-medium tabular-nums">{value}</div>
    </div>
  );
}
