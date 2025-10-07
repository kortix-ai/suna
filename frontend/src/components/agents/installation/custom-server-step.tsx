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
        {step.required_config?.map(key => {
          const label = key === 'url' ? `${step.service_name} Server URL` : key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
          const type = key === 'url' ? 'url' : 'text';
          const placeholder = key === 'url' ? `https://your-${step.service_name.toLowerCase()}-server.com` : `Enter ${key}`;
          const description = key === 'url' ? `Your personal ${step.service_name} server endpoint` : undefined;
          
          return (
            <div key={key} className="space-y-2">
              <Label htmlFor={key}>
                {label}
                <span className="text-destructive ml-1">*</span>
              </Label>
              <Input
                id={key}
                type={type}
                placeholder={placeholder}
                value={config[key] || ''}
                onChange={(e) => handleFieldChange(key, e.target.value)}
                className="h-11"
              />
              {description && (
                <div className="flex items-start gap-2">
                  <Info className="h-3 w-3 text-muted-foreground mt-0.5 flex-shrink-0" />
                  <p className="text-xs text-muted-foreground">{description}</p>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}; 