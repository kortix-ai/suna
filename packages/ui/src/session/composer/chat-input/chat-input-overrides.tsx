'use client';

import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from 'react';

import type { SessionOverrideRow } from '../../overrides/session-overrides-control';
import type { SessionScopeDraft, SessionScopeSelectionCatalog } from '../../scope/session-scope-model';

/**
 * The session-override rows (secrets, provider keys, sandbox, files) as the
 * `chat_input` control renders them.
 *
 * `SessionOverridesToolbar` owns these rows: their drafts, their Save, their
 * permission checks. The host still mounts it where it always did (the
 * composer's `toolbarSlot`). Inside a composer with the flag on, it publishes
 * the rows here instead of drawing its gear, and the control under the
 * composer reads them. One owner, one state: the control holds no copy.
 *
 * A store rather than React state on the card: the rows change on every
 * draft edit, and only the control should re-render for that, not the
 * composer card and its editor.
 */
export interface ChatInputOverrides {
  /** Editable rows only, plus the read-only Files row. */
  rows: SessionOverrideRow[];
  /** The rows whose editor writes through Save (secrets, provider keys). */
  saveRowIds: readonly string[];
  saving: boolean;
  saveDisabled: boolean;
  /** Save would write something: the scope draft or a provider-key draft changed. */
  dirty: boolean;
  pendingNote?: string;
  error?: string | null;
  notice?: ReactNode;
  /** Commits the drafts. Resolves `true` on success. */
  onSave: () => Promise<boolean>;
  /**
   * "Reset to auto" for one overridden row. Secrets and provider keys reset
   * AND save, one click; the gear's reset only edits the draft.
   */
  onResetRow: (id: string) => void;
  /** The secrets and connectors draft, for the control's own editors. */
  scope?: {
    draft: SessionScopeDraft;
    catalog: SessionScopeSelectionCatalog;
    /** The catalog (or the session's scope) has not answered yet. */
    loading: boolean;
    disabled: boolean;
    onChange: (draft: SessionScopeDraft) => void;
  };
  /** The provider-key pools in effect (saved plus drafts), for the control's own editor. */
  providerKeys?: {
    projectId: string;
    sessionId?: string;
    /** Provider id → the key ids in effect. A provider absent here runs on the agent default. */
    selection: Record<string, string[]>;
    canEdit: boolean;
    loading: boolean;
    /** `null` or `[]`: back to the agent default for that provider. */
    onChange: (providerId: string, ids: string[] | null) => void;
  };
}

interface ChatInputOverridesStore {
  get: () => ChatInputOverrides | null;
  set: (value: ChatInputOverrides | null) => void;
  subscribe: (listener: () => void) => () => void;
}

function createChatInputOverridesStore(): ChatInputOverridesStore {
  let value: ChatInputOverrides | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const ChatInputOverridesContext = createContext<ChatInputOverridesStore | null>(null);

/**
 * Mounted by every composer card; it hands out the store only while
 * `chat_input` is on. Always mounted, so the flag resolving after the first
 * render swaps a context value instead of remounting the card and its editor.
 */
export function ChatInputOverridesProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [store] = useState(createChatInputOverridesStore);
  return (
    <ChatInputOverridesContext.Provider value={enabled ? store : null}>{children}</ChatInputOverridesContext.Provider>
  );
}

/** `null` outside a `chat_input` composer: the caller draws its own gear. */
export function useChatInputOverridesStore(): ChatInputOverridesStore | null {
  return useContext(ChatInputOverridesContext);
}

const noSubscribe = () => () => {};
const noValue = () => null;

/** The published rows, or `null` while nothing publishes (no project, host overrides off). */
export function useChatInputOverrides(): ChatInputOverrides | null {
  const store = useContext(ChatInputOverridesContext);
  return useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.get ?? noValue, noValue);
}
