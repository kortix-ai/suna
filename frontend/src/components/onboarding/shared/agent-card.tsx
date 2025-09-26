'use client';

import { motion } from 'framer-motion';
import { Check, Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { AIAgent } from './types';

interface AgentCardProps {
  agent: AIAgent;
  isSelected: boolean;
  isRecommended?: boolean;
  onToggle: (agentId: string) => void;
  delay?: number;
}

export const AgentCard = ({ 
  agent, 
  isSelected, 
  isRecommended = false, 
  onToggle, 
  delay = 0 
}: AgentCardProps) => {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay }}
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
    >
      <Card 
        className={`cursor-pointer transition-all duration-300 hover:shadow-lg ${
          isSelected 
            ? 'ring-2 ring-primary bg-primary/5' 
            : 'hover:border-primary/50'
        } ${isRecommended ? 'border-green-500/50 bg-green-50/50 dark:bg-green-950/20' : ''}`}
        onClick={() => onToggle(agent.id)}
      >
        <CardContent className="p-6">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-4 flex-1">
              <div className="text-3xl">{agent.icon}</div>
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="font-semibold text-lg">{agent.name}</h3>
                  {isRecommended && (
                    <Badge variant="secondary" className="text-xs bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300">
                      Recommended
                    </Badge>
                  )}
                </div>
                <p className="text-primary font-medium text-sm mb-2">{agent.role}</p>
                <p className="text-muted-foreground text-sm mb-3">{agent.description}</p>
                
                {/* Capabilities */}
                <div className="flex flex-wrap gap-1">
                  {agent.capabilities.slice(0, 3).map((capability) => (
                    <Badge key={capability} variant="outline" className="text-xs">
                      {capability}
                    </Badge>
                  ))}
                  {agent.capabilities.length > 3 && (
                    <Badge variant="outline" className="text-xs">
                      +{agent.capabilities.length - 3} more
                    </Badge>
                  )}
                </div>
              </div>
            </div>
            
            <Button
              variant={isSelected ? "default" : "outline"}
              size="sm"
              className={`ml-4 ${isSelected ? 'bg-primary text-primary-foreground' : ''}`}
            >
              {isSelected ? (
                <>
                  <Check className="h-4 w-4 mr-1" />
                  Selected
                </>
              ) : (
                <>
                  <Plus className="h-4 w-4 mr-1" />
                  Add
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
};

