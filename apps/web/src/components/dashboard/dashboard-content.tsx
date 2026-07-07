'use client';

import { useTranslations } from 'next-intl';

import { NoInstanceState } from '@/components/dashboard/no-instance-state';
import { useSidebar } from '@/components/ui/sidebar';
import { WallpaperBackground } from '@/components/ui/wallpaper-background';
import {
  ComposerChatInput,
  type ComposerOptions,
} from '@/features/session/composer-chat-input';
import type { AttachedFile } from '@/features/session/session-chat-input';
import { formatModelString } from '@/hooks/opencode/use-opencode-local';
import type { Command } from '@/hooks/opencode/use-opencode-sessions';
import { useCreateOpenCodeSession } from '@/hooks/opencode/use-opencode-sessions';
import { useIsMobile } from '@/hooks/utils';
import { getClient } from '@/lib/opencode-sdk';
import { playSound } from '@/lib/sounds';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { usePendingFilesStore } from '@/stores/pending-files-store';
import { openTabAndNavigate } from '@/stores/tab-store';
import { writeStartStash } from '@kortix/sdk/react';
import { useQueryClient } from '@tanstack/react-query';
import { Menu } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

// ============================================================================
// Dashboard Content
// ============================================================================

// Wallpaper fade-out duration on send. Short enough to feel snappy, long
// enough for the motion to be perceived rather than read as a cut.
const SEND_FADE_MS = 150;

export function DashboardContent() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [isSending, setIsSending] = useState(false);

  const isMobile = useIsMobile();
  const { setOpen: setSidebarOpenState, setOpenMobile } = useSidebar();
  const createSession = useCreateOpenCodeSession();

  // Legacy "no sandbox/instance" hero retired — cloud sessions always have a
  // runtime, and the instances system is gone.
  const showNoInstanceState = false;

  // After Stripe checkout (?subscription=success), the webhook has already
  // provisioned the sandbox — refresh sandbox queries so the workspace
  // switcher and dashboard reflect it, then strip the param so the URL
  // stays clean and history-back doesn't re-trigger.
  const queryClient = useQueryClient();
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('subscription') !== 'success') return;
    queryClient.invalidateQueries({ queryKey: ['platform', 'sandbox'] });
    const clean = new URL(window.location.href);
    clean.searchParams.delete('subscription');
    clean.searchParams.delete('session_id');
    window.history.replaceState({}, '', `${clean.pathname}${clean.search}`);
  }, [queryClient]);

  const handleSend = useCallback(
    async (text: string, files: AttachedFile[] | undefined, options: ComposerOptions) => {
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
        // so sessionStorage must be populated first. `session.id` here IS the
        // canonical OpenCode session id (this hook creates the real runtime
        // session directly, unlike the project-scoped flow), so the SDK's
        // start-stash (`readStartStash`/`writeStartStash`) reads it back under
        // the exact same id — no route/pin translation involved.
        writeStartStash(session.id, {
          prompt: text,
          model: options.model ?? null,
          agent: options.agent ?? null,
          variant: options.variant ?? null,
        });

        if (files?.length) {
          usePendingFilesStore.getState().setPendingFiles(files);
        }

        openTabAndNavigate({
          id: session.id,
          title: 'New session',
          type: 'session',
          href: `/sessions/${session.id}`,
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
    [isSending, createSession],
  );

  const handleCommand = useCallback(
    async (cmd: Command, args: string | undefined, options: ComposerOptions) => {
      try {
        const session = await createSession.mutateAsync();
        openTabAndNavigate({
          id: session.id,
          title: cmd.name,
          type: 'session',
          href: `/sessions/${session.id}`,
        });
        const client = getClient();
        void client.session
          .command({
            sessionID: session.id,
            command: cmd.name,
            arguments: args || '',
            ...(options.agent && { agent: options.agent }),
            ...(options.model && { model: formatModelString(options.model) }),
            ...(options.variant && { variant: options.variant }),
          } as any)
          .catch(() => {
            toast.warning('Failed to execute command');
          });
      } catch {
        toast.warning('Failed to create session');
      }
    },
    [createSession],
  );

  if (showNoInstanceState) {
    return (
      <div className="bg-background relative flex h-full flex-col">
        {isMobile && (
          <div className="absolute top-1.5 left-3 z-10">
            <button
              onClick={() => {
                setSidebarOpenState(true);
                setOpenMobile(true);
              }}
              className="text-muted-foreground hover:text-foreground hover:bg-accent/50 active:bg-accent -ml-1.5 flex h-9 w-9 touch-manipulation items-center justify-center rounded-lg transition-colors"
              aria-label={tHardcodedUi.raw(
                'componentsDashboardDashboardContent.line177JsxAttrAriaLabelOpenMenu',
              )}
            >
              <Menu className="h-5 w-5" />
            </button>
          </div>
        )}
        <NoInstanceState />
      </div>
    );
  }

  return (
    <div className="bg-background relative flex h-full flex-col">
      {/* Mobile menu button */}
      {isMobile && (
        <div className="absolute top-1.5 left-3 z-10">
          <button
            onClick={() => {
              setSidebarOpenState(true);
              setOpenMobile(true);
            }}
            className="text-muted-foreground hover:text-foreground hover:bg-accent/50 active:bg-accent -ml-1.5 flex h-9 w-9 touch-manipulation items-center justify-center rounded-lg transition-colors"
            aria-label={tHardcodedUi.raw(
              'componentsDashboardDashboardContent.line199JsxAttrAriaLabelOpenMenu',
            )}
          >
            <Menu className="h-5 w-5" />
          </button>
        </div>
      )}

      {/* Full-bleed wallpaper — spans the entire dashboard so the chat input
          overlays the same backdrop instead of sitting on
          a separate opaque block. Emphasized-exit curve yanks it on send. */}
      <div
        className={cn(
          'pointer-events-none absolute inset-0 z-0 transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.3,0,0.8,0.15)]',
          isSending ? '-translate-y-1 opacity-0' : 'translate-y-0 opacity-100',
        )}
      >
        <div className="relative h-full w-full overflow-hidden">
          <WallpaperBackground />
        </div>
      </div>

      {/* Spacer — keeps the input anchored to the bottom while the wallpaper
          is absolute-positioned behind. */}
      <div className="relative z-10 min-h-0 flex-1" />

      {/* Chat Input — pinned to bottom, overlays the wallpaper */}
      <ComposerChatInput
        onSend={handleSend}
        onCommand={handleCommand}
        disabled={isSending}
        placeholder={tHardcodedUi.raw('componentsDashboardDashboardContent.line228JsxAttrPlaceholderAskAnything')}
      />
    </div>
  );
}
