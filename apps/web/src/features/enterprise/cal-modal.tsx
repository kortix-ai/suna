'use client';

import { Modal, ModalContent } from '@/components/ui/modal';
import Cal, { getCalApi } from '@calcom/embed-react';
import { useEffect } from 'react';

export function EnterpriseCalModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  useEffect(() => {
    (async () => {
      const cal = await getCalApi();

      cal('ui', {
        layout: 'month_view',
        hideEventTypeDetails: false,
      });
    })();
  }, []);

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent
        variant="transparent"
        showCloseButton={false}
        className="border-none bg-transparent shadow-none lg:max-w-6xl lg:p-0"
      >
        <div className="w-full overflow-hidden">
          <Cal
            calLink="team/kortix/enterprise"
            style={{
              width: '100%',
              height: '850px',
              overflow: 'scroll',
            }}
            config={{
              layout: 'month_view',
            }}
          />
        </div>
      </ModalContent>
    </Modal>
  );
}
