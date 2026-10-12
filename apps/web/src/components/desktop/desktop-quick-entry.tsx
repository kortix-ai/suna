'use client';

import { useAuth } from '@/features/providers/auth-provider';
import {
  isDesktop,
  setDesktopQuickEntryTarget,
  takeDesktopQuickEntryPrompt,
} from '@/lib/desktop';
import { readLastProjectId } from '@/lib/onboarding/last-project-cookie';
import { useComposerPrefillStore } from '@/stores/composer-prefill-store';
import { projectIdFromPathname } from '@/stores/project-switch-store';
import { getProjectDetail } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';

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
 * Desktop Quick Entry, the web half. The shell's global shortcut opens a
 * prompt bar over any app (`apps/desktop-electron/src/quick-entry.js`). Enter
 * brings this window forward and pokes it. This takes the prompt and submits
 * it from the project-home composer, so the session starts exactly as from a
 * typed message: same agent, model, billing gate and warm session.
 *
 * It also tells the shell which project that is, for the bar's label.
 * Renders nothing, and does nothing outside the desktop app.
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

  useEffect(() => {
    if (!desktop || !userId) return;
    void setDesktopQuickEntryTarget(projectId ? { projectId, name } : null);
    if (projectId) router.prefetch(`/projects/${projectId}`);
  }, [desktop, userId, projectId, name, router]);

  useEffect(() => {
    // Signed out: the prompt waits in the shell, up to 10 minutes, for sign-in.
    if (!desktop || !userId) return;
    const take = async () => {
      const prompt = await takeDesktopQuickEntryPrompt();
      if (!prompt) return;
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
