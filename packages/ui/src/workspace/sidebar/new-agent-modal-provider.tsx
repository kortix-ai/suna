'use client';

import { useProjectConfig } from '@kortix/sdk/react';
import { type ReactNode, useCallback, useState } from 'react';
import { CreateAgentModal } from '../../customize/agents/create-agent-modal';
import { NewAgentContext } from '../../internal/layout/project-capability-nav';

/**
 * The sidebar's New agent opens the create modal in place, with no
 * navigation. The modal is mounted here, beside `<Sidebar>`, never inside it:
 * on mobile the sidebar is a sheet that unmounts its content when it closes,
 * and New agent closes it, so a modal inside it shut the moment it opened.
 * `null` until the first click, so the modal and its hooks mount only when used.
 */
export function NewAgentModalProvider({ projectId, children }: { projectId: string; children: ReactNode }) {
  const config = useProjectConfig(projectId);
  const [open, setOpen] = useState<boolean | null>(null);
  const openModal = useCallback(() => setOpen(true), []);
  return (
    <NewAgentContext.Provider value={openModal}>
      {children}
      {open !== null ? (
        <CreateAgentModal open={open} onOpenChange={setOpen} projectId={projectId} config={config ?? null} />
      ) : null}
    </NewAgentContext.Provider>
  );
}

