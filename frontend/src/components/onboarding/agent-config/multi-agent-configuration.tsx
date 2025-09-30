'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, Settings } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { StepWrapper } from '../shared/step-wrapper';
import { AgentConfiguration } from './agent-configuration';
import { allAgents } from '../shared/data';
import { userContext } from '../shared/context';

export const MultiAgentConfigurationStep = () => {
  const [currentAgentIndex, setCurrentAgentIndex] = useState(0);
  const [configurations, setConfigurations] = useState<{[key: string]: any}>({});

  const selectedAgentIds = userContext.selectedAgents || ['maya', 'sage', 'nova'];
  const selectedAgents = allAgents.filter(agent => selectedAgentIds.includes(agent.id));
  const currentAgent = selectedAgents[currentAgentIndex];

  if (!currentAgent) {
    return (
      <StepWrapper>
        <div className="text-center py-12">
          <Settings className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <h3 className="text-xl font-semibold mb-2">No Agents Selected</h3>
          <p className="text-muted-foreground">Please go back and select some agents to configure.</p>
        </div>
      </StepWrapper>
    );
  }

  const nextAgent = () => {
    if (currentAgentIndex < selectedAgents.length - 1) {
      setCurrentAgentIndex(prev => prev + 1);
    }
  };

  const previousAgent = () => {
    if (currentAgentIndex > 0) {
      setCurrentAgentIndex(prev => prev - 1);
    }
  };

  const handleConfigurationChange = (agentId: string, configuration: Record<string, any>) => {
    setConfigurations(prev => ({
      ...prev,
      [agentId]: configuration
    }));
  };

  const getAgentStatus = (agentId: string): 'completed' | 'current' | 'pending' => {
    const agentIndex = selectedAgents.findIndex(a => a.id === agentId);
    if (agentIndex < currentAgentIndex) return 'completed';
    if (agentIndex === currentAgentIndex) return 'current';
    return 'pending';
  };

  const isConfigured = (agentId: string): boolean => {
    const config = configurations[agentId];
    return config && Object.keys(config).some(key => {
      const value = config[key];
      return value && (Array.isArray(value) ? value.length > 0 : true);
    });
  };

  return (
    <StepWrapper>
      <div className="space-y-6">
        {/* Compact header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center"
        >
          <h2 className="text-2xl font-bold mb-2">Configure {currentAgent.name}</h2>
          <p className="text-sm text-muted-foreground">
            {currentAgentIndex + 1} of {selectedAgents.length}
          </p>
        </motion.div>

        {/* Agent configuration */}
        <motion.div
          key={currentAgent.id}
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }}
          transition={{ duration: 0.3 }}
        >
          <AgentConfiguration
            agentId={currentAgent.id}
            showHeader={false}
            onConfigurationChange={handleConfigurationChange}
          />
        </motion.div>

        {/* Compact navigation */}
        {selectedAgents.length > 1 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="flex justify-center items-center gap-3"
          >
            <Button
              variant="outline"
              size="sm"
              onClick={previousAgent}
              disabled={currentAgentIndex === 0}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>

            <div className="flex items-center gap-1">
              {selectedAgents.map((agent, index) => (
                <div
                  key={agent.id}
                  className={cn(
                    'w-2 h-2 rounded-full transition-all',
                    index === currentAgentIndex 
                      ? 'bg-foreground w-6' 
                      : isConfigured(agent.id)
                      ? 'bg-foreground/40'
                      : 'bg-border'
                  )}
                />
              ))}
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={nextAgent}
              disabled={currentAgentIndex === selectedAgents.length - 1}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </motion.div>
        )}
      </div>
    </StepWrapper>
  );
};

