// The rules live in `@kortix/sdk` (core/models/provider-connections) so the TUI
// reads the same ones. These names stay for the web's existing imports.
export {
  type ConnectionAccessChoice,
  type ConnectionAccessSummary as AccessSummary,
  connectionAccessSummary as accessSummary,
  connectionLabelOwnerName as labelOwnerName,
  connectionNeedsReconnection as needsReconnection,
  connectionSharing as chatGptSharing,
  providerKeyAccessFields as keyAccessFields,
} from '@kortix/sdk';
