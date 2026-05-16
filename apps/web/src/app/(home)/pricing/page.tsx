'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { CreditsExplainedModal } from '@/components/billing/credits-explained-modal';
import { Button } from '@/components/ui/button';
import { ArrowRight } from 'lucide-react';
import Link from 'next/link';

export default function PricingPage() {
  const [creditsModalOpen, setCreditsModalOpen] = useState(false);

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
            Seats, compute, and LLM usage stay tied to your account and project sessions.
          </p>
          <Button asChild size="lg" className="px-10">
            <Link href="/projects">
              Open projects <ArrowRight className="ml-2 size-4" />
            </Link>
          </Button>
        </motion.div>

        <CreditsExplainedModal open={creditsModalOpen} onOpenChange={setCreditsModalOpen} />
      </article>
    </main>
  );
}
