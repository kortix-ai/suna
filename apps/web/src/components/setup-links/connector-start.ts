// Moved to `@kortix/sdk` (KRTX-1012): one start-outcome rule, in the SDK core.
// This shim keeps the old host import path resolving; the rule itself is the
// SDK's `resolveConnectorStart`.
export {
  resolveConnectorStart,
  type ConnectorStartOutcome,
} from '@kortix/sdk';
