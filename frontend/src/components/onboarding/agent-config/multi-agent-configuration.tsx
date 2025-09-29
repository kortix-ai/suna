'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, CheckCircle2, Clock, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StepWrapper } from '../shared/step-wrapper';
import { AgentConfiguration } from './agent-configuration';
import { allAgents } from '../shared/data';
import { userContext } from '../shared/context';
import { IconRenderer } from '../shared/icon-renderer';

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
      <div className="space-y-8">
        {/* Header with agent progress */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center space-y-6"
        >
          <div className="flex items-center justify-center gap-3">
            <div className="p-3 rounded-xl bg-primary/10">
              <IconRenderer iconName={currentAgent.icon} className="text-primary" size={32} />
            </div>
            <div>
              <h2 className="text-2xl font-bold">Configure {currentAgent.name}</h2>
              <p className="text-muted-foreground">
                Customize {currentAgent.name} for your {currentAgent.role.toLowerCase()} needs
              </p>
            </div>
          </div>

          {/* Agent progress indicator */}
          <div className="flex justify-center">
            <Card className="p-4 bg-muted/30">
              <div className="flex items-center space-x-4">
                {selectedAgents.map((agent, index) => {
                  const status = getAgentStatus(agent.id);
                  const configured = isConfigured(agent.id);
                  
                  return (
                    <div
                      key={agent.id}
                      className="flex items-center space-x-2"
                    >
                      <div
                        className={`flex items-center space-x-2 px-3 py-2 rounded-full text-sm font-medium transition-all ${
                          status === 'current'
                            ? 'bg-primary text-primary-foreground scale-105'
                            : status === 'completed'
                            ? 'bg-primary/10 text-primary'
                            : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        <IconRenderer iconName={agent.icon} className="text-primary" size={20} />
                        <span>{agent.name}</span>
                        {status === 'completed' && configured && (
                          <CheckCircle2 className="h-4 w-4" />
                        )}
                        {status === 'current' && (
                          <Clock className="h-4 w-4" />
                        )}
                      </div>
                      {index < selectedAgents.length - 1 && (
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>
          </div>

          {/* Progress summary */}
          <div className="flex justify-center">
            <Badge variant="outline" className="px-4 py-2">
              {currentAgentIndex + 1} of {selectedAgents.length} agents
            </Badge>
          </div>
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

        {/* Navigation */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="flex justify-between items-center pt-6"
        >
          <Button
            variant="outline"
            onClick={previousAgent}
            disabled={currentAgentIndex === 0}
            className="flex items-center gap-2"
          >
            <ChevronLeft className="h-4 w-4" />
            Previous Agent
          </Button>

          <div className="flex items-center gap-3">
            {/* Skip option */}
            {currentAgentIndex < selectedAgents.length - 1 && (
              <Button
                variant="ghost"
                onClick={nextAgent}
                className="text-muted-foreground hover:text-foreground"
              >
                Skip for now
              </Button>
            )}

            <Button
              onClick={nextAgent}
              disabled={currentAgentIndex === selectedAgents.length - 1}
              className="flex items-center gap-2"
            >
              {currentAgentIndex === selectedAgents.length - 1 ? (
                <>
                  <CheckCircle2 className="h-4 w-4" />
                  Configuration Complete
                </>
              ) : (
                <>
                  Next Agent
                  <ChevronRight className="h-4 w-4" />
                </>
              )}
            </Button>
          </div>
        </motion.div>

        {/* Configuration summary */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
          className="bg-primary/5 border border-primary/20 rounded-lg p-6"
        >
          <h3 className="font-semibold mb-4 flex items-center gap-2">
            <Settings className="h-5 w-5" />
            Configuration Summary
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {selectedAgents.map((agent) => (
              <div
                key={agent.id}
                className={`p-3 rounded-lg border ${
                  isConfigured(agent.id)
                    ? 'bg-primary/5 border-primary/20'
                    : 'bg-muted border-border'
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <IconRenderer iconName={agent.icon} className="text-primary" size={16} />
                  <span className="font-medium text-sm">{agent.name}</span>
                  {isConfigured(agent.id) && (
                    <CheckCircle2 className="h-3 w-3 text-primary" />
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {isConfigured(agent.id) ? 'Configured' : 'Needs configuration'}
                </p>
              </div>
            ))}
          </div>
        </motion.div>
      </div>
    </StepWrapper>
  );
};

