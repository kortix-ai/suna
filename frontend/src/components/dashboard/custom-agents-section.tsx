'use client';

import React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Ripple } from '../ui/ripple';
import { useKortixTeamTemplates, useInstallTemplate } from '@/hooks/react-query/secure-mcp/use-secure-mcp';
import { Skeleton } from '@/components/ui/skeleton';
import { useRouter } from 'next/navigation';
import { MarketplaceAgentPreviewDialog } from '@/components/agents/marketplace-agent-preview-dialog';
import { StreamlinedInstallDialog } from '@/components/agents/installation/streamlined-install-dialog';
import { toast } from 'sonner';
import { AgentCountLimitDialog } from '@/components/agents/agent-count-limit-dialog';
import type { MarketplaceTemplate } from '@/components/agents/installation/types';
import { AgentCountLimitError } from '@/lib/api';
import { UnifiedAgentCard } from '@/components/ui/unified-agent-card';
import type { BaseAgentData } from '@/components/ui/unified-agent-card';
import { ChevronRight, Code2, Calendar, MessageSquare, Briefcase, ShoppingCart, Users, Wrench, GraduationCap, Heart, Home, ScrollText, Calculator, FileText, Palette, User, DollarSign, Target, BookOpen, ChevronDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface CustomAgentsSectionProps {
  onAgentSelect?: (templateId: string) => void;
}

const TitleSection = () => (
  <div className="px-4 py-8">
    <div className="w-full max-w-5xl mx-auto flex flex-col items-center space-y-2">
      <div className="flex flex-col items-center text-center w-full">
        <p className="tracking-tight text-2xl md:text-3xl font-normal text-foreground/90">
          Workers & Workflows
        </p>
        <p className="text-sm text-muted-foreground mt-2">
          Configure and install AI workers from templates
        </p>
      </div>
    </div>
  </div>
);

const CATEGORY_CONFIG: Record<string, { icon: any; icon_color: string; tagline: string; color: string }> = {
  'Engineering': {
    icon: Code2,
    tagline: 'Less context-switching, more coding.',
    icon_color: 'text-blue-500 dark:text-blue-600',
    color: 'from-blue-500/20 to-purple-500/10'
  },
  'Office Suite': {
    icon: FileText,
    tagline: 'Create and edit documents, with extreme efficiency.',
    icon_color: 'text-green-500 dark:text-green-600',
    color: 'from-green-500/20 to-green-500/10'
  },
  'Design': {
    icon: Palette,
    tagline: 'Create and edit designs, like a pro.',
    icon_color: 'text-purple-500 dark:text-purple-600',
    color: 'from-purple-500/20 to-purple-500/10'
  },
  'Personal Help': {
    icon: User,
    tagline: 'A personal assistant, that never sleeps.',
    icon_color: 'text-amber-500 dark:text-amber-600',
    color: 'from-amber-500/20 to-amber-500/10'
  },
  'Product': {
    icon: Calculator,
    tagline: 'Manage everything about your product, till launch.',
    icon_color: 'text-indigo-500 dark:text-indigo-600',
    color: 'from-indigo-500/20 to-indigo-500/10'
  },
  'Utilities': {
    icon: Wrench,
    tagline: 'Tools to help you with your daily tasks.',
    icon_color: 'text-orange-500 dark:text-orange-600',
    color: 'from-orange-500/20 to-orange-500/10'
  },
  'Marketing': {
    icon: ShoppingCart,
    tagline: 'Create campaigns, analyze results, grow faster.',
    icon_color: 'text-pink-500 dark:text-pink-600',
    color: 'from-pink-500/20 to-rose-500/10'
  },
  'Human Resources': {
    icon: Users,
    tagline: 'Simplify hiring, onboarding, and team management.',
    icon_color: 'text-indigo-500 dark:text-indigo-600',
    color: 'from-indigo-500/20 to-violet-500/10'
  },
  'Finance': {
    icon: DollarSign,
    tagline: 'Manage your finances, with AI.',
    icon_color: 'text-green-500 dark:text-green-600',
    color: 'from-green-500/20 to-green-500/10'
  },
  'Document AI': {
    icon: ScrollText,
    tagline: 'Create and edit documents, using AI.',
    icon_color: 'text-violet-500 dark:text-violet-600',
    color: 'from-violet-500/20 to-violet-500/10'
  },
  'Sales': {
    icon: Target,
    tagline: 'Sell more, with AI.',
    icon_color: 'text-rose-500 dark:text-rose-600',
    color: 'from-rose-500/20 to-rose-500/10'
  },
  'Research': {
    icon: BookOpen,
    tagline: 'Research, with AI.',
    icon_color: 'text-blue-500 dark:text-blue-600',
    color: 'from-blue-500/20 to-blue-500/10'
  },
  'Other': {
    icon: Home,
    tagline: 'Specialized agents for unique needs.',
    icon_color: 'text-gray-500 dark:text-gray-600',
    color: 'from-gray-500/20 to-slate-500/10'
  }
};

interface FeaturedCategoryCardProps {
  category: string;
}

const FeaturedCategoryCard = ({ category }: FeaturedCategoryCardProps) => {
  const config = CATEGORY_CONFIG[category] || CATEGORY_CONFIG['Other'];
  const Icon = config.icon;

  return (
    <div className={cn(
      "relative overflow-hidden rounded-3xl p-8 h-38 col-span-1 sm:col-span-2",
      "bg-gradient-to-br",
      config.color,
      "border border-border/50",
      "backdrop-blur-xl"
    )}>
      <div className="absolute inset-0 bg-gradient-to-tr from-background/80 via-transparent to-background/40" />
      
      <div className="absolute right-0 top-0 w-48 h-48 opacity-30">
        <div className={cn(
          "absolute inset-0 bg-gradient-to-br",
          config.color,
          "blur-2xl"
        )} />
      </div>

      <div className="relative z-10">
        <h3 className="text-2xl font-medium text-foreground/90 mb-2">
          {config.tagline.split(',')[0]}
        </h3>
        <p className="text-2xl font-medium text-foreground/90">
          {config.tagline.split(',')[1]}
        </p>
      </div>
      
      <div className="absolute right-8 top-8">
        <div className="relative">
          <div className={cn(
            "absolute inset-0 blur-xl opacity-40",
            config.icon_color
          )}>
            <Icon className="w-32 h-32" strokeWidth={2} />
          </div>
          <Icon className={cn(
            "relative w-32 h-32 opacity-30",
            config.icon_color
          )} strokeWidth={2} />
        </div>
      </div>
    </div>
  );
};

interface CategorySectionProps {
  category: string;
  templates: any[];
  onCardClick: (template: any) => void;
  convertTemplateToAgentData: (template: any) => BaseAgentData;
  expandedCategories: Set<string>;
  onToggleExpand: (category: string) => void;
}

const CategorySection = ({ 
  category, 
  templates, 
  onCardClick, 
  convertTemplateToAgentData,
  expandedCategories,
  onToggleExpand
}: CategorySectionProps) => {
  const isExpanded = expandedCategories.has(category);
  const displayTemplates = isExpanded ? templates : templates.slice(0, 4);
  const hasMore = templates.length > 4;

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-medium text-muted-foreground">{category}</h2>
        {hasMore && (
          <Button
            variant="link"
            onClick={() => onToggleExpand(category)}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            {isExpanded ? 'Show less' : 'See all'}
            <ChevronRight className="ml-1 h-4 w-4" />
          </Button>
        )}
      </div>
      <div className="grid gap-4 pb-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3">
        <FeaturedCategoryCard category={category} />
        {displayTemplates.map((template) => (
          <UnifiedAgentCard
            key={template.template_id}
            variant="dashboard"
            data={convertTemplateToAgentData(template)}
            actions={{
              onClick: () => onCardClick(template)
            }}
          />
        ))}
      </div>
    </div>
  );
};

