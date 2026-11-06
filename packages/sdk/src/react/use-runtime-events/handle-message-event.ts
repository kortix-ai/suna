import { applyPartDiagnostics } from './diagnostics';
import type { HandlerContext } from './handler-context';
import type { RuntimeEvent } from './types';
export function handleMessageEvent(event: RuntimeEvent, ctx: HandlerContext) {
  const { normalizeDiagnosticPaths } = ctx;
  switch (event.type) {
    case 'message.updated':
      break;
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
