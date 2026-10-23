import { generateSessionId } from '@kortix/sdk';
import { Button } from '@kortix/ui/button';
import { EmptyState } from '@kortix/ui/empty-state';
import { ErrorState } from '@kortix/ui/error-state';
import Loading from '@kortix/ui/loading';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@kortix/ui/table';
import { errorToast } from '@kortix/ui/toast';
import { ChatCircle, Plus } from '@phosphor-icons/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { PageTitle, RowLink, SessionStatus, When } from '../app';
import { kortix } from '../kortix';
import { navigate } from '../router';

export function ProjectPage({ projectId }: { projectId: string }) {
  const project = useQuery({ queryKey: ['project', projectId], queryFn: () => kortix.project(projectId).get() });
  const sessions = useQuery({
    queryKey: ['sessions', projectId],
    queryFn: () => kortix.project(projectId).sessions.list({ parent: 'root', limit: 50 }),
  });
  const create = useMutation({
    mutationFn: async () => {
      const sessionId = generateSessionId();
      await kortix.project(projectId).sessions.create({ session_id: sessionId });
      return sessionId;
    },
    onSuccess: (sessionId) => navigate(`/projects/${projectId}/sessions/${sessionId}`),
    onError: (error) => errorToast('Could not start a session', { description: String(error) }),
  });

  return (
    <>
      <PageTitle title={project.data?.name ?? 'Project'}>
        <Button size="sm" onClick={() => create.mutate()} disabled={create.isPending}>
          {create.isPending ? <Loading className="size-3.5" /> : <Plus />}
          New session
        </Button>
      </PageTitle>
      {sessions.isPending ? (
        <Loading className="size-5 text-muted-foreground" />
      ) : sessions.isError ? (
        <ErrorState title="Could not load sessions" description={String(sessions.error)} />
      ) : sessions.data.length === 0 ? (
        <EmptyState icon={ChatCircle} title="No sessions yet" description="Start one to put an agent to work in this project." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Session</TableHead>
              <TableHead>Agent</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Last activity</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions.data.map((s) => (
              <TableRow key={s.session_id} className="relative">
                <TableCell className="max-w-72 truncate font-medium">
                  <RowLink href={`/projects/${projectId}/sessions/${s.session_id}`}>{s.name ?? 'Untitled session'}</RowLink>
                </TableCell>
                <TableCell className="text-muted-foreground">{s.agent_name ?? 'default'}</TableCell>
                <TableCell><SessionStatus status={s.status} /></TableCell>
                <TableCell className="text-right text-muted-foreground"><When value={s.updated_at} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
