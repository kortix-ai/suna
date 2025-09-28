import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2, FileJson, AlertCircle, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { ProfileConnector } from './installation/streamlined-profile-connector';
import { CustomServerStep } from './installation/custom-server-step';
import type { SetupStep } from './installation/types';
import { useAnalyzeJsonForImport, useImportAgentFromJson, type JsonAnalysisResult, type JsonImportResult } from '@/hooks/react-query/agents/use-json-import';
import { AgentCountLimitDialog } from './agent-count-limit-dialog';
import { AgentCountLimitError } from '@/lib/api';
import { cn } from '@/lib/utils';

interface JsonImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: (agentId: string) => void;
  initialJsonText?: string;
}

export const JsonImportDialog: React.FC<JsonImportDialogProps> = ({
  open,
  onOpenChange,
  onSuccess,
  initialJsonText
}) => {
  const [step, setStep] = useState<'paste' | 'setup' | 'importing'>('paste');
  const [jsonText, setJsonText] = useState('');
  const [instanceName, setInstanceName] = useState('');
  const [analysis, setAnalysis] = useState<JsonAnalysisResult | null>(null);
  const [setupSteps, setSetupSteps] = useState<SetupStep[]>([]);
  const [currentStep, setCurrentStep] = useState(0);
  const [profileMappings, setProfileMappings] = useState<Record<string, string>>({});
  const [customMcpConfigs, setCustomMcpConfigs] = useState<Record<string, Record<string, any>>>({});
  const [showAgentLimitDialog, setShowAgentLimitDialog] = useState(false);
  const [agentLimitError, setAgentLimitError] = useState<AgentCountLimitError | null>(null);

  const analyzeJsonMutation = useAnalyzeJsonForImport();
  const importJsonMutation = useImportAgentFromJson();

  const resetState = useCallback(() => {
    setStep('paste');
    setJsonText('');
    setInstanceName('');
    setAnalysis(null);
    setSetupSteps([]);
    setCurrentStep(0);
    setProfileMappings({});
    setCustomMcpConfigs({});
    setShowAgentLimitDialog(false);
    setAgentLimitError(null);
  }, []);

  useEffect(() => {
    if (!open) {
      resetState();
    } else if (initialJsonText) {
      setJsonText(initialJsonText);
    }
  }, [open, resetState, initialJsonText]);

    const analyzeJson = useCallback(() => {
    if (!jsonText.trim()) {
      toast.error('Please paste JSON content');
      return;
    }

    let parsedJson;
    try {
      parsedJson = JSON.parse(jsonText);
    } catch (error) {
      toast.error('Invalid JSON format');
      return;
    }

    analyzeJsonMutation.mutate(
      { json_data: parsedJson },
      {
        onSuccess: (result) => {
          setAnalysis(result);
          setInstanceName(result.agent_info?.name || 'Imported Agent');

          if (result.requires_setup) {
            const steps: SetupStep[] = [];
            
            result.missing_regular_credentials?.forEach(req => {
              if (req.qualified_name.startsWith('composio.')) {
                let app_slug = req.qualified_name;
                
                if (app_slug.startsWith('composio.')) {
                  app_slug = app_slug.substring('composio.'.length);
                } else if (app_slug.includes('composio_')) {
                  const parts = app_slug.split('composio_');
                  app_slug = parts[parts.length - 1];
                }
                
                const composioStep: SetupStep = {
                  id: req.qualified_name,
                  title: `Connect ${req.display_name}`,
                  description: `Select an existing ${req.display_name} profile or create a new one`,
                  type: 'composio_profile' as const,
                  service_name: req.display_name,
                  qualified_name: req.qualified_name,
                  app_slug: app_slug,
                  app_name: req.display_name
                };

                steps.push(composioStep);
              } else {
                const credentialStep: SetupStep = {
                  id: req.qualified_name,
                  title: `Connect ${req.display_name}`,
                  description: `Select an existing ${req.display_name} profile or create a new one`,
                  type: 'credential_profile' as const,
                  service_name: req.display_name,
                  qualified_name: req.qualified_name
                };
                steps.push(credentialStep);
              }
            });
            result.missing_custom_configs?.forEach(req => {
              if (req.custom_type === 'composio') {
                let app_slug = req.qualified_name;
                
                if (app_slug.startsWith('composio.')) {
                  app_slug = app_slug.substring('composio.'.length);
                } else if (app_slug.includes('composio_')) {
                  const parts = app_slug.split('composio_');
                  app_slug = parts[parts.length - 1];
                }
                
                const composioStep: SetupStep = {
                  id: req.qualified_name,
                  title: `Connect ${req.display_name}`,
                  description: `Select an existing ${req.display_name} profile or create a new one`,
                  type: 'composio_profile' as const,
                  service_name: req.display_name,
                  qualified_name: req.qualified_name,
                  app_slug: app_slug,
                  app_name: req.display_name
                };

                steps.push(composioStep);
              } else {
                const customStep: SetupStep = {
                  id: req.qualified_name,
                  title: `Configure ${req.display_name}`,
                  description: `Provide configuration for ${req.display_name}`,
                  type: 'custom_server' as const,
                  service_name: req.display_name,
                  qualified_name: req.qualified_name
                };
                steps.push(customStep);
              }
            });

            setSetupSteps(steps);
            setCurrentStep(0);
            setStep('setup');
          } else {
            const parsedJsonForImport = JSON.parse(jsonText);
            importJsonMutation.mutate(
              {
                json_data: parsedJsonForImport,
                instance_name: instanceName,
                profile_mappings: profileMappings,
                custom_mcp_configs: customMcpConfigs
              },
              {
                onSuccess: (result) => {
                  if (result?.status === 'success' && result.instance_id) {
                    if (onSuccess) {
                      onSuccess(result.instance_id);
                    }
                    onOpenChange(false);
                  }
                }
              }
            );
          }
        }
      }
    );
  }, [jsonText, instanceName, profileMappings, customMcpConfigs, onSuccess, onOpenChange]); // Remove mutation from dependencies

  const handleProfileSelect = useCallback((qualifiedName: string, profileId: string) => {
    setProfileMappings(prev => ({
      ...prev,
      [qualifiedName]: profileId
    }));
  }, []);

  const handleCustomConfigUpdate = useCallback((qualifiedName: string, config: Record<string, any>) => {
    setCustomMcpConfigs(prev => ({
      ...prev,
      [qualifiedName]: config
    }));
  }, []);

  const performImport = useCallback(() => {
    if (!analysis) return;

    const parsedJson = JSON.parse(jsonText);
    
    importJsonMutation.mutate(
      {
        json_data: parsedJson,
        instance_name: instanceName,
        profile_mappings: profileMappings,
        custom_mcp_configs: customMcpConfigs
      },
      {
        onSuccess: (result) => {
          if (result?.status === 'success' && result.instance_id) {
            if (onSuccess) {
              onSuccess(result.instance_id);
            }
            onOpenChange(false);
          }
        },
        onError: (error) => {
          if (error instanceof AgentCountLimitError) {
            setAgentLimitError(error);
            setShowAgentLimitDialog(true);
            onOpenChange(false);
          }
        }
      }
    );
  }, [analysis, jsonText, instanceName, profileMappings, customMcpConfigs, onSuccess, onOpenChange]); // Remove mutation from dependencies

  const currentStepData = useMemo(() => setupSteps[currentStep], [setupSteps, currentStep]);
  
  const canProceedToNextStep = useMemo(() => currentStepData && (
    profileMappings[currentStepData.qualified_name] || 
    customMcpConfigs[currentStepData.qualified_name]
  ), [currentStepData, profileMappings, customMcpConfigs]);

  const canCompleteSetup = useMemo(() => setupSteps.every(step => 
    profileMappings[step.qualified_name] || customMcpConfigs[step.qualified_name]
  ), [setupSteps, profileMappings, customMcpConfigs]);

  const handleStepComplete = useCallback(() => {
    if (currentStep < setupSteps.length - 1) {
      setTimeout(() => setCurrentStep(currentStep + 1), 500);
    }
  }, [currentStep, setupSteps.length]);

  const renderPasteStep = () => (
    <div className="space-y-6 min-w-0">
      <div className="space-y-2">
        <Label htmlFor="json-content">Agent JSON</Label>
        <Textarea
          id="json-content"
          placeholder="Paste your exported agent JSON here..."
          value={jsonText}
          onChange={(e) => setJsonText(e.target.value)}
          className="min-h-[300px] max-h-[300px] font-mono text-sm"
        />
      </div>
      <div className="flex justify-end space-x-2">
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button onClick={analyzeJson} disabled={analyzeJsonMutation.isPending || !jsonText.trim()}>
          {analyzeJsonMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          {analyzeJsonMutation.isPending ? 'Analyzing...' : 'Next'}
        </Button>
      </div>
    </div>
  );

  const renderSetupStep = () => {
    if (!analysis || !currentStepData) return null;

    return (
      <div className="space-y-6">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="h-4 w-4 rounded-full bg-primary text-primary-foreground text-sm font-semibold flex items-center justify-center">
              {currentStep + 1}
            </div>
            <h3 className="font-semibold">{currentStepData.title}</h3>
          </div>
          <p className="text-sm text-muted-foreground">
            {currentStepData.description}
          </p>
        </div>

        <div>
          {(currentStepData.type === 'credential_profile' || currentStepData.type === 'composio_profile') && (
            <ProfileConnector
              step={currentStepData}
              selectedProfileId={profileMappings[currentStepData.qualified_name]}
              onProfileSelect={handleProfileSelect}
              onComplete={handleStepComplete}
            />
          )}
          
          {currentStepData.type === 'custom_server' && (
            <CustomServerStep
              step={currentStepData}
              config={customMcpConfigs[currentStepData.qualified_name] || {}}
              onConfigUpdate={handleCustomConfigUpdate}
            />
          )}
        </div>

        {setupSteps.length > 1 && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              {setupSteps.map((_, index) => (
                <div
                  key={index}
                  className={cn(
                    "h-1 flex-1 rounded-full transition-colors",
                    index <= currentStep ? 'bg-primary' : 'bg-muted'
                  )}
                />
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Step {currentStep + 1} of {setupSteps.length}
            </p>
          </div>
        )}

        <div className="flex gap-3 pt-6 border-t">
          {currentStep > 0 ? (
            <Button variant="outline" onClick={() => setCurrentStep(currentStep - 1)} className="flex-1">
              Back
            </Button>
          ) : (
            <Button variant="outline" onClick={() => setStep('paste')} className="flex-1">
              Back to JSON
            </Button>
          )}
          
          {currentStep === setupSteps.length - 1 ? (
            <Button 
              onClick={performImport}
              disabled={!canCompleteSetup || importJsonMutation.isPending}
              className="flex-1"
            >
              {importJsonMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Importing...
                </>
              ) : (
                <>
                  <FileJson className="h-4 w-4" />
                  Import Agent
                </>
              )}
            </Button>
          ) : (
            <Button 
              onClick={() => setCurrentStep(currentStep + 1)}
              disabled={!canProceedToNextStep}
              className="flex-1"
            >
              Next
            </Button>
          )}
        </div>
      </div>
    );
  };

  const renderImportingStep = () => (
    <div className="flex flex-col items-center justify-center py-12 space-y-4">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
      <div className="text-center">
        <h3 className="font-semibold">Importing Agent</h3>
        <p className="text-sm text-muted-foreground">
          Creating your agent with the configured credentials...
        </p>
      </div>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileJson className="h-5 w-5" />
            Import Agent from JSON
          </DialogTitle>
        </DialogHeader>
        {analysis && !analysis.requires_setup && step === 'paste' && (
          <Alert>
            <CheckCircle2 className="h-4 w-4" />
            <AlertDescription>
              No additional setup required. This agent can be imported directly.
            </AlertDescription>
          </Alert>
        )}
        {analysis && analysis.requires_setup && step === 'paste' && (
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              This agent requires credential setup for{' '}
              {(analysis.missing_regular_credentials?.length || 0) + 
               (analysis.missing_custom_configs?.length || 0)} integrations.
            </AlertDescription>
          </Alert>
        )}
        {analyzeJsonMutation.isError && step === 'paste' && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Failed to analyze JSON. Please check the format and try again.
            </AlertDescription>
          </Alert>
        )}
        {importJsonMutation.isError && (step === 'setup' || step === 'importing') && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Failed to import agent. Please try again or check your credential configurations.
            </AlertDescription>
          </Alert>
        )}
        {step === 'paste' && renderPasteStep()}
        {step === 'setup' && renderSetupStep()}
        {step === 'importing' && renderImportingStep()}
      </DialogContent>
      {agentLimitError && (
        <AgentCountLimitDialog
          open={showAgentLimitDialog}
          onOpenChange={setShowAgentLimitDialog}
          currentCount={agentLimitError.detail.current_count}
          limit={agentLimitError.detail.limit}
          tierName={agentLimitError.detail.tier_name}
        />
      )}
    </Dialog>
  );
}; 