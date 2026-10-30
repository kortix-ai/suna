import { useSession } from '@kortix/sdk/react';
import { SessionThread } from '@kortix/ui/session';
import { ArrowLeft } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { kortix } from '../kortix';
import { Link } from '../router';

/** One session: the same thread apps/web renders, over the one useSession hook. */
export function SessionPage({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const session = useSession(projectId, sessionId);
  const project = useQuery({ queryKey: ['project', projectId], queryFn: () => kortix.project(projectId).get() });
  return (
    <div className="flex h-dvh flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-5 text-sm">
        <Link href={`/projects/${projectId}`} className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground">
          <ArrowLeft />
          {project.data?.name ?? 'Project'}
        </Link>
      </header>
      <SessionThread session={session} hideHeader className="min-h-0 flex-1" />
    </div>
  );
}
