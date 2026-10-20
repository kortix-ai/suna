import type { ProjectSessionStatus } from '@kortix/sdk';
import { useKortixAppViewer } from '@kortix/sdk/react';
import { cn } from '@kortix/ui';
import { EmptyState } from '@kortix/ui/empty-state';
import { KortixLogo } from '@kortix/ui/kortix-logo';
import Loading from '@kortix/ui/loading';
import { LocalTime } from '@kortix/ui/local-time';
import { StatusBadge, type StatusTone } from '@kortix/ui/status';
import { LockKey } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { DashboardPage } from './pages/dashboard';
import { ProjectPage } from './pages/project';
import { ProjectsPage } from './pages/projects';
import { SessionPage } from './pages/session';
import { Link, usePathname } from './router';

export function App() {
  const { status, viewer } = useKortixAppViewer();
  const path = usePathname();

  if (status === 'loading') return <Centered><Loading className="size-5 text-muted-foreground" /></Centered>;
  if (status === 'anonymous' || !viewer?.access_token) {
    return (
      <Centered>
        <EmptyState
          icon={LockKey}
          title="Open this app from Kortix"
          description="It signs you in with your Kortix login. Deploy it with --viewer api, or set KORTIX_API_KEY for local dev."
        />
      </Centered>
    );
  }

  const session = path.match(/^\/projects\/([^/]+)\/sessions\/([^/]+)$/);
  if (session) return <SessionPage projectId={session[1]!} sessionId={session[2]!} />;

  const project = path.match(/^\/projects\/([^/]+)$/);
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-12 shrink-0 items-center gap-6 border-b px-5">
        <Link href="/" className="flex items-center gap-2 text-sm font-medium">
          <KortixLogo variant="icon" size={16} />
          Team Console
        </Link>
        <nav className="flex gap-4 text-sm">
          <NavLink href="/" active={path === '/' || !!project}>Projects</NavLink>
          <NavLink href="/dashboard" active={path === '/dashboard'}>Dashboard</NavLink>
        </nav>
        <span className="ml-auto text-xs text-muted-foreground">{viewer.name ?? viewer.email ?? viewer.user_id}</span>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-5 py-6">
        {path === '/dashboard' ? <DashboardPage /> : project ? <ProjectPage projectId={project[1]!} /> : <ProjectsPage />}
      </main>
    </div>
  );
}

function NavLink({ href, active, children }: { href: string; active: boolean; children: ReactNode }) {
  return (
    <Link href={href} className={cn('text-muted-foreground hover:text-foreground', active && 'text-foreground')}>
      {children}
    </Link>
  );
}

export function Centered({ children }: { children: ReactNode }) {
  return <div className="grid min-h-dvh place-items-center bg-background p-6">{children}</div>;
}

const TONES: Record<ProjectSessionStatus, StatusTone> = {
  queued: 'info',
  branching: 'info',
  provisioning: 'info',
  running: 'success',
  stopped: 'neutral',
  completed: 'neutral',
  failed: 'destructive',
};

export function SessionStatus({ status }: { status: ProjectSessionStatus }) {
  return <StatusBadge tone={TONES[status] ?? 'neutral'}>{status}</StatusBadge>;
}

export function PageTitle({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-5 flex items-center gap-3">
      <h1 className="text-lg font-medium">{title}</h1>
      <div className="ml-auto flex items-center gap-2">{children}</div>
    </div>
  );
}

/** A table row's primary link. The stretched hit area makes the whole row clickable. */
export function RowLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="after:absolute after:inset-0 hover:underline">
      {children}
    </Link>
  );
}

export function When({ value }: { value: string }) {
  return <LocalTime value={value} options={{ dateStyle: 'medium', timeStyle: 'short' }} />;
}
