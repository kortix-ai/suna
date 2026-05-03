'use client';

import { Navbar } from '@/components/home/navbar';
import { SimpleFooter } from '@/components/home/simple-footer';
import { NewInstanceModal } from '@/components/billing/pricing/new-instance-modal';
import { useNewInstanceModalStore } from '@/stores/pricing-modal-store';
import { Children } from 'react';

function GlobalNewInstanceModal() {
  const { isOpen, title, closeNewInstanceModal } = useNewInstanceModalStore();
  return <NewInstanceModal open={isOpen} onOpenChange={(o) => !o && closeNewInstanceModal()} title={title} />;
}

export default function HomeLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const routedChildren = Children.toArray(children);

  return (
    <div className="w-full min-h-dvh relative">
      <div className="fixed top-0 left-0 right-0 z-50">
        <Navbar isAbsolute />
      </div>
      {routedChildren}
      <SimpleFooter />
      <GlobalNewInstanceModal />
    </div>
  );
}