export function CustomAgentsSection({ onAgentSelect }: CustomAgentsSectionProps) {
  const router = useRouter();
  const { data: templates, isLoading, error } = useKortixTeamTemplates();
  const installTemplate = useInstallTemplate();

  const [selectedTemplate, setSelectedTemplate] = React.useState<MarketplaceTemplate | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = React.useState(false);
  const [showInstallDialog, setShowInstallDialog] = React.useState(false);
  const [showAgentLimitDialog, setShowAgentLimitDialog] = React.useState(false);
  const [agentLimitError, setAgentLimitError] = React.useState<any>(null);
  const [installingItemId, setInstallingItemId] = React.useState<string | null>(null);
  const [expandedCategories, setExpandedCategories] = React.useState<Set<string>>(new Set());
  const [selectedFilter, setSelectedFilter] = React.useState<string | null>(null);

  const toggleCategoryExpand = (category: string) => {
    setExpandedCategories(prev => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  };

  const groupTemplatesByCategory = React.useMemo(() => {
    if (!templates?.templates) return {};
    
    const categorized: Record<string, any[]> = {};
    const uncategorized: any[] = [];
    
    templates.templates.forEach((template) => {
      if (template.categories && template.categories.length > 0) {
        template.categories.forEach((category: string) => {
          if (!categorized[category]) {
            categorized[category] = [];
          }
          categorized[category].push(template);
        });
      } else {
        uncategorized.push(template);
      }
    });
    
    if (uncategorized.length > 0) {
      categorized['Other'] = uncategorized;
    }
    
    return categorized;
  }, [templates]);

  const handleCardClick = (template: any) => {
    const marketplaceTemplate: MarketplaceTemplate = {
      id: template.template_id,
      template_id: template.template_id,
      creator_id: template.creator_id,
      name: template.name,
      description: template.description,
      system_prompt: template.system_prompt,
      tags: template.tags || [],
      download_count: template.download_count || 0,
      is_kortix_team: template.is_kortix_team || false,
      creator_name: template.creator_name,
      created_at: template.created_at,
      icon_name: template.icon_name,
      icon_color: template.icon_color,
      icon_background: template.icon_background,
      mcp_requirements: template.mcp_requirements || [],
      agentpress_tools: template.agentpress_tools || {},
      model: template.metadata?.model,
      marketplace_published_at: template.marketplace_published_at,
      usage_examples: template.usage_examples,
      config: template.config,
    };

    setSelectedTemplate(marketplaceTemplate);
    setIsPreviewOpen(true);
  };

  const convertTemplateToAgentData = (template: any): BaseAgentData => ({
    id: template.template_id,
    name: template.name,
    description: template.description,
    tags: template.tags || [],
    created_at: template.created_at,
    icon_name: template.icon_name,
    icon_color: template.icon_color,
    icon_background: template.icon_background,
    creator_id: template.creator_id,
    creator_name: template.creator_name,
    is_kortix_team: template.is_kortix_team || false,
    download_count: template.download_count || 0,
    marketplace_published_at: template.marketplace_published_at,
    mcp_requirements: template.mcp_requirements || [],
    agentpress_tools: template.agentpress_tools || {},
  });

  const handlePreviewInstall = (agent: MarketplaceTemplate) => {
    setIsPreviewOpen(false);
    setSelectedTemplate(agent);
    setShowInstallDialog(true);
  };

  const handleInstall = async (
    item: MarketplaceTemplate, 
    instanceName: string, 
    profileMappings: Record<string, string>, 
    customServerConfigs: Record<string, any>,
    triggerConfigs?: Record<string, Record<string, any>>,
    triggerVariables?: Record<string, Record<string, string>>
  ) => {
    if (!item) return;

    setInstallingItemId(item.id);

    try {
      const result = await installTemplate.mutateAsync({
        template_id: item.id,
        instance_name: instanceName,
        profile_mappings: profileMappings,
        custom_mcp_configs: customServerConfigs,
        trigger_configs: triggerConfigs,
        trigger_variables: triggerVariables,
      });

      if (result.status === 'installed' && result.instance_id) {
        toast.success(`Agent "${instanceName}" installed successfully!`);
        setShowInstallDialog(false);
        
        if (onAgentSelect) {
          onAgentSelect(result.instance_id);
        }
      } else if (result.status === 'configs_required') {
        if (result.missing_trigger_variables && Object.keys(result.missing_trigger_variables).length > 0) {
          toast.warning('Please provide values for template trigger variables.');
          setInstallingItemId('');
          return;
        }
        toast.error('Please provide all required configurations');
        return;
      } else {
        toast.error('Unexpected response from server. Please try again.');
        return;
      }
    } catch (error: any) {
      console.error('Installation error:', error);

      if (error instanceof AgentCountLimitError) {
        setAgentLimitError(error.detail);
        setShowAgentLimitDialog(true);
        setShowInstallDialog(false);
        return;
      }

      if (error.message?.includes('already in your library')) {
        toast.error('This agent is already in your library');
      } else if (error.message?.includes('Credential profile not found')) {
        toast.error('One or more selected credential profiles could not be found. Please refresh and try again.');
      } else if (error.message?.includes('Missing credential profile')) {
        toast.error('Please select credential profiles for all required services');
      } else if (error.message?.includes('Invalid credential profile')) {
        toast.error('One or more selected credential profiles are invalid. Please select valid profiles.');
      } else if (error.message?.includes('inactive')) {
        toast.error('One or more selected credential profiles are inactive. Please select active profiles.');
      } else if (error.message?.includes('Template not found')) {
        toast.error('This agent template is no longer available');
      } else if (error.message?.includes('Access denied')) {
        toast.error('You do not have permission to install this agent');
      } else {
        toast.error(error.message || 'Failed to install agent. Please try again.');
      }
    } finally {
      setInstallingItemId(null);
    }
  };

  if (isLoading) {
    return (
      <div className="w-full">
        <TitleSection />
        <div className="grid gap-4 pb-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
            <div key={i} className="bg-muted/30 rounded-3xl p-4 h-auto w-full flex items-center">
              <Skeleton className="w-12 h-12 rounded-xl" />
              <Skeleton className="h-6 w-1/2 ml-4" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="w-full">
        <TitleSection />
        <div className="text-center py-8">
          <p className="text-muted-foreground">Failed to load custom agents</p>
        </div>
      </div>
    );
  }

  const categorizedTemplates = groupTemplatesByCategory;
  const hasCategories = Object.keys(categorizedTemplates).length > 0;
  const categories = Object.keys(categorizedTemplates);

  const filteredCategories = selectedFilter 
    ? { [selectedFilter]: categorizedTemplates[selectedFilter] }
    : categorizedTemplates;

  if (!templates || !templates.templates || templates.templates.length === 0) {
    return (
      <div className="w-full">
        <TitleSection />
        <div className="text-center py-8">
          <p className="text-muted-foreground">No custom agents available yet</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="w-full">
        <TitleSection />
        {hasCategories && (
          <div className="pb-12">
            <div className="w-full max-w-5xl mx-auto">
              <div className="flex items-center gap-2 pb-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedFilter(null)}
                  className={cn(
                    "flex-1 text-muted-foreground whitespace-nowrap",
                    selectedFilter === null && "bg-accent text-foreground"
                  )}
                >
                  All
                </Button>
                {categories.slice(0, 7).map((category) => {
                  const config = CATEGORY_CONFIG[category] || CATEGORY_CONFIG['Other'];
                  const Icon = config.icon;
                  return (
                    <Button
                      key={category}
                      variant="ghost"
                      size="sm"
                      onClick={() => setSelectedFilter(category)}
                      className={cn(
                        "flex-1 gap-2 text-muted-foreground whitespace-nowrap",
                        selectedFilter === category && "bg-accent text-foreground"
                      )}
                    >
                      <Icon className="h-4 w-4" />
                      {category}
                    </Button>
                  );
                })}
                {categories.length > 7 && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="flex-1 gap-1 text-muted-foreground whitespace-nowrap"
                      >
                        +{categories.length - 7} more
                        <ChevronDown className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                      {categories.slice(7).map((category) => {
                        const config = CATEGORY_CONFIG[category] || CATEGORY_CONFIG['Other'];
                        const Icon = config.icon;
                        return (
                          <DropdownMenuItem
                            key={category}
                            onClick={() => setSelectedFilter(category)}
                            className={cn(
                              "gap-2 cursor-pointer",
                              selectedFilter === category && "bg-accent"
                            )}
                          >
                            <Icon className="h-4 w-4" />
                            {category}
                          </DropdownMenuItem>
                        );
                      })}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            </div>
          </div>
        )}

        {hasCategories ? (
          Object.entries(filteredCategories).map(([category, categoryTemplates]) => (
            <CategorySection
              key={category}
              category={category}
              templates={categoryTemplates}
              onCardClick={handleCardClick}
              convertTemplateToAgentData={convertTemplateToAgentData}
              expandedCategories={expandedCategories}
              onToggleExpand={toggleCategoryExpand}
            />
          ))
        ) : (
          <div className="grid gap-4 pb-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {templates.templates.map((template) => (
              <UnifiedAgentCard
                key={template.template_id}
                variant="dashboard"
                data={convertTemplateToAgentData(template)}
                actions={{
                  onClick: () => handleCardClick(template)
                }}
              />
            ))}
          </div>
        )}
      </div>
      <MarketplaceAgentPreviewDialog
        agent={selectedTemplate}
        isOpen={isPreviewOpen}
        onClose={() => {
          setIsPreviewOpen(false);
          setSelectedTemplate(null);
        }}
        onInstall={handlePreviewInstall}
        isInstalling={installingItemId === selectedTemplate?.id}
      />

      {/* Streamlined Install Dialog */}
      <StreamlinedInstallDialog
        item={selectedTemplate}
        open={showInstallDialog}
        onOpenChange={setShowInstallDialog}
        onInstall={handleInstall}
        isInstalling={installingItemId === selectedTemplate?.id}
      />

      {/* Agent Limit Dialog */}
      {showAgentLimitDialog && agentLimitError && (
        <AgentCountLimitDialog
          open={showAgentLimitDialog}
          onOpenChange={setShowAgentLimitDialog}
          currentCount={agentLimitError.current_count}
          limit={agentLimitError.limit}
          tierName={agentLimitError.tier_name}
        />
      )}
    </>
  );
} 