'use client';

import { FirmGate, SignedIn } from '@/components/access';
import { AppShell } from '@/components/app-shell';

/** Every /app page: signed in, inside the active firm, in the app shell. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <SignedIn>
      <FirmGate>
        <AppShell>{children}</AppShell>
      </FirmGate>
    </SignedIn>
  );
}
