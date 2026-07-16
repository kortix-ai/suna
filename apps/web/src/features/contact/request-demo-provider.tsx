'use client';

import { createContext, useCallback, useContext, useState } from 'react';
import { DemoQualifierModal } from './demo-qualifier-modal';

const CAL_LINK = 'team/kortix/demo';
const CAL_NAMESPACE = 'kortix-demo';

const DEFAULT_SOURCE = 'request-demo';

export interface OpenDemoOptions {
  /** Where the modal was opened from — recorded on the lead + the notification
   *  email so we can see which surface drove the request (e.g. 'accounts-audit'). */
  source?: string;
}

const RequestDemoContext = createContext<(opts?: OpenDemoOptions) => void>(() => {});

/** Open the global "Request demo" qualifier modal from anywhere in the app.
 *  Mounted once in the root layout, so every authenticated and public surface
 *  can call this without wiring up its own provider. */
export function useRequestDemo() {
  return useContext(RequestDemoContext);
}

export function RequestDemoProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState(DEFAULT_SOURCE);
  const openDemo = useCallback((opts?: OpenDemoOptions) => {
    setSource(opts?.source || DEFAULT_SOURCE);
    setOpen(true);
  }, []);

  return (
    <RequestDemoContext.Provider value={openDemo}>
      {children}
      <DemoQualifierModal
        open={open}
        onOpenChange={setOpen}
        calLink={CAL_LINK}
        calNamespace={CAL_NAMESPACE}
        source={source}
      />
    </RequestDemoContext.Provider>
  );
}
