'use client';

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Badge } from '@/components/ui/badge';
import { StepWrapper } from '../shared/step-wrapper';
import { UnifiedAgentCard, type BaseAgentData } from '@/components/ui/unified-agent-card';
import { allAgents } from '../shared/data';
import { userContext, updateUserContext } from '../shared/context';
import { AIAgent } from '../shared/types';

export const WorkforceSelectionStep = () => {
  const [selectedAgents, setSelectedAgents] = useState<string[]>(userContext.selectedAgents || []);

  // Update global context when selection changes
  useEffect(() => {
    updateUserContext({ selectedAgents });
  }, [selectedAgents]);

  // Get recommended AI workers based on user context
  const getRecommendedAgents = (): string[] => {
    const role = userContext.role?.toLowerCase() || '';
    const description = userContext.websiteUrl?.toLowerCase() || '';
    const userType = userContext.userType;

    const recommended = new Set<string>();

    // Role-based recommendations
    if (role.includes('ceo') || role.includes('founder') || role.includes('executive')) {
      recommended.add('daily-recap');
      recommended.add('weekly-recap');
      recommended.add('meeting-researcher');
    }
    
    if (role.includes('sales') || role.includes('business development')) {
      recommended.add('lead-generator');
      recommended.add('meeting-researcher');
      recommended.add('presentation-creator');
    }
    
    if (role.includes('marketing') || role.includes('content')) {
      recommended.add('email-assistant');
      recommended.add('presentation-creator');
      recommended.add('weekly-recap');
    }

    // Description-based recommendations
    if (description.includes('email') || description.includes('communication')) {
      recommended.add('email-assistant');
    }
    if (description.includes('sales') || description.includes('lead')) {
      recommended.add('lead-generator');
    }
    if (description.includes('meeting') || description.includes('client')) {
      recommended.add('meeting-researcher');
    }
    if (description.includes('presentation') || description.includes('pitch')) {
      recommended.add('presentation-creator');
    }

    // Universal recommendations - everyone can benefit from these
    recommended.add('email-assistant'); // Everyone has email
    recommended.add('daily-recap'); // Everyone needs daily updates
    
    // Add lead generation for business-focused users
    if (userType === 'company' || role.includes('business') || role.includes('sales')) {
      recommended.add('lead-generator');
    }

    // Ensure we have at least 3 recommendations
    if (recommended.size < 3) {
      ['email-assistant', 'daily-recap', 'meeting-researcher'].forEach(id => recommended.add(id));
    }

    return Array.from(recommended);
  };

  // Auto-select recommended agents on first load
  useEffect(() => {
    if (selectedAgents.length === 0) {
      const recommended = getRecommendedAgents();
      setSelectedAgents(recommended.slice(0, 3)); // Select top 3
    }
  }, []);

  const recommendedIds = getRecommendedAgents();

  const toggleAgent = (agentId: string) => {
    setSelectedAgents(prev => 
      prev.includes(agentId)
        ? prev.filter(id => id !== agentId)
        : [...prev, agentId]
    );
  };


  return (
    <StepWrapper>
      <div className="space-y-8">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="text-center"
        >
          <h2 className="text-3xl font-bold">
            Choose Your AI Workers
          </h2>
        </motion.div>

        {/* AI Workers */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3"
        >
          {allAgents.map((agent, index) => {
            // Convert AIAgent to BaseAgentData
            const convertToBaseAgentData = (agent: AIAgent): BaseAgentData => ({
              id: agent.id,
              name: agent.name,
              description: agent.description,
              role: agent.role,
              icon: agent.icon,
              capabilities: agent.capabilities,
              tags: agent.tags || [],
              created_at: new Date().toISOString(),
            });

            return (
              <UnifiedAgentCard
                key={agent.id}
                variant="onboarding"
                data={convertToBaseAgentData(agent)}
                actions={{
                  onToggle: toggleAgent,
                }}
                state={{
                  isSelected: selectedAgents.includes(agent.id),
                  isRecommended: recommendedIds.includes(agent.id),
                }}
                delay={index * 0.1}
              />
            );
          })}
        </motion.div>

        {/* Simple selection summary */}
        {selectedAgents.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.3 }}
            className="text-center"
          >
            <Badge variant="outline" className="px-4 py-2">
              {selectedAgents.length} worker{selectedAgents.length !== 1 ? 's' : ''} selected
            </Badge>
          </motion.div>
        )}
      </div>
    </StepWrapper>
  );
};

