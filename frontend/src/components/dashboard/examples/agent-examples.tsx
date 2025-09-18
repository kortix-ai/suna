'use client';

import React from 'react';
import { Examples as DefaultExamples } from '../examples';
import { AIDocsExamples } from './ai-docs-examples';
import { ResearchExamples } from './research-examples';
import { CodeExamples } from './code-examples';
import { BusinessExamples } from './business-examples';
import { PresentationExamples } from './presentation-examples';
import { useAgents } from '@/hooks/react-query/agents/use-agents';

interface AgentExamplesProps {
  selectedAgentId?: string;
  onSelectPrompt?: (query: string) => void;
  count?: number;
}

export function AgentExamples({ 
  selectedAgentId, 
  onSelectPrompt, 
  count = 4 
}: AgentExamplesProps) {
  const { data: agentsResponse } = useAgents({}, { 
    enabled: !!selectedAgentId 
  });
  
  const agents = agentsResponse?.agents || [];
  const selectedAgent = agents.find(a => a.agent_id === selectedAgentId);

  const isKortixTeam = selectedAgent?.metadata?.is_kortix_team === true;
  const kortixTemplateId = selectedAgent?.metadata?.kortix_template_id;
  const agentName = selectedAgent?.name?.toLowerCase() || '';
  const templateName = selectedAgent?.metadata?.template_name?.toLowerCase() || '';
  
  if (isKortixTeam) {
    if (
      agentName.includes('doc') || 
      templateName.includes('doc') ||
      agentName.includes('documentation') ||
      templateName.includes('documentation')
    ) {
      return (
        <AIDocsExamples 
          onSelectPrompt={onSelectPrompt} 
          count={count} 
        />
      );
    }
    
    if (
      agentName.includes('research') || 
      templateName.includes('research') ||
      agentName.includes('analysis') ||
      templateName.includes('analysis')
    ) {
      return (
        <ResearchExamples 
          onSelectPrompt={onSelectPrompt} 
          count={count} 
        />
      );
    }
    
    if (
      agentName.includes('code') || 
      templateName.includes('code') ||
      agentName.includes('developer') ||
      templateName.includes('developer') ||
      agentName.includes('programming') ||
      templateName.includes('programming')
    ) {
      return (
        <CodeExamples 
          onSelectPrompt={onSelectPrompt} 
          count={count} 
        />
      );
    }
    
    if (
      agentName.includes('business') || 
      templateName.includes('business') ||
      agentName.includes('finance') ||
      templateName.includes('finance') ||
      agentName.includes('strategy') ||
      templateName.includes('strategy')
    ) {
      return (
        <BusinessExamples 
          onSelectPrompt={onSelectPrompt} 
          count={count} 
        />
      );
    }
    
    if (
      agentName.includes('presentation') || 
      templateName.includes('presentation') ||
      agentName.includes('slides') ||
      templateName.includes('slides') ||
      agentName.includes('pitch') ||
      templateName.includes('pitch') ||
      agentName.includes('deck') ||
      templateName.includes('deck')
    ) {
      return (
        <PresentationExamples 
          onSelectPrompt={onSelectPrompt} 
          count={count} 
        />
      );
    }
    
    // Add more agent types here as they are created
  }
  
  // Default to the original examples for non-Kortix agents or unmatched types
  return (
    <DefaultExamples 
      onSelectPrompt={onSelectPrompt} 
      count={count} 
    />
  );
}
