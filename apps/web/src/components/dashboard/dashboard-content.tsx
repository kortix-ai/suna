'use client';

import React, { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useIsMobile } from '@/hooks/utils';
import { toast } from '@/lib/toast';
import { useSidebar } from '@/components/ui/sidebar';
import {
  useCreateOpenCodeSession,
  useSendOpenCodeMessage,
  useOpenCodeAgents,
  useOpenCodeProviders,
  useOpenCodeCommands,
} from '@/hooks/opencode/use-opencode-sessions';
import { getClient } from '@/lib/opencode-sdk';
import { openTabAndNavigate } from '@/stores/tab-store';
import { useServerStore } from '@/stores/server-store';
import { type AttachedFile, SessionChatInput } from '@/components/session/session-chat-input';
import { usePendingFilesStore } from '@/stores/pending-files-store';
import { WallpaperBackground } from '@/components/ui/wallpaper-background';
import { useOpenCodeLocal, formatModelString } from '@/hooks/opencode/use-opencode-local';
import { useOpenCodeConfig } from '@/hooks/opencode/use-opencode-config';
import { ProjectSelector } from '@/components/dashboard/project-selector';
import { useSelectedProjectStore } from '@/stores/selected-project-store';
import { useKortixProjects } from '@/hooks/kortix/use-kortix-projects';
import { appendProjectRef } from '@/lib/project-preamble';
import { Menu } from 'lucide-react';
import type { Command } from '@/hooks/opencode/use-opencode-sessions';
import { playSound } from '@/lib/sounds';
import { cn } from '@/lib/utils';

// ============================================================================
// Dashboard Content
// ============================================================================

// Wallpaper fade-out duration on send. Short enough to feel snappy, long
// enough for the motion to be perceived rather than read as a cut.
const SEND_FADE_MS = 150;

