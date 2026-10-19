import type { KortixSendError } from '@kortix/sdk/react';

import { type ChatStrings, defaultChatStrings } from '../providers/ui-provider';

/**
 * A one-line title for a failed send. `useSession` surfaces a typed
 * `sendError` whose `message` the SDK already formats for display; the title
 * names the kind of problem, because each kind needs a different reaction.
 * `t` is the chat copy (`useUiStrings().chat`); default: English.
 */
export function sendFailureTitle(error: KortixSendError, t: ChatStrings = defaultChatStrings): string {
  switch (error.kind) {
    case 'billing':
      // The end user cannot retry this; the operator has to act.
      return t.sendFailedBilling;
    case 'runtime-not-ready':
      // Transient and self-healing: a retry is the right move.
      return t.sendFailedRuntimeNotReady;
    case 'runtime-error':
      return error.gateway?.provider ? t.sendFailedModel(error.gateway.provider) : t.sendFailedRuntimeError;
    default:
      return t.sendFailed;
  }
}
