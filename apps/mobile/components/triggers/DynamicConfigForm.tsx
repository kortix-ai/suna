/**
 * Dynamic Config Form Component
 *
 * Renders form fields based on JSON schema from trigger config
 * Supports string, number, boolean, and array field types
 * Uses Kortix design tokens
 */

import React from 'react';
import { View, TextInput } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Switch } from '@/components/ui/switch';
import { Info } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { THEME } from '@/lib/utils/theme';

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
  const isDark = colorScheme === 'dark';
  const textColor = isDark ? THEME.dark.foreground : THEME.light.foreground;
  const mutedTextColor = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  const borderColor = isDark ? THEME.dark.border : THEME.light.border;
  const bgColor = isDark ? THEME.dark.card : THEME.light.card;
  const destructiveColor = isDark ? THEME.dark.destructive : THEME.light.destructive;

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
          <View key={key} style={{ marginBottom: 16 }}>
            <Text
              style={{
                fontSize: 14,
                fontWeight: '600',
                color: textColor,
                marginBottom: 8,
              }}>
              {label} {isRequired && <Text style={{ color: destructiveColor }}>*</Text>}
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
                placeholderTextColor={mutedTextColor}
                keyboardType="numeric"
                style={{
                  padding: 12,
                  borderRadius: 12,
                  borderWidth: 1.5,
                  borderColor,
                  backgroundColor: bgColor,
                  fontSize: 16,
                  color: textColor,
                }}
              />
            ) : type === 'array' ? (
              <TextInput
                value={Array.isArray(current) ? current.join(',') : String(current || '')}
                onChangeText={(text) => {
                  const items = text.split(',').map((x) => x.trim()).filter(Boolean);
                  handleChange(items);
                }}
                placeholder={examples[0] ? String(examples[0]) : 'comma,separated,values'}
                placeholderTextColor={mutedTextColor}
                style={{
                  padding: 12,
                  borderRadius: 12,
                  borderWidth: 1.5,
                  borderColor,
                  backgroundColor: bgColor,
                  fontSize: 16,
                  color: textColor,
                }}
              />
            ) : type === 'boolean' ? (
              <View className="flex-row items-center gap-3">
                <Switch
                  checked={Boolean(current)}
                  onCheckedChange={handleChange}
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
                placeholderTextColor={mutedTextColor}
                style={{
                  padding: 12,
                  borderRadius: 12,
                  borderWidth: 1.5,
                  borderColor,
                  backgroundColor: bgColor,
                  fontSize: 16,
                  color: textColor,
                }}
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

