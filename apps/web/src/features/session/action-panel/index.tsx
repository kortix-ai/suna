'use client';

/**
 * Picks which panel presentation to render for a session: `EasyPanel` (the
 * plain-language card home) or `AdvancedPanel` (the tool-call stepper),
 * driven by `preferences.panelMode`.
 *
 * `isSessionBusy` (the session's own busy/retry status, computed once in
 * `session-layout.tsx`) only matters to `EasyPanel` — it ORs this with its own
 * part-derived running flag so an inter-tool-call gap doesn't read as
 * "finished". `AdvancedPanel` derives its own presentation per tool part and
 * never needs a session-wide running flag.
 */

import { useUserPreferencesStore } from '@/stores/user-preferences-store';
import type { MessageWithParts } from '@/ui';
import { AdvancedPanel } from './advanced/advanced-panel';
import { EasyPanel } from './easy/easy-panel';

export function ActionPanel({
  sessionId,
  messages,
  isSessionBusy = false,
}: {
  sessionId: string;
  messages: MessageWithParts[] | undefined;
  isSessionBusy?: boolean;
}) {
  // Users with preferences persisted before this shipped have no panelMode key.
  const mode = useUserPreferencesStore((s) => s.preferences.panelMode ?? 'easy');
  return mode === 'advanced' ? (
    <AdvancedPanel sessionId={sessionId} messages={messages} />
  ) : (
    <EasyPanel sessionId={sessionId} messages={messages} isSessionBusy={isSessionBusy} />
  );
}
