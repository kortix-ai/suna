"use client";

import React, { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { 
  Search, 
  MessageSquare, 
  Webhook, 
  Clock, 
  Mail,
  Github,
  Gamepad2,
  Activity,
  ArrowRight
} from 'lucide-react';
import { TriggerProvider } from './types';
import { useTriggerProviders } from '@/hooks/react-query/triggers';

interface TriggerBrowseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onProviderSelect: (provider: TriggerProvider) => void;
}

const getTriggerIcon = (triggerType: string) => {
  switch (triggerType) {
    case 'telegram':
      return <MessageSquare className="h-5 w-5" />;
    case 'slack':
      return <MessageSquare className="h-5 w-5" />;
    case 'webhook':
      return <Webhook className="h-5 w-5" />;
    case 'schedule':
      return <Clock className="h-5 w-5" />;
    case 'email':
      return <Mail className="h-5 w-5" />;
    case 'github':
      return <Github className="h-5 w-5" />;
    case 'discord':
      return <Gamepad2 className="h-5 w-5" />;
    default:
      return <Activity className="h-5 w-5" />;
  }
};

const getTriggerTypeColor = (triggerType: string) => {
  switch (triggerType) {
    case 'telegram':
      return 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300';
    case 'slack':
      return 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300';
    case 'webhook':
      return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300';
    case 'schedule':
      return 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300';
    case 'email':
      return 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300';
    case 'github':
      return 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300';
    case 'discord':
      return 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-300';
    default:
      return 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300';
  }
};

export const TriggerBrowseDialog: React.FC<TriggerBrowseDialogProps> = ({
  open,
  onOpenChange,
  onProviderSelect,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const { data: providers = [], isLoading: loading, error } = useTriggerProviders();

  const filteredProviders = providers.filter(provider =>
    provider.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    provider.description.toLowerCase().includes(searchTerm.toLowerCase()) ||
    provider.trigger_type.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const groupedProviders = filteredProviders.reduce((groups, provider) => {
    const type = provider.trigger_type;
    if (!groups[type]) {
      groups[type] = [];
    }
    groups[type].push(provider);
    return groups;
  }, {} as Record<string, TriggerProvider[]>);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Browse Trigger Providers</DialogTitle>
          <DialogDescription>
            Choose from available trigger providers to connect external services to your agent
          </DialogDescription>
        </DialogHeader>
        
        <div className="flex-1 overflow-hidden flex flex-col">
          <div className="mb-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search triggers..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>
          
          <div className="flex-1 overflow-y-auto space-y-6">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
              </div>
            ) : error ? (
              <div className="text-center py-8">
                <Activity className="h-12 w-12 text-destructive mx-auto mb-4" />
                <h3 className="text-sm font-medium mb-2 text-destructive">Error Loading Providers</h3>
                <p className="text-sm text-muted-foreground">
                  {error instanceof Error ? error.message : 'Failed to load trigger providers'}
                </p>
              </div>
            ) : (
              Object.entries(groupedProviders).map(([type, typeProviders]) => (
                <div key={type} className="space-y-3">
                  <div className="flex items-center space-x-2">
                    {getTriggerIcon(type)}
                    <h3 className="text-sm font-semibold capitalize">
                      {type} Triggers
                    </h3>
                    <Badge variant="secondary" className="text-xs">
                      {typeProviders.length}
                    </Badge>
                  </div>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {typeProviders.map((provider) => (
                      <div
                        key={provider.provider_id}
                        className="p-4 rounded-lg border bg-card hover:bg-muted/50 transition-colors cursor-pointer group"
                        onClick={() => onProviderSelect(provider)}
                      >
                        <div className="flex items-start justify-between mb-3">
                          <div className="flex items-center space-x-3">
                            <div className="p-2 rounded-lg bg-muted group-hover:bg-primary/10 transition-colors">
                              {getTriggerIcon(provider.trigger_type)}
                            </div>
                            <div>
                              <h4 className="text-sm font-medium">{provider.name}</h4>
                              <Badge 
                                variant="secondary" 
                                className={`text-xs ${getTriggerTypeColor(provider.trigger_type)}`}
                              >
                                {provider.trigger_type}
                              </Badge>
                            </div>
                          </div>
                          <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
                        </div>
                        
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          {provider.description}
                        </p>
                        
                        <div className="flex items-center justify-between mt-3">
                          <div className="flex items-center space-x-2">
                            {provider.webhook_enabled && (
                              <Badge variant="outline" className="text-xs">
                                Webhook
                              </Badge>
                            )}
                          </div>
                          
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs"
                            onClick={(e) => {
                              e.stopPropagation();
                              onProviderSelect(provider);
                            }}
                          >
                            Configure
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
            
            {!loading && filteredProviders.length === 0 && (
              <div className="text-center py-8">
                <Activity className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                <h3 className="text-sm font-medium mb-2">No triggers found</h3>
                <p className="text-sm text-muted-foreground">
                  {searchTerm ? 'Try adjusting your search terms' : 'No trigger providers are available'}
                </p>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}; 