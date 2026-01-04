import React from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Info } from 'lucide-react';

export interface TriggerVariable {
  trigger_name: string;
  trigger_index: number;
  variables: string[];
  agent_prompt: string;
  missing_variables?: string[];
}

interface TriggerVariablesStepProps {
  triggerVariables: Record<string, TriggerVariable>;
  values: Record<string, Record<string, string>>;
  onValuesChange: (triggerKey: string, variables: Record<string, string>) => void;
}

export const TriggerVariablesStep: React.FC<TriggerVariablesStepProps> = ({
  triggerVariables,
  values,
  onValuesChange,
}) => {
  const handleVariableChange = (triggerKey: string, varName: string, value: string) => {
    const currentValues = values[triggerKey] || {};
    onValuesChange(triggerKey, {
      ...currentValues,
      [varName]: value
    });
  };

  const getVariableValue = (triggerKey: string, varName: string): string => {
    return values[triggerKey]?.[varName] || '';
  };

  const formatVariableName = (varName: string): string => {
    return varName.replace(/_/g, ' ')
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  };

  const getVariablePlaceholder = (varName: string): string => {
    const lowerName = varName.toLowerCase();
    if (lowerName.includes('name') || lowerName.includes('brand')) {
      return 'e.g., Acme Corporation';
    }
    if (lowerName.includes('email')) {
      return 'e.g., contact@example.com';
    }
    if (lowerName.includes('url') || lowerName.includes('website')) {
      return 'e.g., https://example.com';
    }
    if (lowerName.includes('key') || lowerName.includes('token')) {
      return 'Enter your API key or token';
    }
    return `Enter ${formatVariableName(varName)}`;
  };

  const showPreview = (triggerKey: string, triggerData: TriggerVariable): string => {
    let preview = triggerData.agent_prompt;
    const triggerValues = values[triggerKey] || {};
    
    triggerData.variables.forEach(varName => {
      const value = triggerValues[varName];
      if (value) {
        const pattern = new RegExp(`\\{\\{${varName}\\}\\}`, 'g');
        preview = preview.replace(pattern, value);
      }
    });
    
    return preview;
  };

  const triggers = Object.entries(triggerVariables);

  if (triggers.length === 0) {
    return (
      <Alert>
        <Info className="h-4 w-4" />
        <AlertDescription>
          No trigger variables require configuration.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      {triggers.map(([triggerKey, triggerData]) => {
        const preview = showPreview(triggerKey, triggerData);
        const hasAllValues = triggerData.variables.every(varName => 
          values[triggerKey]?.[varName] && values[triggerKey][varName].trim() !== ''
        );

        return (
          <div key={triggerKey} className="space-y-4">
            <div className="space-y-1">
              <h4 className="font-medium text-sm">
                {triggerData.trigger_name}
              </h4>
              <p className="text-xs text-muted-foreground">
                Customize the values for this trigger
              </p>
            </div>

            <div className="space-y-3">
              {triggerData.variables.map(varName => (
                <div key={varName} className="space-y-2">
                  <Label htmlFor={`${triggerKey}-${varName}`}>
                    {formatVariableName(varName)}
                    <span className="text-destructive ml-1">*</span>
                  </Label>
                  <Input
                    id={`${triggerKey}-${varName}`}
                    type="text"
                    placeholder={getVariablePlaceholder(varName)}
                    value={getVariableValue(triggerKey, varName)}
                    onChange={(e) => handleVariableChange(triggerKey, varName, e.target.value)}
                    className="w-full"
                  />
                </div>
              ))}
            </div>

            {hasAllValues && (
              <div className="p-3 bg-muted rounded-lg space-y-2">
                <p className="text-xs font-medium text-muted-foreground">Preview:</p>
                <p className="text-xs break-words whitespace-pre-wrap">
                  {preview}
                </p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
