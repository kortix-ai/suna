'use client';

import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ProviderPoolDrafts } from './provider-pool-draft';

function useEditingState() {
  const [providerDrafts, setProviderDrafts] = useState<ProviderPoolDrafts>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  return useMemo(() => ({ providerDrafts, setProviderDrafts, saveError, setSaveError, saving, setSaving, savingRef }),
    [providerDrafts, saveError, saving]);
}

const DraftContext = createContext<(ReturnType<typeof useEditingState> & { identity: string }) | null>(null);

function DraftProvider({ identity, children }: { identity: string; children: ReactNode }) {
  const state = useEditingState();
  const value = useMemo(() => ({ ...state, identity }), [state, identity]);
  return <DraftContext.Provider value={value}>{children}</DraftContext.Provider>;
}

export function ProviderPoolDraftBoundary({ identity, children }: { identity: string; children: ReactNode }) {
  const parent = useContext(DraftContext);
  return parent?.identity === identity ? children : <DraftProvider key={identity} identity={identity}>{children}</DraftProvider>;
}

export function useProviderPoolEditingState() {
  const state = useContext(DraftContext);
  if (!state) throw new Error('Provider pool editor requires a draft boundary');
  return state;
}
