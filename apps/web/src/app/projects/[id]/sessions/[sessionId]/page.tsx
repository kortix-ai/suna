'use client';

import { useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useAuth } from '@/components/AuthProvider';
import { SessionChat } from '@/components/session/session-chat';
import { SessionLayout } from '@/components/session/session-layout';
import { SessionLoadingSkeleton } from '@/components/session/session-loading-skeleton';
import { ProjectShell } from '@/components/projects/project-shell';
import { OpenCodeEventStreamProvider } from '@/hooks/opencode/use-opencode-events';
import { getProjectSessionSandbox, syncOpencodeSessionTitles } from '@/lib/projects-client';
import { setActiveInstanceCookie } from '@/lib/instance-routes';
import {
  markProvisioningVerified,
  useSandboxConnectionStore,
} from '@/stores/sandbox-connection-store';
import { useSandboxConnection } from '@/hooks/platform/use-sandbox-connection';
import { switchToSessionSandboxAsync, useServerStore } from '@/stores/server-store';
import {
  useCreateOpenCodeSession,
  useOpenCodeSessions,
} from '@/hooks/opencode/use-opencode-sessions';

/**
 * /projects/[id]/sessions/[sessionId] — project-scoped session view.
 *
 * Shows the repo-first chat experience pointed at this session's sandbox.
 *
 * Lifecycle gate (auth/load → provisioning → error/stopped → active) keeps
 * the placeholder branches we already had. The active branch:
 *   1. Calls `switchToInstanceAsync(sandbox_id)` to set this session's
 *      sandbox as the global active server.
 *   2. WAITS for the active server's `instanceId` to actually equal
 *      `sandbox_id` before mounting chat. This is
 *      load-bearing — every sandbox-coupled hook inside the shell
 *      (`useOpenCodeSessions`, `getClient()`, file/terminal APIs, etc.)
 *      reads `useServerStore.getActiveServerUrl()` at render time. If we
 *      mount before the switch resolves, they connect to the previous
 *      sandbox.
 *
 * The URL stays at `/projects/<id>/sessions/<sessionId>` the whole time.
 */
export default function ProjectSessionPage() {
  const { id: projectId, sessionId } = useParams<{ id: string; sessionId: string }>();
  const { user, isLoading: authLoading } = useAuth();
  const queryClient = useQueryClient();
  // Drives the sandbox-connection-store so `useOpenCodeRuntimeReady()` inside
  // ActiveSessionChat can transition to `connected + healthy`. Without this
  // the chat-creator never fires and we sit forever on "Reaching workspace".
  // (Legacy dashboard mounted this from layout-content.tsx; we mount it here.)
  useSandboxConnection();

  // session_id == sandbox_id by construction (see session-sandbox.ts).
  const { data: sandbox, isLoading } = useQuery({
    queryKey: ['project', 'session-sandbox', projectId, sessionId],
    queryFn: () => getProjectSessionSandbox(projectId!, sessionId!),
    enabled: !!user && !!sessionId && !!projectId,
    staleTime: 0,
    // Poll while the row is missing (returns null) OR while still provisioning.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 3_000;
      return data.status === 'provisioning' ? 3_000 : false;
    },
  });

  // When the sandbox is active, register it as the active server so any
  // sandbox-coupled UI inside the dashboard reads ITS OpenCode URL.
  // CRITICAL: clear the legacy `kortix-active-instance` cookie afterwards
  // (and on every render). With it set, middleware can hijack client-side
  // navigation away from the project/session URL. We never want that.
  const switchedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sandbox || !projectId) return;
    if (sandbox.status !== 'active') return;
    if (switchedRef.current === sandbox.sandbox_id) return;
    switchedRef.current = sandbox.sandbox_id;
    (async () => {
      markProvisioningVerified();
      // Drop OpenCode caches BEFORE switching the active server so stale
      // sessions/messages/agents from the previous sandbox can't bleed into
      // the new one's UI. The `['opencode', ...]` namespace covers
      // `sessions`, `session(id)`, `messages`, `agents`, etc.
      queryClient.removeQueries({ queryKey: ['opencode'] });
      // Also nuke the global localStorage caches the OpenCode hooks read as
      // placeholderData (kortix_cache_sessions etc.) — they're not server-
      // scoped today and would otherwise flash the prior sandbox's data.
      if (typeof window !== 'undefined') {
        try {
          for (const key of Object.keys(window.localStorage)) {
            if (key.startsWith('kortix_cache_')) window.localStorage.removeItem(key);
          }
        } catch {}
      }
      await switchToSessionSandboxAsync(projectId, sandbox.sandbox_id);
      // Hard-clear the cookie so no subsequent navigation can be hijacked.
      setActiveInstanceCookie(null);
    })();
  }, [sandbox, projectId]);

  // Belt-and-suspenders: every render on this route force-clears the cookie.
  useEffect(() => {
    setActiveInstanceCookie(null);
  });

  // Subscribe to the store so we can render-gate the dashboard mount until
  // the active server has actually flipped to THIS sandbox (see the docblock
  // at the top — every downstream hook reads from this store).
  const activeInstanceId = useServerStore((s) => {
    const active = s.servers.find((entry) => entry.id === s.activeServerId);
    return active?.instanceId;
  });

  // From the first paint we mount ProjectShell so the project's sidebar is
  // always visible — no full-page "Preparing workspace" flash. The inner
  // content swaps between an inline loader, an error card, and the chat.
  const sandboxLabel = sandbox ? `session ${sandbox.sandbox_id.slice(0, 8)}` : undefined;
  const inner = (() => {
    if (authLoading || !user || isLoading || !sandbox) {
      return <SessionLoadingSkeleton />;
    }

    if (sandbox.status === 'provisioning') {
      return <SessionLoadingSkeleton />;
    }

    if (sandbox.status === 'error') {
      const meta = (sandbox.metadata as Record<string, unknown>) ?? {};
      return (
        <InlineSessionError
          title={`Couldn't start ${sandboxLabel ?? 'session'}`}
          message={
            (meta.provisioningError as string) ||
            (meta.errorMessage as string) ||
            'Something went wrong while provisioning this session.'
          }
        />
      );
    }

    if (sandbox.status === 'stopped') {
      return (
        <InlineSessionError
          title={`${sandboxLabel ?? 'session'} is stopped`}
          message="The sandbox for this session was stopped. Open a new session to continue."
        />
      );
    }

    // Active — wait until the server-store has actually flipped to this
    // sandbox before mounting the chat (downstream hooks read from the store).
    if (activeInstanceId !== sandbox.sandbox_id) {
      return <SessionLoadingSkeleton />;
    }

    return (
      <>
        <OpenCodeEventStreamProvider />
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <ActiveSessionChat />
        </div>
      </>
    );
  })();

  return <ProjectShell projectId={projectId}>{inner}</ProjectShell>;
}

