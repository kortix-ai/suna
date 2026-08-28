'use client';

import { Button } from '@/components/ui/button';
import { Modal, ModalContent, ModalHeader, ModalTitle } from '@/components/ui/modal';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useState } from 'react';

/**
 * /debug/tabs
 *
 * The sliding tab indicator measures itself in a layout effect. A dialog opens
 * with `zoom-in-95`, so that measurement lands while the whole subtree is
 * scaled — and `ResizeObserver` never corrects it, because a transform does not
 * change layout size. This page opens the same `Tabs` inline and in a `Modal`
 * so the two can be compared.
 *
 * Not linked from anywhere; just hit /debug/tabs.
 */
const TABS = [
  { id: 'providers', label: 'Providers' },
  { id: 'models', label: 'Models' },
  { id: 'custom', label: 'Custom' },
];

function Strip({ testId }: { testId: string }) {
  const [value, setValue] = useState('models');
  return (
    <div data-testid={testId}>
      <Tabs value={value} onValueChange={setValue}>
        <TabsList>
          {TABS.map((t) => (
            <TabsTrigger key={t.id} value={t.id}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  );
}

export default function DebugTabsPage() {
  const [open, setOpen] = useState(false);
  return (
    <div className="bg-background min-h-screen space-y-6 p-8">
      <div>
        <p className="text-muted-foreground mb-2 text-xs">Inline (never scaled) — the reference</p>
        <Strip testId="inline-strip" />
      </div>
      <Button onClick={() => setOpen(true)}>Open dialog</Button>
      <Modal open={open} onOpenChange={setOpen}>
        <ModalContent>
          <ModalHeader>
            <ModalTitle>Models</ModalTitle>
          </ModalHeader>
          <Strip testId="modal-strip" />
        </ModalContent>
      </Modal>
    </div>
  );
}
