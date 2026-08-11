'use client';

import { useTranslations } from 'next-intl';
/**
 * Visual harness for the unified <SharingPicker> (secrets / connectors /
 * sessions all use it). Auth-free: seeds the workspace-access query so the member
 * list renders without an API call. Open /debug/sharing.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

import { SharingPicker, type SharingSelection } from '@/features/workspace/shared/sharing-picker';
import type { WorkspaceAccessResponse } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';

const DEMO_WORKSPACE = 'demo';
const DEMO_ACCESS: WorkspaceAccessResponse = {
  workspace_id: DEMO_WORKSPACE,
  account_id: 'demo-account',
  can_manage: true,
  viewer_user_id: 'u1',
  members: [
    {
      user_id: 'u1',
      email: 'marko@kortix.ai',
      account_role: 'owner',
      workspace_role: 'editor',
      effective_workspace_role: 'editor',
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
      workspace_role: 'editor',
      effective_workspace_role: 'editor',
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
      workspace_role: 'member',
      effective_workspace_role: 'member',
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
      workspace_role: 'member',
      effective_workspace_role: 'member',
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
      workspace_role: 'member',
      effective_workspace_role: 'member',
      has_implicit_access: false,
      joined_at: '',
      granted_by: null,
      granted_at: null,
      updated_at: null,
    },
  ],
};

const client = new QueryClient();
client.setQueryData(qk.workspace.access(DEMO_WORKSPACE), DEMO_ACCESS);

function Panel({ title }: { title: string }) {
  const [value, setValue] = useState<SharingSelection>({ mode: 'members', memberIds: ['u2'], groupIds: [] });
  return (
    <div className="border-border/60 bg-card w-[420px] rounded-2xl border p-5">
      <h2 className="text-foreground mb-3 text-base font-semibold">{title}</h2>
      <SharingPicker workspaceId={DEMO_WORKSPACE} value={value} onChange={setValue} />
      <pre className="bg-muted text-muted-foreground mt-4 rounded-lg px-3 py-2 text-xs">
        {JSON.stringify(value)}
      </pre>
    </div>
  );
}

export default function DebugSharingPage() {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  return (
    <QueryClientProvider client={client}>
      <div className="bg-background min-h-screen p-10">
        <h1 className="text-foreground mb-6 text-lg font-semibold">
          {tI18nHardcoded.raw(
            'autoAppSystemDebugSharingPageJsxTextSharingPickerVisualHarness45b06d33',
          )}
        </h1>
        <div className="flex flex-wrap gap-6">
          <Panel
            title={tI18nHardcoded.raw(
              'autoAppSystemDebugSharingPageJsxAttrTitleShareSessiona4e430a9',
            )}
          />
        </div>
      </div>
    </QueryClientProvider>
  );
}
