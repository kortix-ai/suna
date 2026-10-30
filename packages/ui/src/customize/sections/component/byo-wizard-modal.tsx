'use client';

import { Modal, ModalContent } from '../../../primitives/modal';
import { Stepper } from '../../../primitives/stepper';
import type { ReactNode } from 'react';

export function ByoWizardModal({
  platform,
  open,
  onOpenChange,
  step,
  setStep,
  count,
  header,
  steps,
  children,
  footer,
}: {
  platform: 'teams' | 'slack';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  step: 1 | 2 | 3;
  setStep: (step: 1 | 2 | 3) => void;
  count: number;
  header: ReactNode;
  steps: ReactNode;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent
        variant="base"
        className={platform === 'teams'
          ? 'space-y-0 overflow-hidden lg:h-auto lg:max-w-4xl lg:flex-row'
          : 'space-y-0 overflow-hidden lg:max-w-4xl lg:flex-row'}
      >
        <aside className={platform === 'teams'
          ? 'bg-sidebar flex flex-col gap-6 border-b p-6 lg:w-72 lg:shrink-0 lg:border-e lg:border-b-0'
          : 'flex flex-col gap-6 border-b bg-sidebar p-5 lg:w-72 lg:shrink-0 lg:border-e lg:border-b-0'}>
          {header}
          <Stepper
            orientation="vertical"
            count={count}
            value={step}
            onValueChange={(v) => {
              if (v === 1 || v === 2 || v === 3) setStep(v);
            }}
            className="flex flex-col"
          >
            {steps}
          </Stepper>
        </aside>
        <section className={platform === 'teams'
          ? 'flex min-w-0 flex-1 flex-col'
          : 'flex min-w-0 flex-1 flex-col lg:min-h-176'}>
          {children}
          <footer className={platform === 'teams'
            ? 'flex items-center justify-between gap-4 border-t px-6 py-4'
            : 'flex items-center justify-between gap-3 border-t px-6 py-4'}>
            {footer}
          </footer>
        </section>
      </ModalContent>
    </Modal>
  );
}
