'use client';

import React from 'react';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { usePricingModalStore } from '@/stores/pricing-modal-store';
import { isLocalMode } from '@/lib/config';

export function UpgradeCTA() {
  const openPricingModal = usePricingModalStore((s) => s.openPricingModal);

  if (isLocalMode()) return null;

  return (
    <Button
      variant="default"
      size="sm"
      className="h-9 px-4 gap-2 my-3"
      onClick={() => openPricingModal()}
    >
      <Sparkles className="h-4 w-4" />
      <span>Upgrade</span>
    </Button>
  );
}

// Regex to match <upgrade_cta .../> tags
const UPGRADE_CTA_REGEX = /<upgrade_cta\s*(?:recommended_plan=["']?(?:plus|pro)["']?)?\s*\/?>/gi;

/**
 * Extracts upgrade CTA tags from content and returns clean content + whether CTA was found
 */
export function extractUpgradeCTA(content: string): {
  cleanContent: string;
  hasCTA: boolean;
} {
  let hasCTA = false;

  const cleanContent = content.replace(UPGRADE_CTA_REGEX, () => {
    hasCTA = true;
    return '';
  });

  return {
    cleanContent: cleanContent.trim(),
    hasCTA,
  };
}