export function DashboardContent() {
  const [isSending, setIsSending] = useState(false);

  const router = useRouter();
  const isMobile = useIsMobile();
  const { setOpen: setSidebarOpenState, setOpenMobile } = useSidebar();
  const createSession = useCreateOpenCodeSession();
  const sendMessage = useSendOpenCodeMessage();

  // Data
  const { data: agents } = useOpenCodeAgents();
  const { data: providers } = useOpenCodeProviders();
  const { data: commands } = useOpenCodeCommands();
  const { data: config } = useOpenCodeConfig();

  // Unified model/agent/variant state
  const local = useOpenCodeLocal({ agents, providers, config });

  // Project selection — persisted across reloads
  const selectedProjectId = useSelectedProjectStore((s) => s.projectId);
  const setSelectedProjectId = useSelectedProjectStore((s) => s.setProjectId);
  const { data: kortixProjects } = useKortixProjects();
  const selectedProject = React.useMemo(
    () => kortixProjects?.find((p) => p.id === selectedProjectId) ?? null,
    [kortixProjects, selectedProjectId],
  );
  // If the persisted project id no longer exists, clear it transparently
  React.useEffect(() => {
    if (selectedProjectId && kortixProjects && !selectedProject) {
      setSelectedProjectId(null);
    }
  }, [selectedProjectId, kortixProjects, selectedProject, setSelectedProjectId]);

  const handleSend = useCallback(
    async (text: string, files?: AttachedFile[]) => {
      if ((!text.trim() && !files?.length) || isSending) return;

      playSound('send');
      setIsSending(true);

      try {
        // Session create + fade-out run in parallel. Handoff waits for
        // whichever finishes last — no longer.
        const [session] = await Promise.all([
          createSession.mutateAsync(),
          new Promise<void>((r) => setTimeout(r, SEND_FADE_MS)),
        ]);

        // Stash everything the session page needs BEFORE navigating — its
        // pending-prompt effect runs on the first render after pushState,
        // so sessionStorage must be populated first.
        const finalText = appendProjectRef(text, selectedProject);
        sessionStorage.setItem(`opencode_pending_prompt:${session.id}`, finalText);

        if (files?.length) {
          usePendingFilesStore.getState().setPendingFiles(files);
        }

        const options: Record<string, unknown> = {};
        if (local.agent.current) options.agent = local.agent.current.name;
        if (local.model.currentKey) options.model = local.model.currentKey;
        if (local.model.variant.current) options.variant = local.model.variant.current;
        if (Object.keys(options).length > 0) {
          sessionStorage.setItem(
            `opencode_pending_options:${session.id}`,
            JSON.stringify(options),
          );
        }

        openTabAndNavigate({
          id: session.id,
          title: 'New session',
          type: 'session',
          href: `/sessions/${session.id}`,
          serverId: useServerStore.getState().activeServerId,
        });

        requestAnimationFrame(() => {
          window.dispatchEvent(new CustomEvent('focus-session-textarea'));
        });
      } catch {
        usePendingFilesStore.getState().setPendingFiles([]);
        toast.warning('Failed to create session');
      } finally {
        // On success the dashboard is already hidden (pushState + setActiveTab),
        // so the fade-in transition runs off-screen — no visible flicker.
        // On failure we stay on the dashboard, so this brings the wallpaper back.
        setIsSending(false);
      }
    },
    [isSending, createSession, local.agent.current, local.model.currentKey, local.model.variant.current, selectedProject],
  );

  const handleCommand = useCallback(
    async (cmd: Command, args?: string) => {
      try {
        const session = await createSession.mutateAsync();
        openTabAndNavigate({
          id: session.id,
          title: cmd.name,
          type: 'session',
          href: `/sessions/${session.id}`,
          serverId: useServerStore.getState().activeServerId,
        });
        const client = getClient();
        void client.session.command({
          sessionID: session.id,
          command: cmd.name,
          arguments: args || '',
          ...(local.agent.current && { agent: local.agent.current.name }),
          ...(local.model.currentKey && { model: formatModelString(local.model.currentKey) }),
          ...(local.model.variant.current && { variant: local.model.variant.current }),
        } as any).catch(() => {
          toast.warning('Failed to execute command');
        });
      } catch {
        toast.warning('Failed to create session');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [createSession, local.agent.current, local.model.currentKey, local.model.variant.current],
  );

  return (
    <div className="relative flex flex-col h-full bg-background">
      {/* Mobile menu button */}
      {isMobile && (
        <div className="absolute left-3 top-1.5 z-10">
          <button
            onClick={() => {
              setSidebarOpenState(true);
              setOpenMobile(true);
            }}
            className="flex items-center justify-center h-9 w-9 -ml-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/50 active:bg-accent transition-colors touch-manipulation"
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" />
          </button>
        </div>
      )}

      {/* Full-bleed wallpaper — spans the entire dashboard so the chat input
          and project selector overlay the same backdrop instead of sitting on
          a separate opaque block. Emphasized-exit curve yanks it on send. */}
      <div
        className={cn(
          "absolute inset-0 z-0 pointer-events-none transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.3,0,0.8,0.15)]",
          isSending ? "opacity-0 -translate-y-1" : "opacity-100 translate-y-0",
        )}
      >
        <div className="relative w-full h-full overflow-hidden">
          <WallpaperBackground />
        </div>
      </div>

      {/* Spacer — keeps the input anchored to the bottom while the wallpaper
          is absolute-positioned behind. */}
      <div className="relative flex-1 min-h-0 z-10" />

      {/* Project selector — sits above the chat input, pill style */}
      <div className="relative z-10">
        <ProjectSelector
          selectedProjectId={selectedProjectId}
          onSelect={setSelectedProjectId}
        />
      </div>

      {/* Chat Input — pinned to bottom, overlays the wallpaper */}
      <SessionChatInput
        onSend={handleSend}
        disabled={isSending}
        placeholder="Ask anything..."
        agents={local.agent.list}
        selectedAgent={local.agent.current?.name ?? null}
        onAgentChange={(name) => local.agent.set(name ?? undefined)}
        models={local.model.list}
        selectedModel={local.model.currentKey ?? null}
        onModelChange={(m) => local.model.set(m ?? undefined, { recent: true })}
        variants={local.model.variant.list}
        selectedVariant={local.model.variant.current ?? null}
        onVariantChange={(v) => local.model.variant.set(v ?? undefined)}
        commands={commands || []}
        onCommand={handleCommand}
      />
    </div>
  );
}
