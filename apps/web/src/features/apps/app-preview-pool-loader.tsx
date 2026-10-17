'use client';

import { useTranslations } from '@/i18n/use-translations';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { CLIPBOARD_IFRAME_ALLOW } from '@/lib/security/iframe-sandbox';
import { framePolicy } from '@/features/file-viewer/preview-policy';
import type { App } from '@kortix/sdk';
import { useAppAccess, useProjectApps } from '@kortix/sdk/react';
import { useEffect, useState } from 'react';

import { ensureFrame, frameKey, framesKeepAlive, pruneFrames } from './app-preview-pool';
import { appCan, cardPreviewApp, gridApps } from './app-shared';

/** At most this many Apps load in the background; the rest load when first shown. */
// ponytail: a fixed cap, rank by recent use if a project outgrows it.
const PRELOAD_LIMIT = 12;

/** The project whose frames the pool holds. */
let poolProject: string | null = null;

/**
 * The previews the Apps page opens on: every card's thumbnail, and the first
 * tab of an App that shows no thumbnail of its own (a backend's dashboard).
 */
export function preloadApps(apps: App[], canAdmin: boolean): App[] {
  const opens = (app: App) =>
    appCan(app, 'preview') && !!app.active_deployment_id && app.viewer_can_access !== false;
  const picked: App[] = [];
  for (const app of gridApps(apps, canAdmin)) {
    const shown = cardPreviewApp(apps, app, canAdmin);
    if (shown && opens(shown)) picked.push(shown);
  }
  return picked.slice(0, PRELOAD_LIMIT);
}

/**
 * Loads the project's App previews in the background once the page is idle,
 * so the Apps page and the big view show them already loaded. Mounted in the
 * project shell: the frames survive every page switch inside the project.
 */
export function AppPreviewPoolLoader({ projectId }: { projectId: string }) {
  const apps = useProjectApps(projectId);
  const canAdmin = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_APP_ADMIN).allowed === true;
  const [idle, setIdle] = useState(false);

  useEffect(() => {
    if (!framesKeepAlive()) return;
    // Safari has no requestIdleCallback.
    const idleCallback = 'requestIdleCallback' in window;
    const handle = idleCallback
      ? window.requestIdleCallback(() => setIdle(true), { timeout: 2000 })
      : window.setTimeout(() => setIdle(true), 1500);
    return () => (idleCallback ? window.cancelIdleCallback(handle) : window.clearTimeout(handle));
  }, []);

  // A new release or a deleted App drops its old frame; leaving the project drops all.
  useEffect(() => {
    if (apps.data) pruneFrames(new Set(apps.data.map(frameKey)));
  }, [apps.data]);
  // Only another project drops them all: the shell can remount this loader
  // while it settles, and that must not throw away a loaded App.
  useEffect(() => {
    if (poolProject !== null && poolProject !== projectId) pruneFrames(new Set());
    poolProject = projectId;
  }, [projectId]);

  if (!idle || !apps.data) return null;
  return (
    <>
      {preloadApps(apps.data, canAdmin).map((app) => (
        <PreloadFrame key={frameKey(app)} projectId={projectId} app={app} />
      ))}
    </>
  );
}

function PreloadFrame({ projectId, app }: { projectId: string; app: App }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const access = useAppAccess(projectId, app.app_id, { policy: false, session: true });
  const url = access.session.data?.url;
  const title = tI18nComplete('text04132f84d7c3', { value0: app.name });
  useEffect(() => {
    if (url) ensureFrame(frameKey(app), url, { title, sandbox: framePolicy('app', url).sandbox, allow: CLIPBOARD_IFRAME_ALLOW });
  }, [app, url, title]);
  return null;
}
