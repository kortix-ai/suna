'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { FieldRenderer } from './field-renderer';
import { getConfigurationFields, getIntegrationFields } from './configuration-utils';
import { allAgents } from '../shared/data';
import { AIAgent } from '../shared/types';
import { IconRenderer } from '../shared/icon-renderer';

interface AgentConfigurationProps {
  agentId: string;
  showHeader?: boolean;
  onConfigurationChange?: (agentId: string, configuration: Record<string, any>) => void;
}

export const AgentConfiguration = ({ 
  agentId, 
  showHeader = true,
  onConfigurationChange 
}: AgentConfigurationProps) => {
  const [configuration, setConfiguration] = useState<Record<string, any>>({});

  const agent = allAgents.find(a => a.id === agentId);
  if (!agent) return null;

  const handleFieldChange = (fieldKey: string, value: any) => {
    const newConfiguration = {
      ...configuration,
      [fieldKey]: value
    };
    setConfiguration(newConfiguration);
    onConfigurationChange?.(agentId, newConfiguration);
  };

  const configFields = getConfigurationFields(agentId);
  const integrationFields = getIntegrationFields(agentId);

  return (
    <div className="space-y-6">
      {/* Header */}
      {showHeader && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center space-y-4"
        >
          <div className="flex items-center justify-center gap-3">
            <div className="p-3 rounded-xl bg-primary/10">
              <IconRenderer iconName={agent.icon} className="text-primary" size={32} />
            </div>
            <div>
              <h3 className="text-2xl font-bold">Configure {agent.name}</h3>
              <p className="text-muted-foreground">
                Customize {agent.name} for your {agent.role.toLowerCase()} needs
              </p>
            </div>
          </div>
        </motion.div>
      )}


      {/* Configuration Fields */}
      {configFields.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Agent Settings</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              {configFields.map((field, index) => (
                <FieldRenderer
                  key={field.key}
                  field={field}
                  value={configuration[field.key]}
                  onChange={(value) => handleFieldChange(field.key, value)}
                  index={index}
                />
              ))}
            </CardContent>
          </Card>
        </motion.div>
      )}

      {/* Integration Fields */}
      {integrationFields.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
        >
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Integrations</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              {integrationFields.map((field, index) => (
                <FieldRenderer
                  key={field.key}
                  field={field}
                  value={configuration[field.key]}
                  onChange={(value) => handleFieldChange(field.key, value)}
                  index={index}
                />
              ))}
            </CardContent>
          </Card>
        </motion.div>
      )}

      {/* Agent capabilities reminder */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4 }}
        className="bg-primary/5 border border-primary/20 rounded-lg p-4"
      >
        <h4 className="font-semibold mb-2 flex items-center gap-2">
          <IconRenderer iconName={agent.icon} className="text-primary" size={20} />
          {agent.name}'s Core Capabilities
        </h4>
        <div className="flex flex-wrap gap-2">
          {agent.capabilities.map((capability) => (
            <Badge key={capability} variant="outline" className="text-xs">
              {capability}
            </Badge>
          ))}
        </div>
      </motion.div>
    </div>
  );
};

