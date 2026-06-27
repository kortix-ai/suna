'use client';

import { ApiKeyGate } from '@/components/api-key-gate';
import { BrandMark } from '@/components/brand-mark';
import { Button, Card, Spinner } from '@/components/ui';
import { clearApiKey, getApiKey, kortix } from '@/lib/kortix';
import { relativeTime } from '@/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { FolderGit2, LogOut } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

export default function Home() {
  const [ready, setReady] = useState<boolean | null>(null);
  useEffect(() => setReady(!!getApiKey()), []);

  if (ready === null) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner />
      </div>
    );
  }
  if (!ready) return <ApiKeyGate onReady={() => setReady(true)} />;
  return (
    <Dashboard
      onDisconnect={() => {
        clearApiKey();
        setReady(false);
      }}
    />
  );
}

function Dashboard({ onDisconnect }: { onDisconnect: () => void }) {
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => kortix.projects.list() });
  const items = projects.data ?? [];

  return (
    <div className="mx-auto min-h-dvh max-w-3xl px-5 py-6">
      <header className="flex items-center justify-between">
        <BrandMark />
        <Button variant="ghost" size="sm" onClick={onDisconnect}>
          <LogOut className="size-4" /> Disconnect
        </Button>
      </header>

      <div className="mt-10">
        <h1 className="text-xl font-semibold tracking-tight text-[var(--color-fg)]">Projects</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Each project is a git repo. Open one to run an agent session against it.
        </p>
      </div>

      <div className="mt-5 space-y-2">
        {projects.isLoading && (
          <div className="flex items-center gap-2 py-8 text-sm text-[var(--color-muted)]">
            <Spinner /> Loading projects…
          </div>
        )}
        {projects.isError && (
          <Card className="p-4 text-sm text-red-400">
            Couldn&apos;t load projects — check your API key.{' '}
            <button className="underline" onClick={onDisconnect}>
              Reconnect
            </button>
          </Card>
        )}
        {projects.isSuccess && items.length === 0 && (
          <Card className="p-6 text-center text-sm text-[var(--color-muted)]">
            No projects yet. Create one in your Kortix dashboard, then refresh.
          </Card>
        )}
        {items.map((p) => (
          <Link key={p.project_id} href={`/projects/${p.project_id}`}>
            <Card className="flex items-center gap-3 p-4 transition-colors hover:bg-[var(--color-panel-2)]">
              <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--color-panel-2)]">
                <FolderGit2 className="size-4 text-[var(--color-muted)]" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-[var(--color-fg)]">{p.name}</div>
                <div className="truncate text-xs text-[var(--color-muted)]">
                  {p.updated_at ? `Updated ${relativeTime(p.updated_at)}` : p.project_id}
                </div>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
