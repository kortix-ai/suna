import * as P from '../rest/projects-client';
import { createArtifactLiveConnection, type ArtifactLiveConnectionOptions } from '../artifact-live/connection';
import type { DropFirst } from './binding-types';

export function bindProjectArtifacts(projectId: string) {
  return {
    artifacts: {
      activity: (...args: DropFirst<Parameters<typeof P.listArtifactActivity>>) => P.listArtifactActivity(projectId, ...args),
      /** Live presence: `connect` opens the WebSocket, `ticket` mints one, `signal` names an agent session's place. */
      live: {
        connect: (artifactId: string, options: Omit<ArtifactLiveConnectionOptions, 'projectId' | 'artifactId'>) =>
          createArtifactLiveConnection({ ...options, projectId, artifactId }),
        ticket: (...args: DropFirst<Parameters<typeof P.createArtifactLiveTicket>>) => P.createArtifactLiveTicket(projectId, ...args),
        signal: (...args: DropFirst<Parameters<typeof P.signalArtifactLiveAgent>>) => P.signalArtifactLiveAgent(projectId, ...args),
      },
      comments: {
        readScreenshot: (...args: DropFirst<Parameters<typeof P.readArtifactCommentScreenshot>>) => P.readArtifactCommentScreenshot(projectId, ...args),
        list: (...args: DropFirst<Parameters<typeof P.listArtifactComments>>) => P.listArtifactComments(projectId, ...args),
        get: (...args: DropFirst<Parameters<typeof P.getArtifactCommentThread>>) => P.getArtifactCommentThread(projectId, ...args),
        context: (...args: DropFirst<Parameters<typeof P.getArtifactCommentContext>>) => P.getArtifactCommentContext(projectId, ...args),
        snapshot: (...args: DropFirst<Parameters<typeof P.readArtifactCommentSnapshot>>) => P.readArtifactCommentSnapshot(projectId, ...args),
        create: (...args: DropFirst<Parameters<typeof P.createArtifactComment>>) => P.createArtifactComment(projectId, ...args),
        reply: (...args: DropFirst<Parameters<typeof P.replyArtifactComment>>) => P.replyArtifactComment(projectId, ...args),
        setStatus: (...args: DropFirst<Parameters<typeof P.setArtifactCommentStatus>>) => P.setArtifactCommentStatus(projectId, ...args),
        edit: (...args: DropFirst<Parameters<typeof P.editArtifactComment>>) => P.editArtifactComment(projectId, ...args),
        remove: (...args: DropFirst<Parameters<typeof P.deleteArtifactComment>>) => P.deleteArtifactComment(projectId, ...args),
        send: (...args: DropFirst<Parameters<typeof P.sendArtifactComments>>) => P.sendArtifactComments(projectId, ...args),
      },
    },
  };
}
