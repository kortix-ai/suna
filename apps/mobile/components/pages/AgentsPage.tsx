/**
 * AgentsPage — the project's OpenCode agents (web parity: customize/agents).
 * The agents declared under `.kortix/opencode/agents/`; a tap shows the agent's
 * markdown source. Authoring flows through a session (New / Edit). The one
 * direct write is "Set as default agent" on a primary agent: the agent a new
 * session runs on when the user picks none.
 *
 * Layout and behaviour: `ConfigEntriesPage`, shared with the Skills page.
 */
import * as React from 'react';

import { useToast } from '@/components/kortix/toast-provider';
import { ConfigEntriesPage } from '@/components/pages/ConfigEntriesPage';
import { haptics } from '@/lib/haptics';
import { useProjectDetail, useSetProjectDefaultAgent } from '@/lib/projects/hooks';

interface AgentsPageProps {
  page: { id: string; label: string };
  projectId: string;
  /** Start an agent-led config session seeded with `prompt` (New / Edit). */
  onConfigure: (prompt: string) => void;
  onOpenDrawer?: () => void;
  onOpenRightDrawer?: () => void;
  isDrawerOpen?: boolean;
  isRightDrawerOpen?: boolean;
}

export function AgentsPage({
  page,
  projectId,
  onConfigure,
  onOpenDrawer,
  onOpenRightDrawer,
  isRightDrawerOpen,
}: AgentsPageProps) {
  const toast = useToast();
  const { data, isLoading, isError, error, refetch } = useProjectDetail(projectId);
  const setDefault = useSetProjectDefaultAgent(projectId);

  const handleSetDefault = React.useCallback(
    (name: string) => {
      haptics.tap();
      setDefault.mutate(name, {
        onError: (mutationError) =>
          toast.error((mutationError as Error)?.message ?? 'Unable to set the default agent'),
      });
    },
    [setDefault, toast],
  );

  return (
    <ConfigEntriesPage
      kind="agent"
      noun="agents"
      title={page.label}
      projectId={projectId}
      entries={data?.config?.agents ?? []}
      isLoading={isLoading}
      errorMessage={isError ? ((error as Error)?.message ?? 'Unable to load agents') : null}
      onRetry={() => void refetch()}
      defaultName={data?.config?.default_agent ?? data?.config?.open_code_default_agent ?? null}
      onSetDefault={handleSetDefault}
      settingDefault={setDefault.isPending}
      onConfigure={onConfigure}
      onOpenDrawer={onOpenDrawer}
      onOpenRightDrawer={onOpenRightDrawer}
      isRightDrawerOpen={isRightDrawerOpen}
    />
  );
}
