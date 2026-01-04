import React, { useState, useEffect, useCallback } from 'react';
import { Loader2, Info } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import type { SetupStep } from './types';

interface TriggerField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'select';
  required: boolean;
  description?: string;
  placeholder?: string;
  enum?: string[];
  default?: any;
}

interface TriggerConfigStepProps {
  step: SetupStep & { 
    trigger_slug?: string; 
    trigger_index?: number;
    trigger_fields?: Record<string, { type: string; required: boolean }>;
  };
  profileId: string | null;
  config: Record<string, any>;
  onProfileSelect: (stepId: string, profileId: string | null) => void;
  onConfigUpdate: (stepId: string, config: Record<string, any>) => void;
}

const FieldRenderer = ({ 
  field, 
  value, 
  onChange 
}: { 
  field: TriggerField; 
  value: any;
  onChange: (key: string, value: any, type: string) => void;
}) => {
  const fieldValue = value ?? field.default ?? '';
  
  switch (field.type) {
    case 'select':
      return (
        <Select
          value={fieldValue.toString()}
          onValueChange={(val) => onChange(field.key, val, field.type)}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder={field.placeholder || `Select ${field.label}`} />
          </SelectTrigger>
          <SelectContent>
            {field.enum?.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
      
    case 'boolean':
      return (
        <div className="flex items-center space-x-2">
          <Checkbox
            id={field.key}
            checked={fieldValue === true}
            onCheckedChange={(checked) => onChange(field.key, checked, field.type)}
          />
          <label
            htmlFor={field.key}
            className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
          >
            {field.label}
          </label>
        </div>
      );
      
    case 'array':
      return (
        <Input
          type="text"
          value={Array.isArray(fieldValue) ? fieldValue.join(', ') : fieldValue}
          onChange={(e) => onChange(field.key, e.target.value, field.type)}
          placeholder={field.placeholder || 'Enter comma-separated values'}
          className="w-full"
        />
      );
      
    case 'number':
      return (
        <Input
          type="number"
          value={fieldValue}
          onChange={(e) => onChange(field.key, e.target.value, field.type)}
          placeholder={field.placeholder}
          className="w-full"
        />
      );
      
    default:
      return (
        <Input
          type="text"
          value={fieldValue}
          onChange={(e) => onChange(field.key, e.target.value, field.type)}
          placeholder={field.placeholder}
          className="w-full"
        />
      );
  }
};

export const TriggerConfigStep: React.FC<TriggerConfigStepProps> = ({
  step,
  profileId,
  config,
  onProfileSelect,
  onConfigUpdate,
}) => {
  const [isLoadingFields, setIsLoadingFields] = useState(false);
  const [triggerFields, setTriggerFields] = useState<TriggerField[]>([]);
  const [error, setError] = useState<string | null>(null);

  const fetchTriggerFields = useCallback(async () => {
    if (step.trigger_fields) {
      const fields: TriggerField[] = Object.entries(step.trigger_fields).map(([key, fieldInfo]) => ({
        key,
        label: key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
        type: fieldInfo.type === 'boolean' ? 'boolean' : 
              fieldInfo.type === 'number' ? 'number' :
              fieldInfo.type === 'array' ? 'array' :
              'string',
        required: fieldInfo.required,
        description: `Required field from template`,
        placeholder: `Enter ${key}`,
      }));
      setTriggerFields(fields);
      setIsLoadingFields(false);
      return;
    }
    if (!step.trigger_slug) return;
    
    setIsLoadingFields(true);
    setError(null);
    
    try {
      const response = await fetch(`/api/composio/triggers/schema/${step.trigger_slug}`);
      if (!response.ok) {
        throw new Error('Failed to fetch trigger fields');
      }
      
      const data = await response.json();
      const fields: TriggerField[] = [];
      
      if (data.config?.properties) {
        Object.entries(data.config.properties).forEach(([key, prop]: [string, any]) => {
          fields.push({
            key,
            label: prop.title || key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
            type: prop.enum ? 'select' : prop.type || 'string',
            required: data.config.required?.includes(key) || false,
            description: prop.description,
            placeholder: prop.example || prop.default || `Enter ${key}`,
            enum: prop.enum,
            default: prop.default,
          });
        });
      }
      
      setTriggerFields(fields);
    } catch (err) {
      console.error('Error fetching trigger fields:', err);
      setError('Failed to load trigger configuration fields');
    } finally {
      setIsLoadingFields(false);
    }
  }, [step.trigger_slug, step.trigger_fields]);

  useEffect(() => {
    fetchTriggerFields();
  }, [fetchTriggerFields]);

  const handleFieldChange = useCallback((key: string, value: any, type: string) => {
    let processedValue = value;
    
    if (type === 'number' && typeof value === 'string') {
      processedValue = value ? parseFloat(value) : undefined;
    } else if (type === 'boolean') {
      processedValue = value;
    } else if (type === 'array' && typeof value === 'string') {
      processedValue = value.split(',').map(s => s.trim()).filter(Boolean);
    }
    
    onConfigUpdate(step.id, {
      ...config,
      [key]: processedValue
    });
  }, [step.id, config, onConfigUpdate]);


  return (
    <div className="p-4 bg-muted/50 rounded-lg">
      <h4 className="font-medium mb-3">Trigger Configuration</h4>
      {isLoadingFields ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          <span className="ml-2 text-sm text-muted-foreground">Loading configuration fields...</span>
        </div>
      ) : error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : triggerFields.length === 0 ? (
        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription>
            No additional configuration needed for this trigger.
          </AlertDescription>
        </Alert>
      ) : (
        <div className="space-y-4">
          {triggerFields.map((field) => (
            <div key={field.key} className="space-y-2">
              <Label htmlFor={field.key}>
                {field.label}
                {field.required && <span className="text-destructive ml-1">*</span>}
              </Label>
              {field.description && (
                <p className="text-xs text-muted-foreground">{field.description}</p>
              )}
              <FieldRenderer 
                key={field.key}
                field={field} 
                value={config[field.key]} 
                onChange={handleFieldChange}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
