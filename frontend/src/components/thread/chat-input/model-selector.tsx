'use client';

import React, { useState, useRef, useEffect } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { Check, ChevronDown, Search, AlertTriangle, Crown, ArrowUpRight, Brain, Plus, Edit, Trash, Cpu, Key, KeyRound } from 'lucide-react';
import {
  ModelOption,
  SubscriptionStatus,
  STORAGE_KEY_MODEL,
  STORAGE_KEY_CUSTOM_MODELS,
  DEFAULT_FREE_MODEL_ID,
  DEFAULT_PREMIUM_MODEL_ID,
  formatModelName,
  getCustomModels,
  MODELS // Import the centralized MODELS constant
} from './_use-model-selection';
import { PaywallDialog } from '@/components/payment/paywall-dialog';
import { BillingModal } from '@/components/billing/billing-modal';
import { cn } from '@/lib/utils';
import { useRouter } from 'next/navigation';
import { isLocalMode } from '@/lib/config';
import { CustomModelDialog, CustomModelFormData } from './custom-model-dialog';
import Link from 'next/link';

interface CustomModel {
  id: string;
  label: string;
}


interface ModelSelectorProps {
  selectedModel: string;
  onModelChange: (modelId: string) => void;
  modelOptions: ModelOption[];
  canAccessModel: (modelId: string) => boolean;
  subscriptionStatus: SubscriptionStatus;
  refreshCustomModels?: () => void;
  billingModalOpen: boolean;
  setBillingModalOpen: (open: boolean) => void;
  hasBorder?: boolean;
}

