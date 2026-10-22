import { useSyncStore } from '../../browser/stores/sync-store';
import { applyPartDiagnostics } from './diagnostics';
import type { HandlerContext } from './handler-context';
import type { RuntimeEvent } from './types';
export function handleMessageEvent(event: RuntimeEvent, ctx: HandlerContext) {
  const { reconcileTail, userPartsGraceMs, normalizeDiagnosticPaths } = ctx;
  switch (event.type) {
    case 'message.updated': {
      const info = (
        event.properties as { info?: { id?: string; role?: string; sessionID?: string } }
      ).info;
      const sessionID = info?.sessionID ?? (event.properties as { sessionID?: string }).sessionID;
      if (info?.role === 'user' && info.id && sessionID) {
        const messageID = info.id;
        setTimeout(() => {
          const state = useSyncStore.getState();
          const stillListed = state.messages[sessionID]?.some((m) => m.id === messageID);
          if (stillListed && !(state.parts[messageID]?.length ?? 0)) {
            void reconcileTail(sessionID, 'sse-gap');
          }
        }, userPartsGraceMs);
      }
      break;
    }
    case 'message.removed':
      break;
    case 'message.part.updated': {
      applyPartDiagnostics(event.properties.part, normalizeDiagnosticPaths);
      break;
    }
    case 'message.part.removed':
      break;
    default:
      break;
  }
}
