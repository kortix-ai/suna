'use client';

import { createContext, useContext, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import type { ChangeRequest } from '@kortix/sdk';

export interface SessionChangeRequests {
  requests: ChangeRequest[];
  onOpen: (crId: string) => void;
  onJump: (crId: string) => Promise<void>;
  jumping: boolean;
}

const ReadContext = createContext<SessionChangeRequests | null>(null);
const WriteContext = createContext<Dispatch<SetStateAction<SessionChangeRequests | null>> | null>(null);

/** Chat and the mobile panel are siblings. Share the existing read, never a second query. */
export function SessionOutcomesBridge({ children }: { children: ReactNode }) {
  const [value, setValue] = useState<SessionChangeRequests | null>(null);
  return (
    <WriteContext.Provider value={setValue}>
      <ReadContext.Provider value={value}>{children}</ReadContext.Provider>
    </WriteContext.Provider>
  );
}

export const useSessionChangeRequestsPanel = () => useContext(ReadContext);
export const usePublishSessionChangeRequests = () => useContext(WriteContext);