/* ─── Inline error card (used inside the project shell) ────────────────── */

function InlineSessionError({ title, message }: { title: string; message: string }) {
  return (
    <div className="flex-1 min-h-0 flex items-center justify-center px-6">
      <div className="max-w-md text-center flex flex-col items-center gap-3">
        <h2 className="text-[14px] font-medium text-foreground/90">{title}</h2>
        <p className="text-[12px] leading-relaxed text-muted-foreground/70">{message}</p>
      </div>
    </div>
  );
}

/**
 * Renders SessionLayout + SessionChat against this project session's sandbox.
 * If no OpenCode chat session exists in the sandbox yet, auto-create one on
 * first runtime-ready render so the user lands inside the conversation UI
 * immediately.
 */
function ActiveSessionChat() {
  const runtimeReady = useSandboxConnectionStore(
    (s) => s.status === 'connected' && s.healthy === true,
  );
  const sessionsQuery = useOpenCodeSessions();
  const createMutation = useCreateOpenCodeSession();
  const createdRef = useRef(false);

  // Once OpenCode is reachable and we've confirmed there are zero sessions,
  // kick off a single create — guarded so React-strict-mode + refocus
  // re-renders never race two creates.
  useEffect(() => {
    if (!runtimeReady) return;
    if (sessionsQuery.isLoading) return;
    if (createdRef.current) return;
    const sessions = sessionsQuery.data ?? [];
    if (sessions.length > 0) return;
    createdRef.current = true;
    createMutation.mutate();
  }, [runtimeReady, sessionsQuery.isLoading, sessionsQuery.data, createMutation]);

  const chatSessionId =
    (sessionsQuery.data ?? [])[0]?.id ?? createMutation.data?.id ?? null;

  // Mirror the viewed session's title into our cloud DB so the name shows
  // even when the sandbox isn't running. Fires on mount and whenever opencode
  // changes the title (e.g. auto-titling after the first prompt). Cache-hit
  // paths in useOpenCodeSession won't trigger the queryFn, so this effect is
  // the authoritative trigger for per-session title sync.
  const activeSession = (sessionsQuery.data ?? []).find((s) => s.id === chatSessionId);
  const activeTitle = activeSession?.title || null;
  useEffect(() => {
    if (!chatSessionId) return;
    void syncOpencodeSessionTitles([
      { opencode_session_id: chatSessionId, title: activeTitle },
    ]).catch(() => {});
  }, [chatSessionId, activeTitle]);

  if (!chatSessionId) {
    return <SessionLoadingSkeleton />;
  }

  return (
    <SessionLayout sessionId={chatSessionId}>
      <SessionChat sessionId={chatSessionId} />
    </SessionLayout>
  );
}
