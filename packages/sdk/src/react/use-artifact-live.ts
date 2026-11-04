'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  createArtifactLiveConnection,
  type ArtifactLiveConnection,
  type ArtifactLiveConnectionStatus,
  type ArtifactLiveWebSocket,
} from '../core/artifact-live/connection';
import type {
  ArtifactLiveChange,
  ArtifactLiveParticipant,
  ArtifactLivePosition,
  ArtifactLiveRange,
  ArtifactLiveTyping,
  ArtifactLiveView,
} from '../core/artifact-live/protocol';
import { qk } from './query-keys';
import { artifactCommentWriteKey } from './use-artifacts';

export interface UseArtifactLiveOptions {
  /** Default true. False never opens a connection and closes an open one. Pass it only while `artifact_comments` is on. */
  enabled?: boolean;
  view: ArtifactLiveView;
  /** The version the viewer shows (`entry_version`). Read at each connect; a change does not reconnect. */
  version?: string | null;
  /** The tab is in the background. A change sends `hide`; it never reconnects. */
  hidden?: boolean;
  /** The WebSocket constructor, for a host without a global one. */
  webSocket?: ArtifactLiveWebSocket;
}

export interface ArtifactLiveState {
  /** The last presence list, this connection included (compare `id` with `you`). */
  participants: ArtifactLiveParticipant[];
  status: ArtifactLiveConnectionStatus;
  /** This connection's participant id. */
  you: string | null;
  setCursor(at: ArtifactLivePosition | null): boolean;
  setSelection(range: ArtifactLiveRange | null): boolean;
  setTyping(where: ArtifactLiveTyping, active: boolean): boolean;
  setFocus(threadId: string | null): boolean;
  setHidden(hidden: boolean): boolean;
}

const EVERYTHING: ArtifactLiveChange[] = ['comments', 'activity', 'content'];

/**
 * Refetch what changed. `comments`: every comment read of the Artifact except
 * screenshots (immutable bytes), deferred while a comment write is in flight
 * (its own refresh follows and would race this one). `activity`: the activity
 * pages. `content`: the current Artifact, its versions, and the list. Old
 * versions and the Markdown are keyed by version: a new current version moves
 * to a new key.
 */
function refetch(client: QueryClient, projectId: string, artifactId: string, changes: ArtifactLiveChange[]) {
  for (const what of changes) {
    if (what === 'comments') {
      if (client.isMutating({ mutationKey: artifactCommentWriteKey(projectId, artifactId) }) > 0) continue;
      const scope = qk.project.artifactComments(projectId, artifactId);
      void client.invalidateQueries({ queryKey: scope, predicate: (query) => query.queryKey[scope.length] !== 'screenshot' });
    } else if (what === 'activity') {
      void client.invalidateQueries({ queryKey: qk.project.artifactActivity(projectId, artifactId) });
    } else {
      void client.invalidateQueries({ queryKey: qk.project.artifact(projectId, artifactId, 'current'), exact: true });
      void client.invalidateQueries({ queryKey: qk.project.artifactVersions(projectId, artifactId) });
      void client.invalidateQueries({ queryKey: [...qk.project.artifacts(projectId), 'list'] });
    }
  }
}

const ENDED: ArtifactLiveConnectionStatus[] = ['closed', 'access_lost'];

/**
 * Live presence on one Artifact: who is here, their cursors, selections and
 * typing, and a refetch of the TanStack reads when comments, activity or
 * content change. One connection per mounted hook; it closes on unmount, when
 * `enabled` turns false, or when the project or Artifact changes. After a
 * reconnect every read refetches once (`resync`).
 */
export function useArtifactLive(
  projectId: string | null | undefined,
  artifactId: string | null | undefined,
  options: UseArtifactLiveOptions,
): ArtifactLiveState {
  const client = useQueryClient();
  const enabled = options.enabled !== false && !!projectId && !!artifactId;
  const hidden = options.hidden ?? false;
  const [state, setState] = useState<Pick<ArtifactLiveState, 'participants' | 'status' | 'you'>>(() => ({
    participants: [],
    status: enabled ? 'connecting' : 'closed',
    you: null,
  }));
  const connection = useRef<ArtifactLiveConnection | null>(null);
  // The values a new connection starts from, without reconnecting when they change.
  const initial = useRef({ version: options.version ?? null, hidden });
  useEffect(() => {
    initial.current = { version: options.version ?? null, hidden };
  });

  useEffect(() => {
    if (!enabled || !projectId || !artifactId) {
      setState({ participants: [], status: 'closed', you: null });
      return;
    }
    let opened: ArtifactLiveConnection;
    try {
      opened = createArtifactLiveConnection({
        projectId,
        artifactId,
        view: options.view,
        version: initial.current.version,
        hidden: initial.current.hidden,
        webSocket: options.webSocket,
        onEvent: (event) => {
          if (event.type === 'status') {
            setState((current) => ({ ...current, status: event.status, participants: ENDED.includes(event.status) ? [] : current.participants }));
          } else if (event.type === 'welcome') {
            setState((current) => ({ ...current, you: event.you }));
          } else if (event.type === 'presence') {
            setState((current) => ({ ...current, participants: event.participants }));
          } else {
            refetch(client, projectId, artifactId, event.type === 'resync' ? EVERYTHING : [event.what]);
          }
        },
      });
    } catch {
      // No WebSocket in this runtime: presence is off, the reads still poll.
      setState({ participants: [], status: 'closed', you: null });
      return;
    }
    connection.current = opened;
    setState({ participants: [], status: opened.status, you: null });
    return () => {
      if (connection.current === opened) connection.current = null;
      opened.close();
    };
  }, [client, projectId, artifactId, enabled, options.view, options.webSocket]);

  useEffect(() => {
    connection.current?.setHidden(hidden);
  }, [hidden]);

  const setCursor = useCallback((at: ArtifactLivePosition | null) => connection.current?.setCursor(at) ?? false, []);
  const setSelection = useCallback((range: ArtifactLiveRange | null) => connection.current?.setSelection(range) ?? false, []);
  const setTyping = useCallback((where: ArtifactLiveTyping, active: boolean) => connection.current?.setTyping(where, active) ?? false, []);
  const setFocus = useCallback((threadId: string | null) => connection.current?.setFocus(threadId) ?? false, []);
  const setHidden = useCallback((next: boolean) => connection.current?.setHidden(next) ?? false, []);

  return { ...state, setCursor, setSelection, setTyping, setFocus, setHidden };
}
