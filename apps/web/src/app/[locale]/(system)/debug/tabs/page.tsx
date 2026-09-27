'use client';

import { Button } from '@/components/ui/button';
import { Modal, ModalContent, ModalHeader, ModalTitle } from '@/components/ui/modal';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTranslations } from '@/i18n/use-translations';
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [open, setOpen] = useState(false);
  return (
    <div className="bg-background min-h-screen space-y-6 p-8">
      <div>
        <p className="text-muted-foreground mb-2 text-xs">
          {tI18nComplete.raw('text69020faeaf20')}
        </p>
        <Strip testId="inline-strip" />
      </div>
      <Button onClick={() => setOpen(true)}>{tI18nComplete.raw('textda906414ef1b')}</Button>
      <Modal open={open} onOpenChange={setOpen}>
        <ModalContent>
          <ModalHeader>
            <ModalTitle>{tI18nComplete.raw('textd17d2d78d76e')}</ModalTitle>
          </ModalHeader>
          <Strip testId="modal-strip" />
        </ModalContent>
      </Modal>
    </div>
  );
}
