'use client';

import { motion } from 'framer-motion';
import { ExternalLink } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { ConfigurationField } from '../shared/types';
import { IconRenderer } from '../shared/icon-renderer';

interface FieldRendererProps {
  field: ConfigurationField;
  value: any;
  onChange: (value: any) => void;
  index: number;
}

export const FieldRenderer = ({ field, value, onChange, index }: FieldRendererProps) => {
  const renderField = () => {
    switch (field.type) {
      case 'text':
        return (
          <Input
            placeholder={field.placeholder || `Enter ${field.label.toLowerCase()}`}
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            className="w-full"
          />
        );

      case 'textarea':
        return (
          <Textarea
            placeholder={field.placeholder || `Enter ${field.label.toLowerCase()}`}
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            className="w-full min-h-[100px]"
          />
        );

      case 'select':
        return (
          <select
            className="w-full p-3 border rounded-lg bg-background focus:ring-2 focus:ring-primary focus:border-transparent"
            value={value || field.default || ''}
            onChange={(e) => onChange(e.target.value)}
          >
            {field.options?.map((option: string) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        );

      case 'multiselect':
        return (
          <div className="grid grid-cols-2 gap-3">
            {field.options?.map((option: string) => (
              <label
                key={option}
                className="flex items-center space-x-3 p-3 border rounded-lg cursor-pointer hover:bg-muted/50 transition-colors"
              >
                <input
                  type="checkbox"
                  checked={value?.includes(option) || false}
                  onChange={(e) => {
                    const current = value || [];
                    const updated = e.target.checked
                      ? [...current, option]
                      : current.filter((item: string) => item !== option);
                    onChange(updated);
                  }}
                  className="rounded"
                />
                <span className="text-sm font-medium">{option}</span>
              </label>
            ))}
          </div>
        );

      case 'integrations':
        return (
          <div className="space-y-4">
            {field.description && (
              <p className="text-sm text-muted-foreground">{field.description}</p>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {field.options?.map((integration: any) => (
                <label
                  key={integration.name}
                  className="flex items-center space-x-3 p-4 border rounded-lg cursor-pointer hover:bg-muted/50 transition-colors group"
                >
                  <input
                    type="checkbox"
                    checked={value?.includes(integration.name) || false}
                    onChange={(e) => {
                      const current = value || [];
                      const updated = e.target.checked
                        ? [...current, integration.name]
                        : current.filter((item: string) => item !== integration.name);
                      onChange(updated);
                    }}
                    className="rounded"
                  />
                  <div className="flex items-center space-x-3 flex-1">
                    <div className="p-2 bg-muted/50 rounded-lg">
                      <IconRenderer iconName={integration.icon} className="text-primary" size={20} />
                    </div>
                    <div className="flex-1">
                      <div className="font-medium text-sm">{integration.name}</div>
                      <div className="text-xs text-muted-foreground">{integration.description}</div>
                    </div>
                  </div>
                  <ExternalLink className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                </label>
              ))}
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.1, duration: 0.3 }}
      className="space-y-3"
    >
      <div className="space-y-2">
        <Label className="text-sm font-semibold flex items-center gap-2">
          {field.label}
          {field.type === 'multiselect' && (
            <Badge variant="outline" className="text-xs">
              Select multiple
            </Badge>
          )}
        </Label>
        {field.description && field.type !== 'integrations' && (
          <p className="text-xs text-muted-foreground">{field.description}</p>
        )}
      </div>
      {renderField()}
    </motion.div>
  );
};

