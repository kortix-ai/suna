import React from 'react';
import { ArrowUpRight, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useRouter } from 'next/navigation';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { usePricingModalStore } from '@/stores/pricing-modal-store';

export interface ToolUpgradeCTAProps {
  toolName: string;
  currentTier?: string;
  currentTierDisplay?: string;
  className?: string;
}

export const ToolUpgradeCTA: React.FC<ToolUpgradeCTAProps> = ({
  toolName,
  currentTier,
  currentTierDisplay,
  className,
}) => {
  const { openPricingModal } = usePricingModalStore();
  const handleUpgradeClick = () => {
    openPricingModal({
      title: 'Upgrade to access this tool',
    });
  };

  return (
    <div
      className={cn(
        'flex items-center gap-3 p-3 rounded-2xl',
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
          Upgrade to unlock this feature
        </p>
        <p className="text-xs text-muted-foreground/90 mt-0.5">
          {currentTierDisplay || 'Your current'} plan doesn't include access to {toolName}
        </p>
      </div>

      <Button
        onClick={handleUpgradeClick}
      >
        Upgrade
        <ArrowUpRight className="w-3.5 h-3.5" />
      </Button>
    </div>
  );
};


interface AccessErrorResult {
  isAccessDenied: boolean;
  errorCode?: string;
  upgradeRequired?: boolean;
  currentTier?: string;
  currentTierDisplay?: string;
  errorMessage?: string;
}

function tryParse(str: string): any {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function checkForAccessError(obj: any): AccessErrorResult | null {
  if (!obj) return null;

  if (obj.error_code === 'TOOL_ACCESS_DENIED' && obj.upgrade_required) {
    return {
      isAccessDenied: true,
      errorCode: obj.error_code,
      upgradeRequired: obj.upgrade_required,
      currentTier: obj.current_tier,
      currentTierDisplay: obj.current_tier_display,
      errorMessage: obj.error,
    };
  }

  if (obj.output) {
    const output = typeof obj.output === 'string' ? tryParse(obj.output) : obj.output;
    if (output?.error_code === 'TOOL_ACCESS_DENIED') {
      return {
        isAccessDenied: true,
        errorCode: output.error_code,
        upgradeRequired: output.upgrade_required,
        currentTier: output.current_tier,
        currentTierDisplay: output.current_tier_display,
        errorMessage: output.error,
      };
    }
  }

  if (obj.result?.output) {
    const output = typeof obj.result.output === 'string' ? tryParse(obj.result.output) : obj.result.output;
    if (output?.error_code === 'TOOL_ACCESS_DENIED') {
      return {
        isAccessDenied: true,
        errorCode: output.error_code,
        upgradeRequired: output.upgrade_required,
        currentTier: output.current_tier,
        currentTierDisplay: output.current_tier_display,
        errorMessage: output.error,
      };
    }
  }

  return null;
}

export function parseToolAccessError(toolData: any): AccessErrorResult {
  if (!toolData) {
    return { isAccessDenied: false };
  }

  try {
    const data = typeof toolData === 'string' ? tryParse(toolData) : toolData;
    if (!data) return { isAccessDenied: false };

    const direct = checkForAccessError(data);
    if (direct) return direct;

    if (data.tool_result) {
      const toolResult = typeof data.tool_result === 'string' ? tryParse(data.tool_result) : data.tool_result;
      const result = checkForAccessError(toolResult);
      if (result) return result;
    }

    if (data.content) {
      const content = typeof data.content === 'string' ? tryParse(data.content) : data.content;
      const result = checkForAccessError(content);
      if (result) return result;
    }

    if (data.metadata) {
      const metadata = typeof data.metadata === 'string' ? tryParse(data.metadata) : data.metadata;
      const result = checkForAccessError(metadata);
      if (result) return result;
    }
  } catch {
  }

  return { isAccessDenied: false };
}
