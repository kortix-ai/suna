'use client';

import { memo, useState, useEffect, useCallback } from 'react';
import { Brain, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useMemoryStats } from '@/hooks/memory/use-memory';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { PlanSelectionModal } from '@/components/billing/pricing/plan-selection-modal';

interface MemoryToggleProps {
  disabled?: boolean;
  memoryEnabled?: boolean;
  onMemoryToggle?: (enabled: boolean) => void;
}

export const MemoryToggle = memo(function MemoryToggle({ 
  disabled, 
  memoryEnabled: controlledEnabled,
  onMemoryToggle 
}: MemoryToggleProps) {
  const t = useTranslations('settings.memory');
  const { data: stats } = useMemoryStats();
  const [localEnabled, setLocalEnabled] = useState(true);
  const [showPlanModalOpen, setShowPlanModalOpen] = useState(false);

  useEffect(() => {
    if (controlledEnabled !== undefined) {
      setLocalEnabled(controlledEnabled);
    }
  }, [controlledEnabled]);

  const isControlled = onMemoryToggle !== undefined;
  const isEnabled = isControlled ? (controlledEnabled ?? true) : localEnabled;
  const isFreeTier = stats?.tier_name === 'free';

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (isFreeTier) {
      setShowPlanModalOpen(true);
      return;
    }
    
    if (onMemoryToggle) {
      onMemoryToggle(!isEnabled);
    } else {
      setLocalEnabled(prev => !prev);
    }
  }, [isFreeTier, setShowPlanModalOpen, onMemoryToggle, isEnabled]);

  return (
    <>
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          onClick={handleToggle}
          disabled={disabled}
          className={cn(
            "relative h-10 w-10 p-0 bg-transparent border-[1.5px] border-border rounded-2xl text-muted-foreground hover:text-foreground hover:bg-accent/50 flex items-center justify-center cursor-pointer transition-colors",
            !isFreeTier && isEnabled && "text-foreground bg-muted dark:bg-muted/50"
          )}
        >
          <Brain className="h-4 w-4" />
          {isFreeTier && (
            <div className="absolute -top-1 -right-1 bg-background bg-primary rounded-full w-5 h-5 flex items-center justify-center">
              <Lock className="h-2.5 w-2.5 scale-70 text-primary-foreground" />
            </div>
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">
        {isFreeTier ? (
          <>
            <p>{t('upgradeRequired') || 'Memory requires upgrade'}</p>
            <p className="text-xs text-muted-foreground">{t('clickToUpgrade') || 'Click to see plans'}</p>
          </>
        ) : (
          <>
            <p>{isEnabled ? (t('memoryEnabledTooltip') || 'Memory enabled') : (t('memoryDisabledTooltip') || 'Memory disabled')}</p>
            <p className="text-xs text-muted-foreground">{t('clickToToggle') || `Click to ${isEnabled ? 'disable' : 'enable'}`}</p>
          </>
        )}
      </TooltipContent>
    </Tooltip>
    <PlanSelectionModal
        open={showPlanModalOpen}
        onOpenChange={setShowPlanModalOpen}
        returnUrl={typeof window !== 'undefined' ? window.location.href : '/'}
      />
    </>
  );
});
