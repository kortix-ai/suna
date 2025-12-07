/**
 * Dynamic Config Form Component
 *
 * Renders form fields based on JSON schema from trigger config
 * Supports string, number, boolean, and array field types
 * Uses Kortix design tokens
 */

import React from 'react';
import { View, TextInput, Switch } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Info } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';

interface JSONSchema {
  title?: string;
  type?: string;
  properties?: Record<string, any>;
  required?: string[];
}

interface DynamicConfigFormProps {
  schema?: JSONSchema;
  value: Record<string, any>;
  onChange: (value: Record<string, any>) => void;
}

export function DynamicConfigForm({ schema, value, onChange }: DynamicConfigFormProps) {
  const { colorScheme } = useColorScheme();

  if (!schema || !schema.properties || Object.keys(schema.properties).length === 0) {
    return (
      <View className="items-center py-8">
        <View className="mb-3 h-12 w-12 items-center justify-center rounded-xl bg-muted">
          <Icon as={Info} size={20} className="text-muted-foreground" />
        </View>
        <Text className="mb-1 font-roobert-medium text-sm text-foreground">Ready to go!</Text>
        <Text className="text-xs text-muted-foreground font-roobert">
          This trigger doesn't require configuration
        </Text>
      </View>
    );
  }

  const properties = schema.properties || {};
  const required = new Set(schema.required || []);

  return (
    <View className="space-y-4">
      {Object.entries(properties).map(([key, prop]: [string, any]) => {
        const label = prop.title || key;
        const type = prop.type || 'string';
        const isRequired = required.has(key);
        const examples: any[] = Array.isArray(prop.examples) ? prop.examples : [];
        const description: string = prop.description || '';
        const current = value[key] ?? prop.default ?? (type === 'number' || type === 'integer' ? '' : '');

        const handleChange = (val: any) => {
          onChange({ ...value, [key]: val });
        };

        return (
          <View key={key} className="space-y-2">
            <Text className="font-roobert-semibold text-sm text-foreground">
              {label} {isRequired && <Text className="text-red-500">*</Text>}
            </Text>

            {type === 'number' || type === 'integer' ? (
              <TextInput
                value={current === '' ? '' : String(current)}
                onChangeText={(text) => {
                  if (text === '') {
                    handleChange('');
                  } else {
                    const num = type === 'integer' ? parseInt(text, 10) : parseFloat(text);
                    if (!isNaN(num)) {
                      handleChange(num);
                    }
                  }
                }}
                placeholder={examples[0] ? String(examples[0]) : ''}
                placeholderTextColor="hsl(var(--muted-foreground))"
                keyboardType="numeric"
                className="rounded-xl border border-border bg-card px-4 py-4 font-roobert text-base text-foreground"
              />
            ) : type === 'array' ? (
              <TextInput
                value={Array.isArray(current) ? current.join(',') : String(current || '')}
                onChangeText={(text) => {
                  const items = text.split(',').map((x) => x.trim()).filter(Boolean);
                  handleChange(items);
                }}
                placeholder={examples[0] ? String(examples[0]) : 'comma,separated,values'}
                placeholderTextColor="hsl(var(--muted-foreground))"
                className="rounded-xl border border-border bg-card px-4 py-4 font-roobert text-base text-foreground"
              />
            ) : type === 'boolean' ? (
              <View className="flex-row items-center gap-3">
                <Switch
                  value={Boolean(current)}
                  onValueChange={handleChange}
                  trackColor={{ false: 'hsl(var(--muted))', true: 'hsl(var(--primary))' }}
                  thumbColor={colorScheme === 'dark' ? '#f8f8f8' : '#ffffff'}
                />
                <Text className="flex-1 font-roobert text-sm text-foreground">
                  {description || label}
                </Text>
              </View>
            ) : (
              <TextInput
                value={String(current || '')}
                onChangeText={handleChange}
                placeholder={examples[0] ? String(examples[0]) : ''}
                placeholderTextColor="hsl(var(--muted-foreground))"
                className="rounded-xl border border-border bg-card px-4 py-4 font-roobert text-base text-foreground"
              />
            )}

            {description && type !== 'boolean' && (
              <Text className="font-roobert text-xs text-muted-foreground">{description}</Text>
            )}
          </View>
        );
      })}
    </View>
  );
}

