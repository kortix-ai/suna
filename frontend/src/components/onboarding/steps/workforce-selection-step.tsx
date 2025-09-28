'use client';

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Users, Sparkles, Filter } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { StepWrapper } from '../shared/step-wrapper';
import { UnifiedAgentCard, type BaseAgentData } from '@/components/ui/unified-agent-card';
import { allAgents, agentCategories } from '../shared/data';
import { userContext, updateUserContext } from '../shared/context';
import { AIAgent } from '../shared/types';
import { IconRenderer } from '../shared/icon-renderer';

export const WorkforceSelectionStep = () => {
  const [selectedAgents, setSelectedAgents] = useState<string[]>(userContext.selectedAgents || []);
  const [filter, setFilter] = useState<string>('recommended');

  // Update global context when selection changes
  useEffect(() => {
    updateUserContext({ selectedAgents });
  }, [selectedAgents]);

  // Get recommended agents based on user context
  const getRecommendedAgents = (): string[] => {
    const goals = userContext.primaryGoals || [];
    const userType = userContext.userType;
    const industry = userContext.industry;
    const services = userContext.extractedContext?.services || [];

    const recommended = new Set<string>();

    // Goal-based recommendations
    goals.forEach(goal => {
      switch (goal.toLowerCase()) {
        case 'content creation':
        case 'content marketing':
          recommended.add('maya');
          break;
        case 'seo optimization':
        case 'seo':
          recommended.add('nova');
          break;
        case 'data analysis':
        case 'analytics':
          recommended.add('sage');
          break;
        case 'customer support':
          recommended.add('alex');
          break;
        case 'recruitment':
          recommended.add('hunter');
          break;
        case 'development':
          recommended.add('byte');
          break;
        case 'design':
          recommended.add('pixel');
          break;
        case 'sales':
        case 'lead generation':
          recommended.add('echo');
          break;
      }
    });

    // Service-based recommendations
    services.forEach(service => {
      if (service.toLowerCase().includes('seo')) recommended.add('nova');
      if (service.toLowerCase().includes('content')) recommended.add('maya');
      if (service.toLowerCase().includes('analytics')) recommended.add('sage');
    });

    // Default recommendations for different user types
    if (userType === 'individual') {
      recommended.add('maya'); // Content creation
      recommended.add('sage'); // Analytics
    } else if (userType === 'company') {
      recommended.add('maya'); // Content
      recommended.add('alex'); // Customer success
      recommended.add('sage'); // Analytics
    }

    // Ensure we have at least 3 recommendations
    if (recommended.size < 3) {
      ['maya', 'sage', 'nova'].forEach(id => recommended.add(id));
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

  // Filter agents based on current filter
  const getFilteredAgents = (): AIAgent[] => {
    if (filter === 'recommended') {
      return allAgents.filter(agent => recommendedIds.includes(agent.id));
    } else if (filter === 'all') {
      return allAgents;
    } else {
      return allAgents.filter(agent => agent.category === filter);
    }
  };

  const filteredAgents = getFilteredAgents();

  const toggleAgent = (agentId: string) => {
    setSelectedAgents(prev => 
      prev.includes(agentId)
        ? prev.filter(id => id !== agentId)
        : [...prev, agentId]
    );
  };

  // Get category counts
  const getCategoryCount = (categoryId: string): number => {
    if (categoryId === 'all') return allAgents.length;
    if (categoryId === 'recommended') return recommendedIds.length;
    return allAgents.filter(agent => agent.category === categoryId).length;
  };

  return (
    <StepWrapper>
      <div className="space-y-8">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="text-center space-y-4"
        >
          <Users className="h-12 w-12 text-primary mx-auto" />
          <div>
            <h2 className="text-2xl font-bold mb-3">Choose Your AI Workforce</h2>
            <p className="text-muted-foreground max-w-2xl mx-auto">
              Based on your goals, we've pre-selected some agents for you. 
              Feel free to customize your team by adding or removing agents.
            </p>
          </div>
          
          {/* Selection summary */}
          <div className="flex items-center justify-center gap-4 text-sm">
            <Badge variant="outline" className="px-3 py-1">
              {selectedAgents.length} agents selected
            </Badge>
            {selectedAgents.length > 0 && (
              <span className="text-primary flex items-center gap-1">
                <Sparkles className="h-4 w-4" />
                Ready to configure
              </span>
            )}
          </div>
        </motion.div>

        {/* Filter tabs */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="flex items-center justify-center"
        >
          <div className="flex items-center gap-2 p-1 bg-muted rounded-lg">
            <Button
              variant={filter === 'recommended' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setFilter('recommended')}
              className="gap-2"
            >
              <Sparkles className="h-4 w-4" />
              Recommended ({getCategoryCount('recommended')})
            </Button>
            <Button
              variant={filter === 'all' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setFilter('all')}
            >
              All ({getCategoryCount('all')})
            </Button>
            {agentCategories.slice(1).map((category) => (
              <Button
                key={category.id}
                variant={filter === category.id ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setFilter(category.id)}
              >
                {category.name} ({getCategoryCount(category.id)})
              </Button>
            ))}
          </div>
        </motion.div>

        {/* Agent cards */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.2 }}
          className="grid gap-4 md:grid-cols-2"
        >
          {filteredAgents.map((agent, index) => {
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

        {/* Empty state */}
        {filteredAgents.length === 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-center py-12"
          >
            <Filter className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="font-semibold text-lg mb-2">No agents in this category</h3>
            <p className="text-muted-foreground">Try selecting a different category to see more agents.</p>
          </motion.div>
        )}

        {/* Selection preview */}
        {selectedAgents.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.3 }}
            className="bg-primary/5 border border-primary/20 rounded-lg p-6"
          >
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <Users className="h-5 w-5" />
              Your Selected Team
            </h3>
            <div className="flex flex-wrap gap-3">
              {selectedAgents.map(agentId => {
                const agent = allAgents.find(a => a.id === agentId);
                return agent ? (
                  <div key={agentId} className="flex items-center gap-2 bg-background rounded-md px-3 py-2 border">
                    <IconRenderer iconName={agent.icon} className="text-primary" size={20} />
                    <div>
                      <p className="font-medium text-sm">{agent.name}</p>
                      <p className="text-xs text-muted-foreground">{agent.role}</p>
                    </div>
                  </div>
                ) : null;
              })}
            </div>
          </motion.div>
        )}
      </div>
    </StepWrapper>
  );
};

