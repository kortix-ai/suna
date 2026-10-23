'use client';

import { framesKeepAlive, pruneFrames } from '@kortix/ui/apps';
import { prefetchArtifact, useArtifacts, useFeatureFlag } from '@kortix/sdk/react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { ensureArtifactFrame } from './artifact-meta';
import { ARTIFACT_FRAME_PREFIX, artifactFrameKey } from './frame-sandbox';

/** At most this many artifacts load in the background; the rest load when first shown. */
// ponytail: newest first by the list order, rank by recent opens if a project outgrows it.
const PRELOAD_LIMIT = 12;

/**
 * Loads the project's newest artifacts in the background once the page is
 * idle, like App previews (`AppPreviewPoolLoader`): each page into the frame
 * pool, and each detail (and doc text) into the query cache, so a click opens
 * without a request. Pooled frames survive every page switch inside the
 * project. Only with the `artifacts` flag on.
 */
export function ArtifactFramePreloader({ projectId }: { projectId: string }) {
  const enabled = useFeatureFlag(projectId, 'artifacts').enabled;
  const queryClient = useQueryClient();
  const list = useArtifacts(enabled ? projectId : null, { scope: 'all' });
  const [idle, setIdle] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    // Safari has no requestIdleCallback.
    const idleCallback = 'requestIdleCallback' in window;
    const handle = idleCallback
      ? window.requestIdleCallback(() => setIdle(true), { timeout: 2000 })
      : window.setTimeout(() => setIdle(true), 1500);
    return () => (idleCallback ? window.cancelIdleCallback(handle) : window.clearTimeout(handle));
  }, [enabled]);

  const artifacts = list.data;
  useEffect(() => {
    if (!artifacts) return;
    // A save or an unshared artifact drops its old frame (unless a slot shows it).
    pruneFrames(new Set(artifacts.map((a) => artifactFrameKey(a))), (key) => key.startsWith(ARTIFACT_FRAME_PREFIX));
    if (!idle) return;
    for (const artifact of artifacts.slice(0, PRELOAD_LIMIT)) {
      void prefetchArtifact(queryClient, projectId, artifact.artifact_id).catch(() => {});
      // Without moveBefore a moved frame reloads anyway: preload only the data.
      if (artifact.view_url && framesKeepAlive()) ensureArtifactFrame(artifactFrameKey(artifact), artifact.view_url, artifact.title);
    }
  }, [artifacts, idle, projectId, queryClient]);

  return null;
}
