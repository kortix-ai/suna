'use client';

import React, { memo, useCallback, useMemo, useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Check, Lock, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useModelSelection } from '@/hooks/agents';
import { usePricingModalStore } from '@/stores/pricing-modal-store';
import { isProductionMode } from '@/lib/config';
import { ModelProviderIcon } from '@/lib/model-provider-icons';
import { Separator } from '@/components/ui/separator';

// Logo component for mode display with theme support
// Uses CSS to switch between light/dark variants without JS
const ModeLogo = memo(function ModeLogo({ 
  mode, 
  height = 12
}: { 
  mode: 'basic' | 'advanced'; 
  height?: number;
}) {
  const darkSrc = mode === 'advanced' ? '/Advanced-Light.svg' : '/Basic-Light.svg';
  const lightSrc = mode === 'advanced' ? '/Advanced-Dark.svg' : '/Basic-Dark.svg';

  return (
    <span className="flex-shrink-0 relative" style={{ height: `${height}px`, width: 'auto' }}>
      {/* Light mode image */}
      <img
        src={lightSrc}
        alt={mode === 'advanced' ? 'Kortix Advanced' : 'Kortix Basic'}
        className="block dark:hidden"
        style={{ height: `${height}px`, width: 'auto' }}
        suppressHydrationWarning
      />
      {/* Dark mode image */}
      <img
        src={darkSrc}
        alt={mode === 'advanced' ? 'Kortix Advanced' : 'Kortix Basic'}
        className="hidden dark:block"
        style={{ height: `${height}px`, width: 'auto' }}
        suppressHydrationWarning
      />
    </span>
  );
});

export const ModeIndicator = memo(function ModeIndicator() {
  const [isOpen, setIsOpen] = useState(false);
  const {
    selectedModel,
    allModels: modelOptions,
    canAccessModel,
    handleModelChange,
  } = useModelSelection();

  // Check if we should show all models option (non-production mode)
  const showAllModelsOption = !isProductionMode();

  const basicModel = useMemo(
    () => modelOptions.find((m) => m.id === 'kortix/basic' || m.label === 'Kortix Basic'),
    [modelOptions]
  );
  
  const powerModel = useMemo(
    () => modelOptions.find((m) => m.id === 'kortix/power' || m.label === 'Kortix Advanced Mode'),
    [modelOptions]
  );

  // Get other models (not basic or power) for the staging section
  const otherModels = useMemo(() => {
    return modelOptions.filter(
      (m) => m.id !== 'kortix/basic' && m.id !== 'kortix/power' && 
             m.label !== 'Kortix Basic' && m.label !== 'Kortix Advanced Mode'
    ).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }, [modelOptions]);

  // Check if a non-standard model is selected
  const isOtherModelSelected = useMemo(() => {
    return selectedModel && 
           selectedModel !== basicModel?.id && 
           selectedModel !== powerModel?.id;
  }, [selectedModel, basicModel?.id, powerModel?.id]);

  const selectedOtherModel = useMemo(() => {
    if (!isOtherModelSelected) return null;
    return modelOptions.find((m) => m.id === selectedModel);
  }, [isOtherModelSelected, modelOptions, selectedModel]);

  const canAccessPower = powerModel ? canAccessModel(powerModel.id) : false;
  const isPowerSelected = powerModel && selectedModel === powerModel.id;
  const isBasicSelected = basicModel && selectedModel === basicModel.id;

  const handleBasicClick = useCallback(() => {
    if (basicModel) {
      handleModelChange(basicModel.id);
      setIsOpen(false);
    }
  }, [basicModel, handleModelChange]);

  const handleAdvancedClick = useCallback(() => {
    if (powerModel) {
      if (canAccessPower) {
        handleModelChange(powerModel.id);
        setIsOpen(false);
      } else {
        setIsOpen(false);
        usePricingModalStore.getState().openPricingModal({
          isAlert: true,
          alertTitle: 'Upgrade to access Kortix Advanced mode',
        });
      }
    }
  }, [powerModel, canAccessPower, handleModelChange]);

  const handleOtherModelClick = useCallback((modelId: string) => {
    handleModelChange(modelId);
    setIsOpen(false);
  }, [handleModelChange]);

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            'flex items-center gap-2 px-3 py-2 rounded-lg transition-all duration-150 cursor-pointer',
            'hover:bg-accent/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
          )}
        >
          <ModeLogo mode={isPowerSelected ? 'advanced' : 'basic'} height={14} />
          <ChevronDown className={cn(
            "h-4 w-4 text-muted-foreground transition-transform duration-200",
            isOpen && "rotate-180"
          )} strokeWidth={2} />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent 
        align="start" 
        className="w-[320px] p-2 rounded-xl border border-border/50 shadow-lg"
        sideOffset={8}
      >
        {/* Basic Mode */}
        <div
          className={cn(
            'flex items-start gap-3 px-3 py-3 cursor-pointer rounded-lg transition-all duration-150 mb-1.5',
            isBasicSelected 
              ? 'bg-accent' 
              : 'hover:bg-accent/50 active:bg-accent/70'
          )}
          onClick={handleBasicClick}
        >
          <div className="flex-1 min-w-0">
            <div className="mb-1">
              <ModeLogo mode="basic" height={14} />
            </div>
            <div className="text-xs text-muted-foreground leading-relaxed">Fast and efficient for quick tasks</div>
          </div>
          {isBasicSelected && (
            <Check className="h-4 w-4 text-foreground flex-shrink-0 mt-0.5" strokeWidth={2} />
          )}
        </div>

        {/* Advanced Mode */}
        <div
          className={cn(
            'flex items-start gap-3 px-3 py-3 cursor-pointer rounded-lg transition-all duration-150',
            isPowerSelected 
              ? 'bg-accent' 
              : 'hover:bg-accent/50 active:bg-accent/70'
          )}
          onClick={handleAdvancedClick}
        >
          <div className="flex-1 min-w-0">
            <div className="mb-1">
              <ModeLogo mode="advanced" height={14} />
            </div>
            <div className="text-xs text-muted-foreground leading-relaxed">Maximum intelligence for complex work</div>
          </div>
          {isPowerSelected ? (
            <Check className="h-4 w-4 text-foreground flex-shrink-0 mt-0.5" strokeWidth={2} />
          ) : !canAccessPower ? (
            <Lock className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" strokeWidth={2} />
          ) : null}
        </div>

        {/* All Models Section - Only in staging/local mode */}
        {showAllModelsOption && otherModels.length > 0 && (
          <>
            <Separator className="my-2" />
            <div className="px-2 py-1 text-xs font-medium text-muted-foreground flex items-center gap-2">
              <span>All Models</span>
              <span className="text-[10px] px-1.5 py-0.5 bg-amber-500/10 text-amber-600 dark:text-amber-500 rounded-md">
                Staging
              </span>
            </div>
            <div className="max-h-[200px] overflow-y-auto">
              {otherModels.map((model) => {
                const isSelected = selectedModel === model.id;
                
                return (
                  <div
                    key={model.id}
                    className={cn(
                      'flex items-center gap-3 px-3 py-2 cursor-pointer rounded-lg transition-all duration-150 my-0.5',
                      isSelected 
                        ? 'bg-accent' 
                        : 'hover:bg-accent/50 active:bg-accent/70'
                    )}
                    onClick={() => handleOtherModelClick(model.id)}
                  >
                    <ModelProviderIcon modelId={model.id} size={20} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{model.label}</div>
                    </div>
                    {isSelected && (
                      <Check className="h-4 w-4 text-foreground flex-shrink-0" strokeWidth={2} />
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

export default ModeIndicator;

