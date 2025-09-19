import React from 'react';
import { Settings, Wrench, Server, BookOpen, Workflow, Zap, ChevronDown, Brain } from 'lucide-react';
import { ExpandableMarkdownEditor } from '@/components/ui/expandable-markdown-editor';
import { AgentToolsConfiguration } from '../agent-tools-configuration';
import { AgentMCPConfiguration } from '../agent-mcp-configuration';
import { AgentKnowledgeBaseManager } from '../knowledge-base/agent-knowledge-base-manager';
import { AgentPlaybooksConfiguration } from '../playbooks/agent-playbooks-configuration';
import { AgentTriggersConfiguration } from '../triggers/agent-triggers-configuration';
import { AgentModelSelector } from './model-selector';
import { toast } from 'sonner';
import { KortixLogo } from '../../sidebar/kortix-logo';

interface ConfigurationTabProps {
  agentId: string;
  displayData: {
    name: string;
    description: string;
    system_prompt: string;
    model?: string;
    agentpress_tools: any;
    configured_mcps: any[];
    custom_mcps: any[];
    is_default: boolean;
  };
  versionData?: {
    version_id: string;
    configured_mcps: any[];
    custom_mcps: any[];
    system_prompt: string;
    model?: string;
    agentpress_tools: any;
  };
  isViewingOldVersion: boolean;
  onFieldChange: (field: string, value: any) => void;
  onMCPChange: (updates: { configured_mcps: any[]; custom_mcps: any[] }) => void;
  onSystemPromptSave?: (value: string) => void;
  onModelSave?: (model: string) => void;  // Add model save handler
  onToolsSave?: (tools: Record<string, boolean | { enabled: boolean; description: string }>) => void;
  initialAccordion?: string;
  agentMetadata?: {
    is_suna_default?: boolean;
    centrally_managed?: boolean;
    restrictions?: {
      system_prompt_editable?: boolean;
      tools_editable?: boolean;
      name_editable?: boolean;
      description_editable?: boolean;
      mcps_editable?: boolean;
    };
  };
  isLoading?: boolean;
}

