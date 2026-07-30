'use client';

import { Button } from '@/components/ui/button';
import { ProjectCreateModal } from '@/features/projects/modal/project-create-modal';
import { setBootstrapAuthToken } from '@/lib/auth-token';
import { useEffect, useState } from 'react';

export default function DebugProjectCreateModalPage() {
  const [open, setOpen] = useState(true);
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    setBootstrapAuthToken('debug-project-create-token');
    setAuthReady(true);
    return () => {
      setBootstrapAuthToken(null);
      setAuthReady(false);
    };
  }, []);

  return (
    <main className="bg-background text-foreground min-h-screen p-8">
      <Button type="button" onClick={() => setOpen(true)}>
        Open project create modal
      </Button>
      {authReady ? (
        <ProjectCreateModal
          open={open}
          onOpenChange={setOpen}
          accountId="00000000-0000-4000-a000-000000000101"
        />
      ) : null}
    </main>
  );
}
