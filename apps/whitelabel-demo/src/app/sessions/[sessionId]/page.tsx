import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SessionWorkbench } from '@/features/session/session-workbench';
import { AppShell } from '@/features/shell/app-shell';
import { PageHeader } from '@/features/shell/page-header';
import { requireCurrentUser } from '@/lib/auth';
import { getKortix } from '@/lib/kortix';
import { findRunForUser, listRunsForUser } from '@/lib/store';

export default async function SessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const user = await requireCurrentUser();
  const { sessionId } = await params;
  const runs = await listRunsForUser(user.id);
  const run = await findRunForUser(user.id, sessionId);

  if (!run) {
    return (
      <AppShell email={user.email} runs={runs} activeSessionId={sessionId}>
        <PageHeader>
          <span className="truncate text-sm font-medium">Session not found</span>
        </PageHeader>
        <div className="grid flex-1 place-items-center p-8">
          <div className="text-center">
            <p className="text-muted-foreground text-sm">
              This workspace has no local mapping for that session.
            </p>
            <Button asChild className="mt-4">
              <Link href="/">Start a new session</Link>
            </Button>
          </div>
        </div>
      </AppShell>
    );
  }

  let initialError: string | null = null;
  try {
    await getKortix().sessions.get({ projectId: run.projectId, sessionId: run.sessionId });
  } catch (error) {
    initialError = error instanceof Error ? error.message : 'Could not load the session.';
  }

  return (
    <AppShell email={user.email} runs={runs} activeSessionId={run.sessionId}>
      <PageHeader>
        <span className="truncate text-sm font-medium">{run.title}</span>
        <Badge variant="muted" size="xs" className="shrink-0 capitalize">
          {run.mode}
        </Badge>
        <span className="text-muted-foreground ml-auto hidden shrink-0 font-mono text-xs sm:inline">
          {run.projectId.slice(0, 8)}
        </span>
      </PageHeader>

      {initialError ? (
        <div className="shrink-0 px-4 pt-3">
          <div className="border-destructive/30 bg-destructive/10 text-destructive mx-auto max-w-3xl rounded-lg border px-3 py-2 text-sm">
            {initialError}
          </div>
        </div>
      ) : null}

      <SessionWorkbench sessionId={run.sessionId} prompt={run.prompt} />
    </AppShell>
  );
}
