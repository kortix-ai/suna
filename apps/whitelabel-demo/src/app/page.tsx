import { Activity, GitBranch, Server } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { brand } from '@/config/brand';
import { HomeComposer } from '@/features/home/home-composer';
import { AppShell } from '@/features/shell/app-shell';
import { PageHeader } from '@/features/shell/page-header';
import { requireCurrentUser } from '@/lib/auth';
import { listRunsForUser } from '@/lib/store';

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await requireCurrentUser();
  const runs = await listRunsForUser(user.id);
  const params = await searchParams;

  return (
    <AppShell email={user.email} runs={runs}>
      <PageHeader>
        <span className="truncate text-sm font-medium">{brand.workspaceName}</span>
        <Badge variant="muted" size="xs" className="shrink-0">
          Home
        </Badge>
      </PageHeader>

      <div className="scrollbar-minimal flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col px-6 pt-[12vh] pb-16">
          <header className="mb-7 text-center">
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              What should we build?
            </h1>
            <p className="text-muted-foreground mt-2 text-[15px]">
              Describe a task and {brand.name} will spin up a workspace {brand.sessionNoun} on the
              backend.
            </p>
          </header>

          {params.error ? (
            <div className="border-destructive/30 bg-destructive/10 text-destructive mb-4 rounded-lg border px-3 py-2 text-sm">
              {params.error}
            </div>
          ) : null}

          <HomeComposer />

          <section className="mt-12 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <OverviewCard
              icon={<Activity className="size-4" />}
              label="Sessions"
              value={String(runs.length)}
              hint="in this workspace"
            />
            <OverviewCard
              icon={<Server className="size-4" />}
              label="Backend"
              value={brand.poweredBy ?? 'Connected'}
              hint="source of truth"
            />
            <OverviewCard
              icon={<GitBranch className="size-4" />}
              label="Runtime"
              value="Git workspace"
              hint="per-session branch"
            />
          </section>

          <p className="text-muted-foreground mt-8 text-center text-xs leading-relaxed text-balance">
            This frontend owns only the white-label auth and a local mapping to backend session ids.
            Projects, branches, sandboxes, tool calls, and artifacts remain the backend source of
            truth.
          </p>
        </div>
      </div>
    </AppShell>
  );
}

function OverviewCard({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="border-border bg-card rounded-xl border p-4">
      <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium">
        {icon}
        {label}
      </div>
      <p className="mt-2 truncate text-lg font-semibold">{value}</p>
      <p className="text-muted-foreground text-xs">{hint}</p>
    </div>
  );
}
