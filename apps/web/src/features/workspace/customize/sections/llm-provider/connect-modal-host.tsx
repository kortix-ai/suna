'use client';

import { useParams } from 'next/navigation';
import { useEffect } from 'react';
import { create } from 'zustand';

import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import type { HarnessAuthKind, HarnessId } from '@kortix/sdk/projects-client';
import { useModelsPage } from '@kortix/sdk/react';

import { ConnectModelModal } from './connect-model-modal';

export interface ConnectModalOpenOptions {
  /** Which section of the method list to land the user on. Not yet
   *  consumed by any migrated call site — reserved for callers that want a
   *  narrower first view than "everything compatible". */
  tab?: 'subscriptions' | 'api-keys';
  /** Preselect a specific "other provider" row instead of the method list. */
  providerId?: string;
  /** Preselect a specific connect method's form (e.g. `claude_subscription`)
   *  instead of the method list — the "Connect Claude Code" style deep link. */
  connectKind?: string;
  /** Restrict the method list to what a given runtime harness can use — the
   *  per-runtime-row "Connect" affordance in `models-view.tsx`. Internal-only:
   *  not part of the cross-task `useConnectModal()` contract, which callers
   *  outside this feature only need `tab`/`providerId`/`connectKind` for. */
  harnessFilter?: HarnessId | null;
}

interface ConnectModalStoreState extends ConnectModalOpenOptions {
  isOpen: boolean;
  open: (opts?: ConnectModalOpenOptions) => void;
  close: () => void;
}

const CLOSED: ConnectModalOpenOptions = {
  tab: undefined,
  providerId: undefined,
  connectKind: undefined,
  harnessFilter: null,
};

/**
 * The one "connect a model service" surface in the app — every CTA that used
 * to fork between a Customize-panel deep link, a locally-hosted modal, and a
 * project-off local modal (see `use-model-connection-gate.tsx`'s old
 * three-way branch) now sets this store instead. `ConnectModalHost` below is
 * the single place that actually renders `ConnectModelModal`.
 */
export const useConnectModalStore = create<ConnectModalStoreState>((set) => ({
  isOpen: false,
  ...CLOSED,
  open: (opts = {}) =>
    set({
      isOpen: true,
      tab: opts.tab,
      providerId: opts.providerId,
      connectKind: opts.connectKind,
      harnessFilter: opts.harnessFilter ?? null,
    }),
  close: () => set({ isOpen: false }),
}));

/** Public hook every connect CTA calls — the produced interface later tasks
 *  depend on. Deliberately narrower than the store: callers only ever need to
 *  open or close the surface, never read its state directly. */
export function useConnectModal(): {
  open: (opts?: ConnectModalOpenOptions) => void;
  close: () => void;
} {
  const open = useConnectModalStore((s) => s.open);
  const close = useConnectModalStore((s) => s.close);
  return { open, close };
}

/**
 * Store-driven `ConnectModelModal`, mounted once in the app shell
 * (`app-providers.tsx`) — same pattern as `GlobalUpgradeModal` /
 * `GlobalUserSettingsModal` there. The connect forms write project secrets,
 * so this needs a projectId; every migrated call site is project-scoped
 * (composer, Models page, harness pickers), so rendering nothing outside a
 * project route costs nothing today.
 */
export function ConnectModalHost() {
  const params = useParams<{ id?: string }>();
  const projectId = typeof params?.id === 'string' ? params.id : null;

  const isOpen = useConnectModalStore((s) => s.isOpen);
  const tab = useConnectModalStore((s) => s.tab);
  const providerId = useConnectModalStore((s) => s.providerId);
  const connectKind = useConnectModalStore((s) => s.connectKind);
  const harnessFilter = useConnectModalStore((s) => s.harnessFilter);
  const close = useConnectModalStore((s) => s.close);

  const canWrite =
    useProjectCan(projectId ?? undefined, PROJECT_ACTIONS.PROJECT_WRITE).allowed === true;
  const state = useModelsPage(projectId, canWrite);

  // Self-healing: a caller can call `open()` off-project (e.g. the
  // right-sidebar "Connect a model" quick action, which isn't route-gated —
  // see `sidebar-right.tsx`). This host has nothing to render without a
  // `projectId`, but leaving the store armed would surprise the user with a
  // connect modal the next time they navigate into any project. Clear it
  // here instead, so every future off-project caller is covered without
  // needing its own guard.
  useEffect(() => {
    if (!projectId && isOpen) close();
  }, [projectId, isOpen, close]);

  if (!projectId) return null;

  return (
    <ConnectModelModal
      projectId={projectId}
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      runtimes={state.runtimes}
      connections={state.connections}
      harnessFilter={harnessFilter ?? null}
      initialKind={(connectKind as HarnessAuthKind | undefined) ?? null}
      initialProviderId={providerId ?? null}
      tab={tab ?? null}
      onConnected={close}
    />
  );
}
