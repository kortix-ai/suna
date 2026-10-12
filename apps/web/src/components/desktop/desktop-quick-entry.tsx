'use client';

import { sessionDisplayStatus, type SessionDisplayStatus } from '@/components/projects/session-label';
import { useAuth } from '@/features/providers/auth-provider';
import { getSessionDisplayTitle } from '@/features/workspace/project-sidebar/project-session-list-helpers';
import {
  isDesktop,
  setDesktopQuickEntryTarget,
  takeDesktopQuickEntryPrompt,
} from '@/lib/desktop';
import { readLastProjectId } from '@/lib/onboarding/last-project-cookie';
import { useComposerPrefillStore } from '@/stores/composer-prefill-store';
import { projectIdFromPathname } from '@/stores/project-switch-store';
import { useSessionComposerPrefillStore } from '@/stores/session-composer-prefill-store';
import { getProjectDetail, type ProjectSession } from '@kortix/sdk';
import { contract, flattenProjectSessionPages, qk, useProjectSessions } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo } from 'react';

/** How many sessions the Quick Entry picker lists. */
export const QUICK_ENTRY_RECENT_SESSIONS = 5;

/**
 * The project a Quick Entry prompt starts its session in: the one the window
 * shows, else the one this profile opened last. Null: no project is known.
 */
export function quickEntryProjectId(
  pathname: string | null,
  rememberedProjectId: string | null,
): string | null {
  return projectIdFromPathname(pathname) ?? rememberedProjectId;
}

/**
 * The sessions the picker offers: the person's most recent in the project,
 * newest activity first, with the sidebar's title and status. An unused warm
 * session is left out: it is not a conversation anyone started.
 */
export function quickEntryRecentSessions(
  sessions: readonly ProjectSession[],
): { id: string; title: string; status: SessionDisplayStatus }[] {
  return sessions
    .filter((session) => (session.metadata as Record<string, unknown> | null)?.warm !== true)
    .slice(0, QUICK_ENTRY_RECENT_SESSIONS)
    .map((session) => ({
      id: session.session_id,
      title: getSessionDisplayTitle(session),
      status: sessionDisplayStatus(session),
    }));
}

/**
 * Desktop Quick Entry, the web half. The shell's global shortcut opens a
 * prompt bar over any app (`apps/desktop-electron/src/quick-entry.js`). Enter
 * brings this window forward and pokes it. This takes the prompt and submits
 * it through a composer, so it sends exactly as a typed message does: same
 * agent, model and billing gate. A new session goes through project home; a
 * session picked in the bar gets the prompt in its own composer (Enter
 * semantics: a running turn is steered).
 *
 * It also tells the shell the project and its recent sessions, for the bar's
 * picker. Renders nothing, and does nothing outside the desktop app.
 */
export function DesktopQuickEntry() {
  const router = useRouter();
  const pathname = usePathname();
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const desktop = isDesktop();
  const projectId = desktop && userId ? quickEntryProjectId(pathname, readLastProjectId(userId)) : null;

  // The project page already holds this query, so on a project it costs nothing.
  const { data: detail } = useQuery({
    queryKey: qk.project.detail(projectId ?? ''),
    queryFn: () => getProjectDetail(projectId as string),
    enabled: projectId !== null,
    ...contract('config'),
  });
  const name = detail?.project?.name ?? null;
  // The sidebar's own list (same options, same cache entry): the person's root
  // sessions, newest activity first. Its refetches keep the picker's statuses current.
  const { data: sessionPages } = useProjectSessions(projectId ?? '', {
    parent: 'root',
    startedBy: 'me',
    enabled: projectId !== null,
  });
  // Keyed on the query data, which keeps its identity until the list changes:
  // the hook's flat `sessions` is a new array on every render.
  const recent = useMemo(
    () => quickEntryRecentSessions(flattenProjectSessionPages(sessionPages)),
    [sessionPages],
  );

  useEffect(() => {
    if (!desktop || !userId) return;
    void setDesktopQuickEntryTarget(projectId ? { projectId, name, sessions: recent } : null);
    if (projectId) router.prefetch(`/projects/${projectId}`);
  }, [desktop, userId, projectId, name, recent, router]);

  useEffect(() => {
    // Signed out: the prompt waits in the shell, up to 10 minutes, for sign-in.
    if (!desktop || !userId) return;
    const take = async () => {
      const prompt = await takeDesktopQuickEntryPrompt();
      if (!prompt) return;
      if (prompt.sessionId && prompt.projectId) {
        // A session picked in the bar: its composer sends the prompt, replacing
        // an unsent draft there rather than merging into it.
        useSessionComposerPrefillStore
          .getState()
          .setPrefill(prompt.sessionId, prompt.text, undefined, 'replace', { submit: true });
        // nav-contract: prefetch-only — the session was picked in the native bar
        router.push(
          `/projects/${encodeURIComponent(prompt.projectId)}/sessions/${encodeURIComponent(prompt.sessionId)}`,
        );
        return;
      }
      const target = quickEntryProjectId(window.location.pathname, readLastProjectId(userId));
      if (!target) {
        // No project known: the door opens one, and the prompt only fills its
        // composer. `?q=` never sends, so the person presses Enter there.
        // nav-contract: prefetch-only — the destination exists only once a prompt arrives
        router.push(`/projects/start?q=${encodeURIComponent(prompt.text)}`);
        return;
      }
      // Project home consumes this and submits it (project-home.tsx). The
      // prompt replaces an unsent draft in that composer.
      useComposerPrefillStore.getState().setPrefill(target, prompt.text, { submit: true });
      // nav-contract: prefetch-only — the effect above prefetches this route
      router.push(`/projects/${target}`);
    };
    // A prompt sent while this window was loading or signed out was never poked.
    void take();
    window.addEventListener('kortix-desktop-quick-entry', take);
    return () => window.removeEventListener('kortix-desktop-quick-entry', take);
  }, [desktop, userId, router]);

  return null;
}
