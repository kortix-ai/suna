'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { useNewInstanceModalStore } from '@/stores/pricing-modal-store';
import { CreditsExplainedModal } from '@/components/billing/credits-explained-modal';
import { Button } from '@/components/ui/button';
import { ArrowRight } from 'lucide-react';

export default function PricingPage() {
  const [creditsModalOpen, setCreditsModalOpen] = useState(false);
  const openNewInstanceModal = useNewInstanceModalStore((s) => s.openNewInstanceModal);

  return (
    <main className="min-h-screen bg-background">
      <article className="max-w-4xl mx-auto px-6 md:px-10 pt-24 md:pt-28 pb-16">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="text-center space-y-6"
        >
          <h1 className="text-4xl font-semibold tracking-tight">Simple pricing</h1>
          <p className="text-muted-foreground text-lg max-w-xl mx-auto">
            One machine, one subscription. Priced by the specs you need.
          </p>
          <Button size="lg" className="px-10" onClick={() => openNewInstanceModal()}>
            Get Your Kortix <ArrowRight className="ml-2 size-4" />
          </Button>
        </motion.div>

        <CreditsExplainedModal open={creditsModalOpen} onOpenChange={setCreditsModalOpen} />
      </article>
    </main>
  );
}
