'use client';

import { Suspense, useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { SimpleFooter } from '@/components/home/simple-footer';
import { PricingSection } from '@/components/billing/pricing';
import { Skeleton } from '@/components/ui/skeleton';
import { CreditsExplainedModal } from '@/components/billing/credits-explained-modal';

function PricingSkeleton() {
  return (
    <div className="w-full max-w-6xl mx-auto px-6">
      <div className="grid md:grid-cols-4 gap-6">
        <Skeleton className="h-96 w-full rounded-2xl" />
        <Skeleton className="h-96 w-full rounded-2xl col-span-3" />
      </div>
    </div>
  );
}

export default function PricingPage() {
  const [creditsModalOpen, setCreditsModalOpen] = useState(false);

  // Intercept clicks on the credits-explained link
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const link = target.closest('a[href*="credits-explained"]');
      if (link) {
        e.preventDefault();
        e.stopPropagation();
        setCreditsModalOpen(true);
      }
    };

    document.addEventListener('click', handleClick, true);
    return () => document.removeEventListener('click', handleClick, true);
  }, []);

  return (
    <main className="min-h-screen bg-background">
      <article className="max-w-4xl mx-auto px-6 md:px-10 pt-24 md:pt-28 pb-16">
        {/* Pricing Section */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="[&_#pricing]:scale-100 [&_.max-w-6xl]:max-w-full [&_.border-dashed]:hidden [&_#pricing>div]:px-0 [&_#pricing>div>div:first-child]:mb-2"
        >
          <Suspense fallback={<PricingSkeleton />}>
            <PricingSection
              returnUrl={typeof window !== 'undefined' ? window.location.href : '/pricing'}
              showTitleAndTabs={true}
              customTitle="Choose your plan"
            />
          </Suspense>
        </motion.div>

        {/* Credits Explained Modal */}
        <CreditsExplainedModal
          open={creditsModalOpen}
          onOpenChange={setCreditsModalOpen}
        />

      </article>

      <SimpleFooter />
    </main>
  );
}
