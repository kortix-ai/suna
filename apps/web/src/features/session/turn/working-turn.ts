/**
 * Moved to `@kortix/sdk` (`packages/sdk/src/core/turns/segments/working-turn.ts`)
 * so web and mobile resolve the working turn from one implementation. This file
 * keeps the old import path working for existing web call sites. The working
 * turn itself is `SessionLogTurn.live` / `queued` (`sessionLogTurns`).
 */
export {
  fallbackBusyRowAfterTurnId,
  freshSendHint,
  shouldSuppressWorkingTurnBusy,
  turnIsConfirmedActive,
  turnRendersQueued,
  workingTurnDrawsBusyRow,
} from '@kortix/sdk';
export type { WorkingTurnResolution } from '@kortix/sdk';
