'use client';

/**
 * Visual harness for the unified <SharingPicker> (secrets / connectors /
 * sessions all use it). Auth-free: seeds the project-access query so the member
 * list renders without an API call. Open /debug/sharing.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

import { SharingPicker, type SharingSelection } from '@/features/co-worker/shared/sharing-picker';
import type { ProjectAccessResponse } from '@/lib/projects-client';

const DEMO_PROJECT = 'demo';
const DEMO_ACCESS: ProjectAccessResponse = {
  project_id: DEMO_PROJECT,
  account_id: 'demo-account',
  can_manage: true,
  viewer_user_id: 'u1',
  members: [
    {
      user_id: 'u1',
      email: 'marko@kortix.ai',
      account_role: 'owner',
      project_role: 'manager',
      effective_project_role: 'manager',
      has_implicit_access: true,
      joined_at: '',
      granted_by: null,
      granted_at: null,
      updated_at: null,
    },
    {
      user_id: 'u2',
      email: 'marko@softgen.ai',
      account_role: 'member',
      project_role: 'editor',
      effective_project_role: 'editor',
      has_implicit_access: false,
      joined_at: '',
      granted_by: null,
      granted_at: null,
      updated_at: null,
    },
    {
      user_id: 'u3',
      email: 'ana@kortix.ai',
      account_role: 'member',
      project_role: 'viewer',
      effective_project_role: 'viewer',
      has_implicit_access: false,
      joined_at: '',
      granted_by: null,
      granted_at: null,
      updated_at: null,
    },
    {
      user_id: 'u4',
      email: 'ben.long.email@partner.example.com',
      account_role: 'member',
      project_role: 'viewer',
      effective_project_role: 'viewer',
      has_implicit_access: false,
      joined_at: '',
      granted_by: null,
      granted_at: null,
      updated_at: null,
    },
    {
      user_id: 'u5',
      email: 'chen@kortix.ai',
      account_role: 'member',
      project_role: 'viewer',
      effective_project_role: 'viewer',
      has_implicit_access: false,
      joined_at: '',
      granted_by: null,
      granted_at: null,
      updated_at: null,
    },
  ],
};

const client = new QueryClient();
client.setQueryData(['project-access', DEMO_PROJECT], DEMO_ACCESS);

function Panel({ title }: { title: string }) {
  const [value, setValue] = useState<SharingSelection>({ mode: 'members', memberIds: ['u2'] });
  return (
    <div className="border-border/60 bg-card w-[420px] rounded-2xl border p-5">
      <h2 className="text-foreground mb-3 text-base font-semibold">{title}</h2>
      <SharingPicker projectId={DEMO_PROJECT} value={value} onChange={setValue} />
      <pre className="bg-muted text-muted-foreground mt-4 rounded-lg px-3 py-2 text-xs">
        {JSON.stringify(value)}
      </pre>
    </div>
  );
}

export default function DebugSharingPage() {
  return (
    <QueryClientProvider client={client}>
      <div className="bg-background min-h-screen p-10">
        <h1 className="text-foreground mb-6 text-lg font-semibold">
          SharingPicker — visual harness
        </h1>
        <div className="flex flex-wrap gap-6">
          <Panel title="Share session" />
        </div>
      </div>
    </QueryClientProvider>
  );
}
