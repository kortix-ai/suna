'use client';

import type { ArtifactCommentAnchor, ArtifactCommentThread } from '@kortix/sdk';
import type {
  ArtifactAnnotationRect,
  ArtifactAnnotationViewport,
} from '@kortix/shared/artifact-annotations';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { ArtifactAnnotationCaptureResult } from './artifact-annotation-capture';
import { connectArtifactAnnotationFrame } from './artifact-annotation-channel';
import {
  createArtifactAnnotationController,
  type ArtifactAnnotationScheduler,
  type ArtifactAnnotationStatus,
} from './artifact-annotation-controller';
export type {
  ArtifactAnnotationRect,
  ArtifactAnnotationViewport,
} from '@kortix/shared/artifact-annotations';
export type { ArtifactAnnotationCaptureResult } from './artifact-annotation-capture';

const EMPTY_THREADS: ArtifactCommentThread[] = [];
export function useArtifactAnnotations(
  options: {
    enabled: boolean;
    frame: HTMLIFrameElement | null;
    slot: RefObject<HTMLDivElement | null>;
    version: string | null | undefined;
    canComment: boolean;
    mode: 'text' | 'comment';
    threads: ArtifactCommentThread[] | undefined;
    focusedThreadId: string | null;
    focusRevision: number;
    onCandidate: (anchor: ArtifactCommentAnchor) => void;
    onFocus: (threadId: string) => void;
  },
  schedule?: ArtifactAnnotationScheduler,
) {
  const [viewport, setViewport] = useState<ArtifactAnnotationViewport | null>(null);
  const [regions, setRegions] = useState<Readonly<Record<string, ArtifactAnnotationRect>>>({});
  const scope = useRef<{ frame: HTMLIFrameElement; version: string } | null>(null);
  const [resolved, setResolved] = useState<ArtifactCommentThread[]>(EMPTY_THREADS);
  const [readiness, setReadiness] = useState<{
    frame: HTMLIFrameElement;
    version: string;
    status: ArtifactAnnotationStatus;
  } | null>(null);
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });
  const controller = useRef<ReturnType<typeof createArtifactAnnotationController> | null>(null);
  const threads = options.threads ?? EMPTY_THREADS;
  useEffect(() => {
    const slot = options.slot.current;
    if (!options.enabled || !options.frame || !slot || !options.version) return;
    const channel = connectArtifactAnnotationFrame(options.frame, slot, {
      onMessage: (message) => controller.current?.receive(message),
      onLoad: () => controller.current?.reset(),
    });
    const current = createArtifactAnnotationController(
      {
        post: channel.post,
        onCandidate: (anchor) => latest.current.onCandidate(anchor),
        onFocus: (id) => latest.current.onFocus(id),
        onThreads: setResolved,
        onViewport: setViewport,
        onRegions: setRegions,
        onStatus: (status) =>
          setReadiness({ frame: options.frame!, version: options.version!, status }),
      },
      schedule,
    );
    controller.current = current;
    scope.current = { frame: options.frame, version: options.version };
    const state = latest.current;
    current.update({
      ...state,
      version: options.version,
      threads: state.threads ?? EMPTY_THREADS,
    });
    current.reset();
    return () => {
      scope.current = null;
      controller.current = null;
      current.dispose();
      channel.dispose();
    };
  }, [options.enabled, options.frame, options.slot, options.version, schedule]);
  useEffect(() => {
    const state = latest.current;
    if (!state.version) return;
    controller.current?.update({ ...state, version: state.version, threads });
  }, [
    options.version,
    options.canComment,
    options.mode,
    threads,
    options.focusedThreadId,
    options.focusRevision,
  ]);
  const current = readiness?.frame === options.frame && readiness?.version === options.version;
  const reset = useCallback(() => {
    if (latest.current.enabled) controller.current?.reset();
  }, []);
  const ownsScope = useCallback(
    () =>
      latest.current.enabled &&
      latest.current.frame === scope.current?.frame &&
      latest.current.version === scope.current?.version,
    [],
  );
  const capture = useCallback(
    async (rect: ArtifactAnnotationRect): Promise<ArtifactAnnotationCaptureResult> => {
      if (!ownsScope() || !latest.current.canComment || !controller.current)
        return { ok: false, reason: 'unavailable' };
      const owner = controller.current;
      const result = await owner.capture(rect);
      return owner === controller.current && ownsScope() ? result : { ok: false, reason: 'stale' };
    },
    [ownsScope],
  );
  const regionForViewportRect = useCallback(
    (rect: ArtifactAnnotationRect) =>
      ownsScope() && latest.current.canComment
        ? (controller.current?.regionForViewportRect(rect) ?? null)
        : null,
    [ownsScope],
  );
  const cancelCapture = useCallback(() => controller.current?.cancelCapture(), []);
  const isCurrentViewport = useCallback(
    (value: ArtifactAnnotationViewport) =>
      ownsScope() &&
      latest.current.canComment &&
      controller.current?.isCurrentViewport(value) === true,
    [ownsScope],
  );
  return {
    isCurrentViewport,
    viewport: options.enabled && current && readiness?.status === 'ready' ? viewport : null,
    regions: options.enabled && current && readiness?.status === 'ready' ? regions : {},
    capture,
    cancelCapture,
    regionForViewportRect,
    threads: options.enabled && options.frame && current ? resolved : threads,
    status: !options.enabled
      ? ('unavailable' as const)
      : current
        ? readiness!.status
        : ('loading' as const),
    reset,
  };
}
