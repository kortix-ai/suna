"use client";

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Zap,
  Target,
  Info,
  Activity,
  Mail,
  MessageSquare,
  Calendar as CalendarIcon,
  FileText,
  Users,
  Globe,
  Clock
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { TriggerProvider, EventTriggerConfig } from '../types';

interface EventTriggerConfigFormProps {
  provider: TriggerProvider;
  config: EventTriggerConfig;
  onChange: (config: EventTriggerConfig) => void;
  errors: Record<string, string>;
  agentId: string;
  name: string;
  description: string;
  onNameChange: (name: string) => void;
  onDescriptionChange: (description: string) => void;
  isActive: boolean;
  onActiveChange: (active: boolean) => void;
}

const getEventIcon = (triggerSlug: string) => {
  const slug = triggerSlug.toLowerCase();
  if (slug.includes('gmail') || slug.includes('email') || slug.includes('mail')) {
    return <Mail className="h-4 w-4" />;
  }
  if (slug.includes('slack') || slug.includes('message') || slug.includes('chat')) {
    return <MessageSquare className="h-4 w-4" />;
  }
  if (slug.includes('calendar') || slug.includes('event') || slug.includes('meeting')) {
    return <CalendarIcon className="h-4 w-4" />;
  }
  if (slug.includes('document') || slug.includes('file') || slug.includes('doc')) {
    return <FileText className="h-4 w-4" />;
  }
  if (slug.includes('user') || slug.includes('member') || slug.includes('contact')) {
    return <Users className="h-4 w-4" />;
  }
  if (slug.includes('web') || slug.includes('http') || slug.includes('url')) {
    return <Globe className="h-4 w-4" />;
  }
  return <Activity className="h-4 w-4" />;
};

const formatEventName = (triggerSlug: string) => {
  return triggerSlug
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
};

const getEventTypeFromSlug = (triggerSlug: string) => {
  const slug = triggerSlug.toLowerCase();
  if (slug.includes('new')) return 'Creation';
  if (slug.includes('update')) return 'Update';
  if (slug.includes('delete')) return 'Deletion';
  if (slug.includes('message')) return 'Message';
  if (slug.includes('email')) return 'Email';
  return 'Event';
};

export const EventTriggerConfigForm: React.FC<EventTriggerConfigFormProps> = ({
  provider,
  config,
  onChange,
  errors,
  agentId,
  name,
  description,
  onNameChange,
  onDescriptionChange,
  isActive,
  onActiveChange,
}) => {

  const handleAgentPromptChange = (value: string) => {
    onChange({
      ...config,
      agent_prompt: value,
    });
  };

  const eventType = config.trigger_slug ? getEventTypeFromSlug(config.trigger_slug) : '';
  const eventName = config.trigger_slug ? formatEventName(config.trigger_slug) : '';

  return (
    <div className="space-y-6">
      <Card className="border-none bg-transparent shadow-none p-6">
        <CardContent className="p-0">
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-medium mb-4 flex items-center gap-2">
                  <Target className="h-4 w-4" />
                  Trigger Details
                </h3>
                <div className="space-y-3">
                  <div>
                    <Input
                      value={name}
                      onChange={(e) => onNameChange(e.target.value)}
                      placeholder="Trigger name"
                      className={cn("w-full", errors.name && 'border-destructive')}
                    />
                  </div>

                  <div>
                    <Textarea
                      value={description}
                      onChange={(e) => onDescriptionChange(e.target.value)}
                      placeholder="Description (optional)"
                      rows={1}
                      className="text-sm"
                    />
                  </div>

                  <div>
                    <Label className="text-sm font-medium mb-2 block">Status</Label>
                    <Tabs value={isActive ? 'enabled' : 'disabled'} onValueChange={(value) => onActiveChange(value === 'enabled')} className="w-full">
                      <TabsList className="grid w-full grid-cols-2">
                        <TabsTrigger value="enabled">Enabled</TabsTrigger>
                        <TabsTrigger value="disabled">Disabled</TabsTrigger>
                      </TabsList>
                    </Tabs>
                  </div>
                  {errors.name && (
                    <p className="text-xs text-destructive">{errors.name}</p>
                  )}
                </div>
              </div>

              <div>
                <h3 className="text-sm font-medium mb-4 flex items-center gap-2">
                  <Zap className="h-4 w-4" />
                  Agent Instructions
                </h3>
                <div className="space-y-3">
                  <Label htmlFor="agent-prompt" className="text-sm">What should the agent do when this event occurs?</Label>
                  <Textarea
                    id="agent-prompt"
                    value={config.agent_prompt || ''}
                    onChange={(e) => handleAgentPromptChange(e.target.value)}
                    placeholder="Enter instructions for the agent..."
                    rows={3}
                    className={errors.agent_prompt ? 'border-destructive' : ''}
                  />
                  {errors.agent_prompt && (
                    <p className="text-xs text-destructive">{errors.agent_prompt}</p>
                  )}
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-medium mb-4 flex items-center gap-2">
                  <Activity className="h-4 w-4" />
                  Event Configuration
                </h3>

                {config.trigger_slug && (
                  <Card className="mb-6 shadow-none">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-primary/10 text-primary">
                          {getEventIcon(config.trigger_slug)}
                        </div>
                        <div>
                          <div className="font-medium">{eventName}</div>
                          <div className="text-sm text-muted-foreground font-normal">
                            {provider.name} {eventType}
                          </div>
                        </div>
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="pt-0">
                      <div className="space-y-3">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-xs">
                            <Clock className="h-3 w-3 mr-1" />
                            Real-time
                          </Badge>
                          <Badge variant="outline" className="text-xs">
                            Event-driven
                          </Badge>
                        </div>

                        <div className="text-sm text-muted-foreground">
                          This trigger will automatically activate whenever a <strong>{eventName}</strong> event occurs in your {provider.name} account.
                        </div>

                        {config.composio_trigger_id && (
                          <div className="pt-2 border-t">
                            <div className="flex items-center justify-between">
                              <span className="text-xs text-muted-foreground">Event ID</span>
                              <code className="text-xs bg-muted px-2 py-1 rounded">
                                {config.trigger_slug}
                              </code>
                            </div>
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                )}

                <div className="rounded-lg border p-4 bg-muted/30">
                  <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                    <Info className="h-4 w-4" />
                    How It Works
                  </h4>
                  <div className="space-y-2 text-sm text-muted-foreground">
                    <div className="flex items-start gap-2">
                      <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                      <span>When the event occurs in {provider.name}, a webhook notification is sent instantly</span>
                    </div>
                    <div className="flex items-start gap-2">
                      <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                      <span>Your agent receives the event data and executes the configured action</span>
                    </div>
                    <div className="flex items-start gap-2">
                      <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                      <span>No polling or manual checking required - everything happens automatically</span>
                    </div>
                  </div>
                </div>

                {config.profile_id && (
                  <div className="rounded-lg border p-4 bg-muted/30 mt-6">
                    <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                      <Users className="h-4 w-4" />
                      Connected Account
                    </h4>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-muted-foreground">Profile ID</span>
                        <code className="text-xs bg-muted px-2 py-1 rounded">
                          {config.profile_id}
                        </code>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Events will be monitored for this connected {provider.name} account.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};