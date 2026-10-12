'use client';

import { sessionDisplayStatus, type SessionDisplayStatus } from '@/components/projects/session-label';
import type { AttachedFile } from '@/features/session/composer/types';
import { useAuth } from '@/features/providers/auth-provider';
import {
  getSessionDisplayTitle,
  sessionLastActivityAt,
} from '@/features/workspace/project-sidebar/project-session-list-helpers';
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
import {
  KortixProjectProvider,
  contract,
  flattenProjectSessionPages,
  qk,
  useProjectSessions,
} from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  QuickEntryComposer,
  type QuickEntryComposerSnapshot,
  type QuickEntrySelect,
} from './desktop-quick-entry-composer';

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
 * newest activity first, with the sidebar's title, status and last activity.
 * An unused warm session is left out: it is not a conversation anyone started.
 */
export function quickEntryRecentSessions(
  sessions: readonly ProjectSession[],
): { id: string; title: string; status: SessionDisplayStatus; lastActiveAt: string }[] {
  return sessions
    .filter((session) => (session.metadata as Record<string, unknown> | null)?.warm !== true)
    .slice(0, QUICK_ENTRY_RECENT_SESSIONS)
    .map((session) => ({
      id: session.session_id,
      title: getSessionDisplayTitle(session),
      status: sessionDisplayStatus(session),
      lastActiveAt: sessionLastActivityAt(session),
    }));
}

/** A file the bar sent (a screenshot, a picked file) as a composer attachment. */
export function quickEntryAttachedFile(input: { name: string; type: string; bytes: Uint8Array }): AttachedFile {
  // A copy with a plain ArrayBuffer: the IPC hands over an ArrayBufferLike view.
  const file = new File([new Uint8Array(input.bytes)], input.name, { type: input.type });
  // The composer stages it and makes its own preview URL.
  return { kind: 'local', file, localUrl: '', isImage: input.type.startsWith('image/'), attachedAt: Date.now() };
}

/**
 * Whether a new-session prompt may send itself. A model that cannot read
 * images would refuse the screenshot; then the prompt only fills the
 * composer, which shows why and lets the person pick another model.
 */
export function quickEntryCanSubmit(
  files: readonly AttachedFile[],
  composer: QuickEntryComposerSnapshot | null,
): boolean {
  if (!files.some((file) => file.isImage)) return true;
  return composer?.vision !== false;
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
 * It also tells the shell the project, its recent sessions, and a new
 * session's agent (`QuickEntryComposer`), and applies an agent the person
 * picks in the bar. Renders nothing visible, and does nothing
 * outside the desktop app.
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

  // The composer snapshot changes identity on every render; publish on content.
  const composerRef = useRef<QuickEntryComposerSnapshot | null>(null);
  const selectRef = useRef<QuickEntrySelect | null>(null);
  const [composerKey, setComposerKey] = useState('');
  const onComposer = useCallback((snapshot: QuickEntryComposerSnapshot | null) => {
    composerRef.current = snapshot;
    setComposerKey(
      snapshot
        ? JSON.stringify([snapshot.projectId, snapshot.agents, snapshot.agent])
        : '',
    );
  }, []);

  useEffect(() => {
    if (!desktop || !userId) return;
    const snapshot = composerRef.current?.projectId === projectId ? composerRef.current : null;
    const composer = snapshot ? { agents: snapshot.agents, agent: snapshot.agent } : null;
    void setDesktopQuickEntryTarget(projectId ? { projectId, name, sessions: recent, composer } : null);
    if (projectId) router.prefetch(`/projects/${projectId}`);
  }, [desktop, userId, projectId, name, recent, composerKey, router]);

  // An agent picked in the bar, applied by the composer's own setter.
  useEffect(() => {
    if (!desktop) return;
    const onSelect = (event: Event) => {
      try {
        const { kind, value } = JSON.parse(String((event as CustomEvent<string>).detail)) as {
          kind: string;
          value: string | null;
        };
        selectRef.current?.(kind, typeof value === 'string' ? value : null);
      } catch {
        /* not ours */
      }
    };
    window.addEventListener('kortix-desktop-quick-entry-select', onSelect);
    return () => window.removeEventListener('kortix-desktop-quick-entry-select', onSelect);
  }, [desktop]);

  useEffect(() => {
    // Signed out: the prompt waits in the shell, up to 10 minutes, for sign-in.
    if (!desktop || !userId) return;
    const take = async () => {
      const prompt = await takeDesktopQuickEntryPrompt();
      if (!prompt) return;
      const files = (prompt.files ?? []).map(quickEntryAttachedFile);
      if (prompt.sessionId && prompt.projectId) {
        // A session picked in the bar: its composer sends the prompt, replacing
        // an unsent draft there rather than merging into it. It keeps its own
        // agent and model; its composer refuses images its model cannot read.
        useSessionComposerPrefillStore
          .getState()
          .setPrefill(prompt.sessionId, prompt.text, files.length ? files : undefined, 'replace', { submit: true });
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
      // Project home consumes this and submits it (project-home.tsx) with the
      // agent, model and effort the bar showed. The prompt replaces an unsent
      // draft in that composer.
      const composer = composerRef.current?.projectId === target ? composerRef.current : null;
      useComposerPrefillStore.getState().setPrefill(target, prompt.text, {
        submit: quickEntryCanSubmit(files, composer),
        ...(files.length ? { files } : {}),
        ...(composer ? { options: composer.overrides } : {}),
      });
      // nav-contract: prefetch-only — the effect above prefetches this route
      router.push(`/projects/${target}`);
    };
    // A prompt sent while this window was loading or signed out was never poked.
    void take();
    window.addEventListener('kortix-desktop-quick-entry', take);
    return () => window.removeEventListener('kortix-desktop-quick-entry', take);
  }, [desktop, userId, router]);

  return desktop && userId && projectId ? (
    <KortixProjectProvider projectId={projectId}>
      <QuickEntryComposer
        projectId={projectId}
        onChange={onComposer}
        selectRef={selectRef}
      />
    </KortixProjectProvider>
  ) : null;
}