export function ConfigurationTab({
  agentId,
  displayData,
  versionData,
  isViewingOldVersion,
  onFieldChange,
  onMCPChange,
  onSystemPromptSave,
  onModelSave,
  onToolsSave,
  initialAccordion,
  agentMetadata,
  isLoading = false,
}: ConfigurationTabProps) {
  
  const isSunaAgent = agentMetadata?.is_suna_default || false;

  const mapAccordion = (val?: string) => {
    if (val === 'instructions') return isSunaAgent ? 'integrations' : 'system';
    if (val === 'workflows') return 'playbooks';
    if (isSunaAgent && (val === 'system' || val === 'tools')) {
      return 'integrations';
    }
    if (['system', 'tools', 'integrations', 'knowledge', 'playbooks', 'triggers'].includes(val || '')) {
      return val!;
    }
    return isSunaAgent ? 'integrations' : 'system';
  };

  const [openAccordion, setOpenAccordion] = React.useState<string>(mapAccordion(initialAccordion));
  React.useEffect(() => {
    if (initialAccordion) {
      setOpenAccordion(mapAccordion(initialAccordion));
    }
  }, [initialAccordion]);
  const restrictions = agentMetadata?.restrictions || {};

  const isSystemPromptEditable = !isViewingOldVersion && (restrictions.system_prompt_editable !== false);
  const areToolsEditable = !isViewingOldVersion && (restrictions.tools_editable !== false);

  const handleSystemPromptChange = (value: string) => {
    if (!isSystemPromptEditable && isSunaAgent) {
      toast.error("System prompt cannot be edited", {
        description: "Suna's system prompt is managed centrally and cannot be changed.",
      });
      return;
    }
    if (onSystemPromptSave) {
      onSystemPromptSave(value);
    } else {
      onFieldChange('system_prompt', value);
    }
  };

  const handleToolsChange = (tools: Record<string, boolean | { enabled: boolean; description: string }>) => {
    if (!areToolsEditable && isSunaAgent) {
      toast.error("Tools cannot be modified", {
        description: "Suna's default tools are managed centrally and cannot be changed.",
      });
      return;
    }
    
    if (onToolsSave) {
      onToolsSave(tools);
    } else {
      onFieldChange('agentpress_tools', tools);
    }
  };

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-y-auto">
        <div className="px-8 py-0 space-y-3">
          {isSunaAgent && (
            <div className="p-4 bg-primary/10 border border-primary-200 rounded-xl">
              <div className="flex items-center gap-3 mb-2">
                <div className="text-primary-600">
                  <KortixLogo size={20} />
                </div>
                <span className="font-semibold text-primary-800">Suna Default Agent</span>
              </div>
              <p className="text-sm text-primary-700">
                This is Suna's default agent with centrally managed system prompt and tools.
                You can customize integrations, knowledge base, playbooks, and triggers to personalize your experience.
              </p>
            </div>
          )}

          <div className="space-y-3">
            {!isSunaAgent && (
              <>
                <div className="group overflow-hidden rounded-2xl border border-border bg-card transition-all duration-300 hover:border-primary/10" data-tour="model-section">
                  <button
                    className="w-full p-4 text-left group-hover:bg-muted/30 transition-all duration-300"
                    onClick={() => setOpenAccordion(openAccordion === 'model' ? '' : 'model')}
                    disabled={isLoading}
                  >
                    <div className="flex items-center gap-4 w-full">
                      <div className="relative flex-shrink-0">
                        <div className="bg-muted rounded-xl h-10 w-10 flex items-center justify-center transition-all duration-300 group-hover:scale-105">
                          <Brain className="h-5 w-5 text-muted-foreground" />
                        </div>
                      </div>
                      <div className="text-left flex-1 min-w-0">
                        <h4 className="text-sm font-semibold text-foreground mb-1 group-hover:text-primary transition-colors duration-300">Model Configuration</h4>
                        <p className="text-xs text-muted-foreground group-hover:text-foreground/70 transition-colors duration-300">Choose the AI model for your agent</p>
                      </div>
                      <ChevronDown className={`h-4 w-4 flex-shrink-0 transition-transform duration-300 ease-out ${openAccordion === 'model' ? 'rotate-180' : ''}`} />
                    </div>
                  </button>
                  {openAccordion === 'model' && (
                    <div className="border-t border-border bg-muted/10">
                      <div className="p-4">
                        <AgentModelSelector
                          value={displayData.model}
                          onChange={(model) => {
                            if (onModelSave) {
                              onModelSave(model);
                            } else {
                              onFieldChange('model', model);
                            }
                          }}
                          disabled={isViewingOldVersion || isLoading}
                        />
                      </div>
                    </div>
                  )}
                </div>
                <div className="group overflow-hidden rounded-2xl border border-border bg-card transition-all duration-300 hover:border-primary/10" data-tour="system-prompt">
                  <button
                    className="w-full p-4 text-left group-hover:bg-muted/30 transition-all duration-300"
                    onClick={() => setOpenAccordion(openAccordion === 'system' ? '' : 'system')}
                    disabled={isLoading}
                  >
                    <div className="flex items-center gap-4 w-full">
                      <div className="relative flex-shrink-0">
                        <div className="bg-muted rounded-xl h-10 w-10 flex items-center justify-center transition-all duration-300 group-hover:scale-105">
                          <Settings className="h-5 w-5 text-muted-foreground" />
                        </div>
                      </div>
                      <div className="text-left flex-1 min-w-0">
                        <h4 className="text-sm font-semibold text-foreground mb-1 group-hover:text-primary transition-colors duration-300">System Prompt</h4>
                        <p className="text-xs text-muted-foreground group-hover:text-foreground/70 transition-colors duration-300">Define agent behavior and goals</p>
                      </div>
                      <ChevronDown className={`h-4 w-4 flex-shrink-0 transition-transform duration-300 ease-out ${openAccordion === 'system' ? 'rotate-180' : ''}`} />
                    </div>
                  </button>
                  {openAccordion === 'system' && (
                    <div className="border-t border-border bg-muted/10">
                      <div className="p-4">
                        <ExpandableMarkdownEditor
                          value={displayData.system_prompt}
                          onSave={handleSystemPromptChange}
                          placeholder="Click to set system instructions..."
                          title="System Instructions"
                          disabled={!isSystemPromptEditable || isLoading}
                        />
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}

            <div className="group overflow-hidden rounded-2xl border border-border bg-card transition-all duration-300 hover:border-primary/10" data-tour="tools-section">
              <button
                className="w-full p-4 text-left group-hover:bg-muted/30 transition-all duration-300"
                onClick={() => setOpenAccordion(openAccordion === 'tools' ? '' : 'tools')}
                disabled={isLoading}
              >
                <div className="flex items-center gap-4 w-full">
                  <div className="relative flex-shrink-0">
                    <div className="bg-muted rounded-xl h-10 w-10 flex items-center justify-center transition-all duration-300 group-hover:scale-105">
                      <Wrench className="h-5 w-5 text-muted-foreground" />
                    </div>
                  </div>
                  <div className="text-left flex-1 min-w-0">
                    <h4 className="text-sm font-semibold text-foreground mb-1 group-hover:text-primary transition-colors duration-300">Tools</h4>
                    <p className="text-xs text-muted-foreground group-hover:text-foreground/70 transition-colors duration-300">Configure agent capabilities</p>
                  </div>
                  <ChevronDown className={`h-4 w-4 flex-shrink-0 transition-transform duration-300 ease-out ${openAccordion === 'tools' ? 'rotate-180' : ''}`} />
                </div>
              </button>
              {openAccordion === 'tools' && (
                <div className="border-t border-border bg-muted/10">
                  <div className="p-4">
                                         <AgentToolsConfiguration
                       tools={displayData.agentpress_tools}
                       onToolsChange={areToolsEditable ? handleToolsChange : () => { }}
                       disabled={!areToolsEditable}
                       isSunaAgent={isSunaAgent}
                       isLoading={isLoading}
                     />
                  </div>
                </div>
              )}
            </div>

            <div className="group overflow-hidden rounded-2xl border border-border bg-card transition-all duration-300 hover:border-primary/10" data-tour="integrations-section">
              <button
                className="w-full p-4 text-left group-hover:bg-muted/30 transition-all duration-300"
                onClick={() => setOpenAccordion(openAccordion === 'integrations' ? '' : 'integrations')}
                disabled={isLoading}
              >
                <div className="flex items-center gap-4 w-full">
                  <div className="relative flex-shrink-0">
                    <div className="bg-muted rounded-xl h-10 w-10 flex items-center justify-center transition-all duration-300 group-hover:scale-105">
                      <Server className="h-5 w-5 text-muted-foreground" />
                    </div>
                  </div>
                  <div className="text-left flex-1 min-w-0">
                    <h4 className="text-sm font-semibold text-foreground mb-1 group-hover:text-primary transition-colors duration-300">Integrations</h4>
                    <p className="text-xs text-muted-foreground group-hover:text-foreground/70 transition-colors duration-300">Connect external services</p>
                  </div>
                  <ChevronDown className={`h-4 w-4 flex-shrink-0 transition-transform duration-300 ease-out ${openAccordion === 'integrations' ? 'rotate-180' : ''}`} />
                </div>
              </button>
              {openAccordion === 'integrations' && (
                <div className="border-t border-border bg-muted/10">
                  <div className="p-4">
                    <AgentMCPConfiguration
                       configuredMCPs={displayData.configured_mcps}
                       customMCPs={displayData.custom_mcps}
                       onMCPChange={onMCPChange}
                       agentId={agentId}
                       versionData={{
                         configured_mcps: displayData.configured_mcps,
                         custom_mcps: displayData.custom_mcps,
                         system_prompt: displayData.system_prompt,
                         agentpress_tools: displayData.agentpress_tools
                       }}
                       saveMode="callback"
                       versionId={versionData?.version_id}
                       isLoading={isLoading}
                     />
                  </div>
                </div>
              )}
            </div>
            
            <div className="group overflow-hidden rounded-2xl border border-border bg-card transition-all duration-300 hover:border-primary/10" data-tour="knowledge-section">
              <button
                className="w-full p-4 text-left group-hover:bg-muted/30 transition-all duration-300"
                onClick={() => setOpenAccordion(openAccordion === 'knowledge' ? '' : 'knowledge')}
                disabled={isLoading}
              >
                <div className="flex items-center gap-4 w-full">
                  <div className="relative flex-shrink-0">
                    <div className="bg-muted rounded-xl h-10 w-10 flex items-center justify-center transition-all duration-300 group-hover:scale-105">
                      <BookOpen className="h-5 w-5 text-muted-foreground" />
                    </div>
                  </div>
                  <div className="text-left flex-1 min-w-0">
                    <h4 className="text-sm font-semibold text-foreground mb-1 group-hover:text-primary transition-colors duration-300">Knowledge Base</h4>
                    <p className="text-xs text-muted-foreground group-hover:text-foreground/70 transition-colors duration-300">Upload and manage knowledge for the agent</p>
                  </div>
                  <ChevronDown className={`h-4 w-4 flex-shrink-0 transition-transform duration-300 ease-out ${openAccordion === 'knowledge' ? 'rotate-180' : ''}`} />
                </div>
              </button>
              <div
                className={`transition-all duration-300 ease-out ${openAccordion === 'knowledge'
                  ? 'max-h-[600px] opacity-100'
                  : 'max-h-0 opacity-0'
                  }`}
              >
                <div className="px-6 pb-6 pt-2 overflow-y-auto max-h-[600px]">
                  <div className="pt-4">
                    <AgentKnowledgeBaseManager
                      agentId={agentId}
                      agentName={displayData.name || 'Agent'}
                    />
                  </div>
                </div>
              </div>
            </div>
            
            <div className="group overflow-hidden rounded-2xl border border-border bg-card transition-all duration-300 hover:border-primary/10" data-tour="playbooks-section">
              <button
                className="w-full p-4 text-left group-hover:bg-muted/30 transition-all duration-300"
                onClick={() => setOpenAccordion(openAccordion === 'playbooks' ? '' : 'playbooks')}
                disabled={isLoading}
              >
                <div className="flex items-center gap-4 w-full">
                  <div className="relative flex-shrink-0">
                    <div className="bg-muted rounded-xl h-10 w-10 flex items-center justify-center transition-all duration-300 group-hover:scale-105">
                      <Workflow className="h-5 w-5 text-muted-foreground" />
                    </div>
                  </div>
                  <div className="text-left flex-1 min-w-0">
                    <h4 className="text-sm font-semibold text-foreground mb-1 group-hover:text-primary transition-colors duration-300">Playbooks</h4>
                    <p className="text-xs text-muted-foreground group-hover:text-foreground/70 transition-colors duration-300">Simple variable-driven runs</p>
                  </div>
                  <ChevronDown className={`h-4 w-4 flex-shrink-0 transition-transform duration-300 ease-out ${openAccordion === 'playbooks' ? 'rotate-180' : ''}`} />
                </div>
              </button>
              <div
                className={`overflow-hidden transition-all duration-300 ease-out ${openAccordion === 'playbooks'
                  ? 'max-h-[600px] opacity-100'
                  : 'max-h-0 opacity-0'
                  }`}
              >
                <div className="px-6 pb-6 pt-2">
                  <div className="pt-4">
                    <AgentPlaybooksConfiguration
                      agentId={agentId}
                      agentName={displayData.name || 'Agent'}
                    />
                  </div>
                </div>
              </div>
            </div>
            {/* <div className="group overflow-hidden rounded-2xl border border-border bg-card transition-all duration-300 hover:border-primary/10" data-tour="triggers-section">
              <button
                className="w-full p-4 text-left group-hover:bg-muted/30 transition-all duration-300"
                onClick={() => setOpenAccordion(openAccordion === 'triggers' ? '' : 'triggers')}
                disabled={isLoading}
              >
                <div className="flex items-center gap-4 w-full">
                  <div className="relative flex-shrink-0">
                    <div className="bg-muted rounded-xl h-10 w-10 flex items-center justify-center transition-all duration-300 group-hover:scale-105">
                      <Zap className="h-5 w-5 text-muted-foreground" />
                    </div>
                  </div>
                  <div className="text-left flex-1 min-w-0">
                    <h4 className="text-sm font-semibold text-foreground mb-1 group-hover:text-primary transition-colors duration-300">Triggers</h4>
                    <p className="text-xs text-muted-foreground group-hover:text-foreground/70 transition-colors duration-300">Set up automated agent runs</p>
                  </div>
                  <ChevronDown className={`h-4 w-4 flex-shrink-0 transition-transform duration-300 ease-out ${openAccordion === 'triggers' ? 'rotate-180' : ''}`} />
                </div>
              </button>
              <div
                className={`overflow-hidden transition-all duration-300 ease-out ${openAccordion === 'triggers'
                  ? 'max-h-[600px] opacity-100'
                  : 'max-h-0 opacity-0'
                  }`}
              >
                <div className="px-6 pb-6 pt-2">
                  <div className="pt-4">
                    <AgentTriggersConfiguration agentId={agentId} />
                  </div>
                </div>
              </div>
            </div> */}
          </div>
        </div>
      </div>
    </div>
  );
}