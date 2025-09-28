import React, { useCallback } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Server, Info } from 'lucide-react';
import type { SetupStep } from './types';

interface CustomServerStepProps {
  step: SetupStep;
  config: Record<string, any>;
  onConfigUpdate: (qualifiedName: string, config: Record<string, any>) => void;
}

export const CustomServerStep: React.FC<CustomServerStepProps> = ({
  step,
  config,
  onConfigUpdate
}) => {
  const handleFieldChange = useCallback((fieldKey: string, value: string) => {
    const newConfig = {
      ...config,
      [fieldKey]: value
    };
    onConfigUpdate(step.qualified_name, newConfig);
  }, [config, onConfigUpdate, step.qualified_name]);

  return (
    <div className="space-y-4">
      {step.custom_type && (
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-800">
            {step.custom_type.toUpperCase()}
          </Badge>
          <span className="text-sm text-muted-foreground">Custom Server</span>
        </div>
      )}
      <div className="space-y-4">
        {step.required_fields?.map((field) => (
          <div key={field.key} className="space-y-2">
            <Input
              id={field.key}
              type={field.type}
              placeholder={field.placeholder}
              value={config[field.key] || ''}
              onChange={(e) => handleFieldChange(field.key, e.target.value)}
              className="h-11"
            />
            {field.description && (
              <div className="flex items-start gap-2">
                <Info className="h-3 w-3 text-muted-foreground mt-0.5 flex-shrink-0" />
                <p className="text-xs text-muted-foreground">{field.description}</p>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}; 