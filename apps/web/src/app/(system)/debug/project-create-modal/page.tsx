'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ProjectCreateModal } from '@/features/projects/modal/project-create-modal';
import { setBootstrapAuthToken } from '@/lib/auth-token';

export default function DebugProjectCreateModalPage() {
  const [open, setOpen] = useState(true);

  useEffect(() => {
    setBootstrapAuthToken('debug-project-create-token');
    return () => setBootstrapAuthToken(null);
  }, []);

  return (
    <main className="min-h-screen bg-background p-8 text-foreground">
      <Button type="button" onClick={() => setOpen(true)}>
        Open project create modal
      </Button>
      <ProjectCreateModal
        open={open}
        onOpenChange={setOpen}
        accountId="00000000-0000-4000-a000-000000000101"
      />
    </main>
  );
}
