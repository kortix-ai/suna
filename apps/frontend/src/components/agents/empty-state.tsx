import React from 'react';
import { Bot, Search, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface EmptyStateProps {
  hasAgents: boolean;
  onCreateAgent: () => void;
  onClearFilters: () => void;
}

export const EmptyState = ({ hasAgents, onCreateAgent, onClearFilters }: EmptyStateProps) => {
  return (
    <div className="flex flex-col items-center justify-center py-10 sm:py-16 px-3 sm:px-4">
      <div className="flex flex-col items-center text-center max-w-md space-y-4 sm:space-y-6">
        <div className="rounded-full bg-muted p-4 sm:p-6">
          {!hasAgents ? (
            <Bot className="h-8 w-8 sm:h-12 sm:w-12 text-muted-foreground" />
          ) : (
            <Search className="h-8 w-8 sm:h-12 sm:w-12 text-muted-foreground" />
          )}
        </div>
        <div className="space-y-2 sm:space-y-3">
          <h2 className="text-xl sm:text-2xl font-semibold text-foreground">
            {!hasAgents ? 'No workers yet' : 'No workers found'}
          </h2>
          <p className="text-sm sm:text-base text-muted-foreground leading-relaxed">
            {!hasAgents ? (
              'Create your first worker to start automating tasks with custom instructions and tools. Configure custom AgentPress capabilities to fine tune a worker according to your needs.'
            ) : (
              'No workers match your current search and filter criteria. Try adjusting your filters or search terms.'
            )}
          </p>
        </div>
        {!hasAgents ? (
          <Button 
            size="lg" 
            onClick={onCreateAgent}
            className="mt-3 sm:mt-4 h-10 sm:h-11 text-sm sm:text-base"
          >
            <Plus className="h-4 w-4 sm:h-5 sm:w-5" />
            Create your first worker
          </Button>
        ) : (
          <Button 
            variant="outline"
            onClick={onClearFilters}
            className="mt-3 sm:mt-4"
          >
            Clear filters
          </Button>
        )}
      </div>
    </div>
  );
}