export const ModelSelector: React.FC<ModelSelectorProps> = ({
  selectedModel,
  onModelChange,
  modelOptions,
  canAccessModel,
  subscriptionStatus,
  refreshCustomModels,
  billingModalOpen,
  setBillingModalOpen,
  hasBorder = false,
}) => {
  const [paywallOpen, setPaywallOpen] = useState(false);
  const [lockedModel, setLockedModel] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  // Custom models state
  const [customModels, setCustomModels] = useState<CustomModel[]>([]);
  const [isCustomModelDialogOpen, setIsCustomModelDialogOpen] = useState(false);
  const [dialogInitialData, setDialogInitialData] = useState<CustomModelFormData>({ id: '', label: '' });
  const [dialogMode, setDialogMode] = useState<'add' | 'edit'>('add');
  const [editingModelId, setEditingModelId] = useState<string | null>(null);

  // Load custom models from localStorage on component mount
  useEffect(() => {
    if (isLocalMode()) {
      setCustomModels(getCustomModels());
    }
  }, []);

  // Save custom models to localStorage whenever they change
  useEffect(() => {
    if (isLocalMode() && customModels.length > 0) {
      localStorage.setItem(STORAGE_KEY_CUSTOM_MODELS, JSON.stringify(customModels));
    }
  }, [customModels]);

  // Enhance model options with capabilities - using a Map to ensure uniqueness
  const modelMap = new Map();

  // First add all standard models to the map
  modelOptions.forEach(model => {
    modelMap.set(model.id, {
      ...model,
      isCustom: false
    });
  });

  // Then add custom models from the current customModels state (not from props)
  // This ensures we're using the most up-to-date list of custom models
  if (isLocalMode()) {
    // Get current custom models from state (not from storage)
    customModels.forEach(model => {
      // Only add if it doesn't exist or mark it as a custom model if it does
      if (!modelMap.has(model.id)) {
        modelMap.set(model.id, {
          id: model.id,
          label: model.label || formatModelName(model.id),
          requiresSubscription: false,
          top: false,
          isCustom: true
        });
      } else {
        // If it already exists (rare case), mark it as a custom model
        const existingModel = modelMap.get(model.id);
        modelMap.set(model.id, {
          ...existingModel,
          isCustom: true
        });
      }
    });
  }

  // Convert map back to array
  const enhancedModelOptions = Array.from(modelMap.values());

  // Filter models based on search query
  const filteredOptions = enhancedModelOptions.filter((opt) =>
    opt.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
    opt.id.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Get free models from modelOptions (helper function)
  const getFreeModels = () => modelOptions.filter(m => !m.requiresSubscription).map(m => m.id);

  // No sorting needed - models are already sorted in the hook
  const sortedModels = filteredOptions;

  // Simplified premium models function - just filter without sorting
  const getPremiumModels = () => {
    return modelOptions
      .filter(m => m.requiresSubscription)
      .map((m, index) => ({
        ...m,
        uniqueKey: getUniqueModelKey(m, index)
      }));
  }

  // Make sure model IDs are unique for rendering
  const getUniqueModelKey = (model: any, index: number): string => {
    return `model-${model.id}-${index}`;
  };

  // Map models to ensure unique IDs for React keys
  const uniqueModels = sortedModels.map((model, index) => ({
    ...model,
    uniqueKey: getUniqueModelKey(model, index)
  }));

  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 50);
    } else {
      setSearchQuery('');
      setHighlightedIndex(-1);
    }
  }, [isOpen]);

  const selectedLabel =
    enhancedModelOptions.find((o) => o.id === selectedModel)?.label || 'Select model';

  const handleSelect = (id: string) => {
    // Check if it's a custom model
    const isCustomModel = customModels.some(model => model.id === id);

    // Custom models are always accessible in local mode
    if (isCustomModel && isLocalMode()) {
      onModelChange(id);
      setIsOpen(false);
      return;
    }

    // Otherwise use the regular canAccessModel check
    if (canAccessModel(id)) {
      onModelChange(id);
      setIsOpen(false);
    } else {
      setLockedModel(id);
      setPaywallOpen(true);
    }
  };

  const handleUpgradeClick = () => {
    setBillingModalOpen(true);
  };

  const closeDialog = () => {
    setPaywallOpen(false);
    setLockedModel(null);
  };

  const handleSearchInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex((prev) =>
        prev < filteredOptions.length - 1 ? prev + 1 : 0
      );
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex((prev) =>
        prev > 0 ? prev - 1 : filteredOptions.length - 1
      );
    } else if (e.key === 'Enter' && highlightedIndex >= 0) {
      e.preventDefault();
      const selectedOption = filteredOptions[highlightedIndex];
      if (selectedOption) {
        handleSelect(selectedOption.id);
      }
    }
  };

  const premiumModels = sortedModels.filter(m => !getFreeModels().some(id => m.id.includes(id)));

  const shouldDisplayAll = (!isLocalMode() && subscriptionStatus === 'no_subscription') && premiumModels.length > 0;

  // Handle opening the custom model dialog
  const openAddCustomModelDialog = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    setDialogInitialData({ id: '', label: '' });
    setDialogMode('add');
    setIsCustomModelDialogOpen(true);
    setIsOpen(false); // Close dropdown when opening modal
  };

  // Handle opening the edit model dialog
  const openEditCustomModelDialog = (model: CustomModel, e?: React.MouseEvent) => {
    e?.stopPropagation();

    setDialogInitialData({ id: model.id, label: model.label });
    setEditingModelId(model.id); // Keep the original ID with prefix for reference
    setDialogMode('edit');
    setIsCustomModelDialogOpen(true);
    setIsOpen(false); // Close dropdown when opening modal
  };

  // Handle saving a custom model
  const handleSaveCustomModel = (formData: CustomModelFormData) => {
    // Get model ID without automatically adding prefix
    const modelId = formData.id.trim();

    // Generate display name based on model ID (remove prefix if present for display name)
    const displayId = modelId.startsWith('openrouter/') ? modelId.replace('openrouter/', '') : modelId;
    const modelLabel = formData.label.trim() || formatModelName(displayId);

    if (!modelId) return;

    // Check for duplicates - only for new models or if ID changed during edit
    const checkId = modelId;
    if (customModels.some(model =>
      model.id === checkId && (dialogMode === 'add' || model.id !== editingModelId))) {
      console.error('A model with this ID already exists');
      return;
    }

    // First close the dialog to prevent UI issues
    closeCustomModelDialog();

    // Create the new model object
    const newModel = { id: modelId, label: modelLabel };

    // Update models array (add new or update existing)
    const updatedModels = dialogMode === 'add'
      ? [...customModels, newModel]
      : customModels.map(model => model.id === editingModelId ? newModel : model);

    // Save to localStorage first
    try {
      localStorage.setItem(STORAGE_KEY_CUSTOM_MODELS, JSON.stringify(updatedModels));
    } catch (error) {
      console.error('Failed to save custom models to localStorage:', error);
    }

    // Update state with new models
    setCustomModels(updatedModels);

    // Refresh custom models in the parent hook if the function is available
    if (refreshCustomModels) {
      refreshCustomModels();
    }

    // Handle model selection changes
    if (dialogMode === 'add') {
      // Always select newly added models
      onModelChange(modelId);
      // Also save the selection to localStorage
      try {
        localStorage.setItem(STORAGE_KEY_MODEL, modelId);
      } catch (error) {
        console.warn('Failed to save selected model to localStorage:', error);
      }
    } else if (selectedModel === editingModelId) {
      // For edits, only update if the edited model was selected
      onModelChange(modelId);
      try {
        localStorage.setItem(STORAGE_KEY_MODEL, modelId);
      } catch (error) {
        console.warn('Failed to save selected model to localStorage:', error);
      }
    }

    // Force dropdown to close to ensure fresh data on next open
    setIsOpen(false);

    // Force a UI refresh by delaying the state update
    setTimeout(() => {
      setHighlightedIndex(-1);
    }, 0);
  };

  // Handle closing the custom model dialog
  const closeCustomModelDialog = () => {
    setIsCustomModelDialogOpen(false);
    setDialogInitialData({ id: '', label: '' });
    setEditingModelId(null);

    // Improved fix for pointer-events issue: ensure dialog closes properly
    document.body.classList.remove('overflow-hidden');
    const bodyStyle = document.body.style;
    setTimeout(() => {
      bodyStyle.pointerEvents = '';
      bodyStyle.removeProperty('pointer-events');
    }, 150);
  };

  // Handle deleting a custom model
  const handleDeleteCustomModel = (modelId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    e?.preventDefault();

    // Filter out the model to delete
    const updatedCustomModels = customModels.filter(model => model.id !== modelId);

    // Update localStorage first to ensure data consistency
    if (isLocalMode() && typeof window !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEY_CUSTOM_MODELS, JSON.stringify(updatedCustomModels));
      } catch (error) {
        console.error('Failed to update custom models in localStorage:', error);
      }
    }

    // Update state with the new list
    setCustomModels(updatedCustomModels);

    // Refresh custom models in the parent hook if the function is available
    if (refreshCustomModels) {
      refreshCustomModels();
    }

    // Check if we need to change the selected model
    if (selectedModel === modelId) {
      const defaultModel = isLocalMode() ? DEFAULT_PREMIUM_MODEL_ID : DEFAULT_FREE_MODEL_ID;
      onModelChange(defaultModel);
      try {
        localStorage.setItem(STORAGE_KEY_MODEL, defaultModel);
      } catch (error) {
        console.warn('Failed to update selected model in localStorage:', error);
      }
    }

    // Force dropdown to close
    setIsOpen(false);

    // Update the modelMap and recreate enhancedModelOptions on next render
    // This will force a complete refresh of the model list
    setTimeout(() => {
      // Force React to fully re-evaluate the component with fresh data
      setHighlightedIndex(-1);

      // Reopen dropdown with fresh data if it was open
      if (isOpen) {
        setIsOpen(false);
        setTimeout(() => setIsOpen(true), 50);
      }
    }, 10);
  };

  const renderModelOption = (opt: any, index: number) => {
    // More accurate check for custom models - use the actual customModels array
    // from both the opt.isCustom flag and by checking if it exists in customModels
    const isCustom = Boolean(opt.isCustom) ||
      (isLocalMode() && customModels.some(model => model.id === opt.id));

    const accessible = isCustom ? true : canAccessModel(opt.id);

    // Fix the highlighting logic to use the index parameter instead of searching in filteredOptions
    const isHighlighted = index === highlightedIndex;
    const isPremium = opt.requiresSubscription;
    const isLowQuality = MODELS[opt.id]?.lowQuality || false;
    const isRecommended = MODELS[opt.id]?.recommended || false;

    return (
      <TooltipProvider key={opt.uniqueKey || `model-${opt.id}-${index}`}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className='w-full'>
              <DropdownMenuItem
                className={cn(
                  "text-sm px-3 py-2 mx-2 my-0.5 flex items-center justify-between cursor-pointer",
                  isHighlighted && "bg-accent",
                  !accessible && "opacity-70"
                )}
                onClick={() => handleSelect(opt.id)}
                onMouseEnter={() => setHighlightedIndex(index)}
              >
                <div className="flex items-center">
                  <span className="font-medium">{opt.label}</span>
                </div>
                <div className="flex items-center gap-2">
                  {/* Show capabilities */}
                  {isLowQuality && (
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                  )}
                  {isRecommended && (
                    <span className="text-xs px-1.5 py-0.5 rounded-sm bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-300 font-medium">
                      Recommended
                    </span>
                  )}
                  {isPremium && !accessible && (
                    <Crown className="h-3.5 w-3.5 text-blue-500" />
                  )}
                  {/* Custom model actions */}
                  {isLocalMode() && isCustom && (
                    <>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          openEditCustomModelDialog(opt, e);
                        }}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <Edit className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteCustomModel(opt.id, e);
                        }}
                        className="text-muted-foreground hover:text-red-500"
                      >
                        <Trash className="h-3.5 w-3.5" />
                      </button>
                    </>
                  )}
                  {selectedModel === opt.id && (
                    <Check className="h-4 w-4 text-blue-500" />
                  )}
                </div>
              </DropdownMenuItem>
            </div>
          </TooltipTrigger>
          {!accessible ? (
            <TooltipContent side="left" className="text-xs max-w-xs">
              <p>Requires subscription to access premium model</p>
            </TooltipContent>
          ) : isLowQuality ? (
            <TooltipContent side="left" className="text-xs max-w-xs">
              <p>Not recommended for complex tasks</p>
            </TooltipContent>
          ) : isRecommended ? (
            <TooltipContent side="left" className="text-xs max-w-xs">
              <p>Recommended for optimal performance</p>
            </TooltipContent>
          ) : isCustom ? (
            <TooltipContent side="left" className="text-xs max-w-xs">
              <p>Custom model</p>
            </TooltipContent>
          ) : null}
        </Tooltip>
      </TooltipProvider>
    );
  };

  // Update filtered options when customModels or search query changes
  useEffect(() => {
    // Force reset of enhancedModelOptions whenever customModels change
    // The next render will regenerate enhancedModelOptions with the updated modelMap
    setHighlightedIndex(-1);
    setSearchQuery('');

    // Force React to fully re-evaluate the component rendering
    if (isOpen) {
      // If dropdown is open, briefly close and reopen to force refresh
      setIsOpen(false);
      setTimeout(() => setIsOpen(true), 10);
    }
  }, [customModels, modelOptions]); // Also depend on modelOptions to refresh when parent changes

  return (
    <div className="relative">
      <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 py-2 bg-transparent border-0 rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent/50 flex items-center gap-2"
                >
                  <div className="relative flex items-center justify-center">
                    <Cpu className="h-4 w-4" />
                    {MODELS[selectedModel]?.lowQuality && (
                      <AlertTriangle className="h-2.5 w-2.5 text-amber-500 absolute -top-1 -right-1" />
                    )}
                  </div>
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              <p>Choose a model</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <DropdownMenuContent
          align="end"
          className="w-72 p-0 overflow-hidden"
          sideOffset={4}
        >
          <div className="overflow-y-auto w-full scrollbar-hide relative">
            {/* Completely separate views for subscribers and non-subscribers */}
            {shouldDisplayAll ? (
              /* No Subscription View */
              <div>
                {/* Available Models Section - ONLY hardcoded free models */}
                <div className="px-3 py-3 text-xs font-medium text-muted-foreground">
                  Available Models
                </div>
                {/* Only show free models */}
                {uniqueModels
                  .filter(m =>
                    !m.requiresSubscription &&
                    (m.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
                      m.id.toLowerCase().includes(searchQuery.toLowerCase()))
                  )
                  .map((model, index) => (
                    <TooltipProvider key={model.uniqueKey || `model-${model.id}-${index}`}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div className='w-full'>
                            <DropdownMenuItem
                              className={cn(
                                "text-sm mx-2 my-0.5 px-3 py-2 flex items-center justify-between cursor-pointer",
                                selectedModel === model.id && "bg-accent"
                              )}
                              onClick={() => onModelChange(model.id)}
                              onMouseEnter={() => setHighlightedIndex(filteredOptions.indexOf(model))}
                            >
                              <div className="flex items-center">
                                <span className="font-medium">{model.label}</span>
                              </div>
                              <div className="flex items-center gap-2">
                                {/* Show capabilities */}
                                {(MODELS[model.id]?.lowQuality || false) && (
                                  <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                                )}
                                {(MODELS[model.id]?.recommended || false) && (
                                  <span className="text-xs px-1.5 py-0.5 rounded-sm bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-300 font-medium">
                                    Recommended
                                  </span>
                                )}
                                {selectedModel === model.id && (
                                  <Check className="h-4 w-4 text-blue-500" />
                                )}
                              </div>
                            </DropdownMenuItem>
                          </div>
                        </TooltipTrigger>
                        {MODELS[model.id]?.lowQuality && (
                          <TooltipContent side="left" className="text-xs max-w-xs">
                            <p>Basic model with limited capabilities</p>
                          </TooltipContent>
                        )}
                      </Tooltip>
                    </TooltipProvider>
                  ))
                }

                {/* Premium Models Section */}
                <div className="mt-4 border-t border-border pt-2">
                  <div className="px-3 py-1.5 text-xs font-medium text-blue-500 flex items-center">
                    <Crown className="h-3.5 w-3.5 mr-1.5" />
                    Premium Models
                  </div>

                  {/* Premium models container with paywall overlay */}
                  <div className="relative h-40 overflow-hidden px-2">
                    {getPremiumModels()
                      .filter(m =>
                        m.requiresSubscription &&
                        (m.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          m.id.toLowerCase().includes(searchQuery.toLowerCase()))
                      )
                      .slice(0, 3)
                      .map((model, index) => (
                        <TooltipProvider key={model.uniqueKey || `model-${model.id}-${index}`}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div className='w-full'>
                                <DropdownMenuItem
                                  className="text-sm px-3 py-2 flex items-center justify-between opacity-70 cursor-pointer pointer-events-none"
                                >
                                  <div className="flex items-center">
                                    <span className="font-medium">{model.label}</span>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    {/* Show capabilities */}
                                    {MODELS[model.id]?.recommended && (
                                      <span className="text-xs px-1.5 py-0.5 rounded-sm bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-300 font-medium whitespace-nowrap">
                                        Recommended
                                      </span>
                                    )}
                                    <Crown className="h-3.5 w-3.5 text-blue-500" />
                                  </div>
                                </DropdownMenuItem>
                              </div>
                            </TooltipTrigger>
                            <TooltipContent side="left" className="text-xs max-w-xs">
                              <p>Requires subscription to access premium model</p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ))
                    }

                    {/* Absolute positioned paywall overlay with gradient fade */}
                    <div className="absolute inset-0 bg-gradient-to-t from-background via-background/95 to-transparent flex items-end justify-center">
                      <div className="w-full p-3">
                        <div className="rounded-xl bg-gradient-to-br from-blue-50/80 to-blue-200/70 dark:from-blue-950/40 dark:to-blue-900/30 shadow-sm border border-blue-200/50 dark:border-blue-800/50 p-3">
                          <div className="flex flex-col space-y-2">
                            <div className="flex items-center">
                              <Crown className="h-4 w-4 text-blue-500 mr-2 flex-shrink-0" />
                              <div>
                                <p className="text-sm font-medium">Unlock all models + higher limits</p>
                              </div>
                            </div>
                            <Button
                              size="sm"
                              className="w-full h-8 font-medium"
                              onClick={handleUpgradeClick}
                            >
                              Upgrade now
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              /* Subscription or other status view */
              <div className='max-h-[320px] overflow-y-auto w-full'>
                <div className="px-3 py-3 flex justify-between items-center">
                  <span className="text-xs font-medium text-muted-foreground">All Models</span>
                  {isLocalMode() && (
                    <div className="flex items-center gap-1">
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Link
                              href="/settings/env-manager"
                              className="h-6 w-6 p-0 flex items-center justify-center"
                            >
                              <KeyRound className="h-3.5 w-3.5" />
                            </Link>
                          </TooltipTrigger>
                          <TooltipContent side="bottom" className="text-xs">
                          Local .Env Manager
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 w-6 p-0"
                            onClick={(e) => {
                              e.stopPropagation();
                              openAddCustomModelDialog(e);
                            }}
                          >
                            <Plus className="h-3.5 w-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" className="text-xs">
                          Add a custom model
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                    </div>
                  )}
                </div>
                {uniqueModels
                  .filter(m =>
                    m.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
                    m.id.toLowerCase().includes(searchQuery.toLowerCase())
                  )
                  .map((model, index) => renderModelOption(model, index))}

                {uniqueModels.length === 0 && (
                  <div className="text-sm text-center py-4 text-muted-foreground">
                    No models match your search
                  </div>
                )}
              </div>
            )}
          </div>
          {!shouldDisplayAll && <div className="px-3 py-2 border-t border-border">
            <div className="relative flex items-center">
              <Search className="absolute left-2.5 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <input
                ref={searchInputRef}
                type="text"
                placeholder="Search models..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleSearchInputKeyDown}
                className="w-full h-8 px-8 py-1 rounded-lg text-sm focus:outline-none bg-muted"
              />
            </div>
          </div>}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Custom Model Dialog - moved to separate component */}
      <CustomModelDialog
        isOpen={isCustomModelDialogOpen}
        onClose={closeCustomModelDialog}
        onSave={handleSaveCustomModel}
        initialData={dialogInitialData}
        mode={dialogMode}
      />

      {paywallOpen && (
        <PaywallDialog
          open={true}
          onDialogClose={closeDialog}
          title="Premium Model"
          description={
            lockedModel
              ? `Subscribe to access ${modelOptions.find(
                (m) => m.id === lockedModel
              )?.label}`
              : 'Subscribe to access premium models with enhanced capabilities'
          }
          ctaText="Subscribe Now"
          cancelText="Maybe Later"
        />
      )}
    </div>
  );
};