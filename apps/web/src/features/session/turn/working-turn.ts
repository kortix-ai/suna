// The working-turn rules live in `@kortix/sdk` (`core/turns/segments/
// working-turn.ts`), shared with mobile. This module is a thin re-export.
export {
  busyRowTurnPresentation,
  fallbackBusyRowAfterTurnId,
  freshSendHint,
  resolveBusyRow,
  resolveWorkingTurn,
  shouldSuppressWorkingTurnBusy,
  turnIsConfirmedActive,
  workingTurnDrawsBusyRow,
} from '@kortix/sdk';
export type {
  BusyRowInput,
  BusyRowProjection,
  BusyRowPrompt,
  BusyRowResolution,
  WorkingTurnResolution,
} from '@kortix/sdk';
