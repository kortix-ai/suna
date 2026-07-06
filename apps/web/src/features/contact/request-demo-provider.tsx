'use client';

import { createContext, useCallback, useContext, useState } from 'react';
import { DemoQualifierModal } from './demo-qualifier-modal';

const CAL_LINK = 'team/kortix/demo';
const CAL_NAMESPACE = 'kortix-demo';

const RequestDemoContext = createContext<() => void>(() => {});

/** Open the global "Request demo" qualifier modal from anywhere under the provider. */
export function useRequestDemo() {
  return useContext(RequestDemoContext);
}

export function RequestDemoProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const openDemo = useCallback(() => setOpen(true), []);

  return (
    <RequestDemoContext.Provider value={openDemo}>
      {children}
      <DemoQualifierModal
        open={open}
        onOpenChange={setOpen}
        calLink={CAL_LINK}
        calNamespace={CAL_NAMESPACE}
        source="request-demo"
      />
    </RequestDemoContext.Provider>
  );
}
