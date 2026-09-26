import { useDiagnosticsStore } from '../browser/stores/diagnostics-store';
import { useOpenCodePendingStore } from '../browser/stores/opencode-pending-store';
import { useSessionWorkingStore } from '../browser/stores/session-working-store';
import { useSyncStore } from '../browser/stores/sync-store';
import { resetSessionCacheOwnership } from '../browser/session-sync/session-cache-ownership';
import { resetSessionSyncControllers } from '../browser/session-sync/session-sync-registry';
import { registerIdentityReset, runIdentityResets } from './identity-reset-registry';
import { resetSessionOpenPrefetches } from './prefetch-session-open';
// Registers the model store's reset (module-scoped picks and their storage key).
import './use-model-store';

registerIdentityReset(() => useSyncStore.getState().reset());
registerIdentityReset(() => useOpenCodePendingStore.getState().clear());
registerIdentityReset(() => useSessionWorkingStore.getState().reset());
registerIdentityReset(() => useDiagnosticsStore.getState().clearAll());
registerIdentityReset(resetSessionSyncControllers);
registerIdentityReset(resetSessionCacheOwnership);
registerIdentityReset(resetSessionOpenPrefetches);

/**
 * Forget every piece of in-memory session state that belongs to the signed-in
 * user. Call it on EVERY identity change: sign-out, and a different user
 * signing in — including a sign-in from another tab that swaps the identity
 * without a page load.
 *
 * Clears: session transcripts (sync store), pending permission and question
 * asks and per-session auto-approve, turn receipts, LSP diagnostics (file
 * paths and messages from the event stream), session history controllers and
 * their cache ownership, open-read prefetch windows, and the model store
 * (per-agent, per-session and default model picks, plus its `localStorage`
 * key).
 *
 * It does NOT clear the host's own caches (React Query, host stores) or the
 * auth token source; the host resets those beside this call. Never throws: a
 * reset that fails is logged and the others still run.
 */
export function resetIdentityState(): void {
  runIdentityResets();
}
