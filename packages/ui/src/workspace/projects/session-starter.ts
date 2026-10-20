import type { ProjectSession, ProjectSessionInitiatorType } from '@kortix/sdk';

/**
 * Who started the RUN a session belongs to, read from the server-derived
 * `initiator` (never from `created_by`: a child keeps its creator's ownership
 * but shows its run's starter). A row the backfill could not classify has no
 * initiator and reads as a member: the session's creator.
 */
export interface SessionStarter {
  type: ProjectSessionInitiatorType;
  /** Display label. "You" only when the initiator is the viewer. */
  label: string;
  isViewer: boolean;
  /** trigger slug, channel id, or service-account id — for tooltips and icons. */
  id: string | null;
}

export function sessionStarter(
  session: Pick<
    ProjectSession,
    'initiator' | 'is_owner' | 'owner_name' | 'owner_email' | 'created_by'
  >,
  viewerId: string | null,
  labels: { you: string; unknown: string },
): SessionStarter {
  const initiator = session.initiator;
  if (!initiator || initiator.type === 'member') {
    const id = initiator?.id ?? session.created_by ?? null;
    // No initiator: fall back to the viewer-relative `is_owner`. With an
    // initiator, compare its id to the viewer when we know who they are.
    const isViewer =
      initiator?.id && viewerId ? initiator.id === viewerId : session.is_owner !== false;
    const name = initiator?.label || session.owner_name || session.owner_email || null;
    return { type: 'member', id, isViewer, label: isViewer ? labels.you : (name ?? labels.unknown) };
  }
  return {
    type: initiator.type,
    id: initiator.id,
    isViewer: false,
    label: initiator.label || initiator.id || labels.unknown,
  };
}
