import React from 'react';
import { ArrowUpRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { usePricingModalStore } from '@/stores/pricing-modal-store';

// Regex to match <upgrade/> tags
const UPGRADE_BUTTON_REGEX = /<upgrade\s*\/?>/gi;

/**
 * Extracts upgrade button tags from content
 */
export function extractUpgradeButton(content: string): {
  cleanContent: string;
  hasUpgradeButton: boolean;
} {
  let hasUpgradeButton = false;

  const cleanContent = content.replace(UPGRADE_BUTTON_REGEX, () => {
    hasUpgradeButton = true;
    return '';
  });

  return {
    cleanContent: cleanContent.trim(),
    hasUpgradeButton,
  };
}

export interface UpgradeButtonCTAProps {
  className?: string;
}

export const UpgradeButtonCTA: React.FC<UpgradeButtonCTAProps> = ({
  className,
}) => {
  const { openPricingModal } = usePricingModalStore();

  const handleUpgradeClick = () => {
    openPricingModal({
      title: 'Upgrade your plan',
    });
  };

  return (
    <div
      className={cn(
        'flex items-center gap-3 p-3 rounded-2xl mt-4',
        'bg-muted/50',
        'border',
        className
      )}
    >
      <div className="flex-shrink-0 w-10 h-10 bg-muted-foreground/20 border border-muted-foreground/20 rounded-xl flex items-center justify-center">
        <KortixLogo size={20} variant="symbol" />
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold">
          Unlock more with Kortix
        </p>
        <p className="text-xs text-muted-foreground/90 mt-0.5">
          Get more credits, faster responses, and unlimited chats
        </p>
      </div>

      <Button onClick={handleUpgradeClick}>
        Upgrade
        <ArrowUpRight className="w-3.5 h-3.5" />
      </Button>
    </div>
  );
};
