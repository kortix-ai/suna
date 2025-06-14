import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Trash2, Plus, Copy, Globe, Clock, Calendar, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';

interface Trigger {
  id: string;
  name: string;
  description?: string;
  type: 'webhook' | 'cron' | 'event';
  config: Record<string, any>;
  enabled: boolean;
  secret?: string; // Only present for webhook triggers
  account_id?: string;
  project_id?: string;
  created_at?: string;
  updated_at?: string;
}

interface AgentTriggersConfigurationProps {
  agentId: string;
  triggers: Trigger[];
  onTriggersChange: (triggers: Trigger[]) => void;
  isLoading?: boolean;
}

const triggerTypeIcons = {
  webhook: Globe,
  cron: Clock,
  event: Calendar,
};

export function AgentTriggersConfiguration({ 
  agentId, 
  triggers, 
  onTriggersChange,
  isLoading = false
}: AgentTriggersConfigurationProps) {
  const [newTrigger, setNewTrigger] = useState<Partial<Trigger>>({
    name: '',
    description: '',
    type: 'webhook',
    config: {},
    enabled: true,
  });
  const [isCreating, setIsCreating] = useState(false);
  const [isCreatingTrigger, setIsCreatingTrigger] = useState(false);
  const [deletingTriggerId, setDeletingTriggerId] = useState<string | null>(null);
  
  const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';

  const getWebhookUrl = (triggerId: string) => {
    return `${window.location.origin}/api/trigger/webhook/${triggerId}`;
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard');
  };

  const handleCreateTrigger = async () => {
    if (!newTrigger.name?.trim()) {
      toast.error('Please enter a trigger name');
      return;
    }

    setIsCreatingTrigger(true);
    
    try {
      // Get authentication token
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        throw new Error('You must be logged in to create triggers');
      }

      // Prepare trigger data for API
      const triggerData = {
        name: newTrigger.name,
        description: newTrigger.description || '',
        type: newTrigger.type as 'webhook' | 'cron' | 'event',
        config: {},
        enabled: newTrigger.enabled ?? true,
      };

      // Set default config based on type
      if (triggerData.type === 'webhook') {
        triggerData.config = { thread_id: agentId, project_id: agentId };
      } else if (triggerData.type === 'cron') {
        triggerData.config = { 
          schedule: '0 9 * * *', // Default: 9 AM daily
          thread_id: agentId, 
          project_id: agentId 
        };
      }

      // Make API call to create trigger
      const response = await fetch(`${API_URL}/triggers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(triggerData),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
        throw new Error(errorData.message || 'Failed to create trigger');
      }

      const createdTrigger = await response.json();
      
      // Update local state with the real trigger from backend
      onTriggersChange([...triggers, createdTrigger]);
      
      setNewTrigger({
        name: '',
        description: '',
        type: 'webhook',
        config: {},
        enabled: true,
      });
      setIsCreating(false);
      toast.success('Trigger created successfully');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create trigger');
      console.error('Error creating trigger:', error);
    } finally {
      setIsCreatingTrigger(false);
    }
  };

  const handleDeleteTrigger = async (triggerId: string) => {
    // If it's a temporary trigger (starts with "temp_"), just remove it locally
    if (triggerId.startsWith('temp_')) {
      onTriggersChange(triggers.filter(t => t.id !== triggerId));
      toast.success('Trigger deleted successfully');
      return;
    }

    setDeletingTriggerId(triggerId);
    
    try {
      // Get authentication token
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        throw new Error('You must be logged in to delete triggers');
      }

      const response = await fetch(`${API_URL}/triggers/${triggerId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
        },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
        throw new Error(errorData.message || 'Failed to delete trigger');
      }

      onTriggersChange(triggers.filter(t => t.id !== triggerId));
      toast.success('Trigger deleted successfully');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete trigger');
      console.error('Error deleting trigger:', error);
    } finally {
      setDeletingTriggerId(null);
    }
  };

  const handleToggleTrigger = async (triggerId: string) => {
    const trigger = triggers.find(t => t.id === triggerId);
    if (!trigger) return;

    // If it's a temporary trigger, just update locally
    if (triggerId.startsWith('temp_')) {
      onTriggersChange(
        triggers.map(t => 
          t.id === triggerId ? { ...t, enabled: !t.enabled } : t
        )
      );
      return;
    }

    try {
      // Get authentication token
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        throw new Error('You must be logged in to update triggers');
      }

      const response = await fetch(`${API_URL}/triggers/${triggerId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          enabled: !trigger.enabled,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
        throw new Error(errorData.message || 'Failed to update trigger');
      }

      const updatedTrigger = await response.json();
      
      onTriggersChange(
        triggers.map(t => 
          t.id === triggerId ? updatedTrigger : t
        )
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update trigger');
      console.error('Error updating trigger:', error);
    }
  };

  const renderTriggerConfig = (trigger: Trigger) => {
    if (trigger.type === 'webhook') {
      const webhookUrl = getWebhookUrl(trigger.id);
      return (
        <div className="space-y-3">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-medium">Webhook URL</Label>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => copyToClipboard(webhookUrl)}
              >
                <Copy className="h-3 w-3 mr-1" />
                Copy
              </Button>
            </div>
            <code className="text-xs bg-muted p-2 rounded block break-all">
              {webhookUrl}
            </code>
            <p className="text-xs text-muted-foreground">
              POST requests to this URL will trigger the agent
            </p>
          </div>
          
          {trigger.secret && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-medium">Authentication Secret</Label>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => copyToClipboard(trigger.secret!)}
                >
                  <Copy className="h-3 w-3 mr-1" />
                  Copy
                </Button>
              </div>
              <code className="text-xs bg-muted p-2 rounded block break-all">
                {trigger.secret}
              </code>
              <p className="text-xs text-muted-foreground">
                Include this as "X-Trigger-Secret" header in your webhook requests
              </p>
            </div>
          )}
        </div>
      );
    }

    if (trigger.type === 'cron') {
      return (
        <div className="space-y-2">
          <Label className="text-xs font-medium">Schedule (Cron)</Label>
          <Input 
            value={trigger.config.schedule || '0 9 * * *'} 
            className="text-xs"
            placeholder="0 9 * * *"
            disabled
          />
          <p className="text-xs text-muted-foreground">
            Schedule format: minute hour day month weekday
          </p>
        </div>
      );
    }

    return (
      <p className="text-xs text-muted-foreground">
        Event-based trigger configuration coming soon
      </p>
    );
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="text-sm text-muted-foreground">
          Configure automated triggers that will activate this agent in response to webhooks, scheduled events, or other triggers.
        </div>
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin" />
          <span className="ml-2 text-sm text-muted-foreground">Loading triggers...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="text-sm text-muted-foreground">
        Configure automated triggers that will activate this agent in response to webhooks, scheduled events, or other triggers.
      </div>

      {/* Existing Triggers */}
      {triggers.length > 0 && (
        <div className="space-y-3">
          {triggers.map((trigger) => {
            const IconComponent = triggerTypeIcons[trigger.type];
            return (
              <Card key={trigger.id} className="p-4">
                <div className="space-y-3">
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3 flex-1">
                      <div className="p-1.5 rounded-md bg-primary/10">
                        <IconComponent className="h-3 w-3 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <h4 className="text-sm font-medium truncate">{trigger.name}</h4>
                          <Badge variant="outline" className="text-xs">
                            {trigger.type}
                          </Badge>
                        </div>
                        {trigger.description && (
                          <p className="text-xs text-muted-foreground mt-1">
                            {trigger.description}
                          </p>
                        )}
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={trigger.enabled}
                        onCheckedChange={() => handleToggleTrigger(trigger.id)}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                        onClick={() => handleDeleteTrigger(trigger.id)}
                        disabled={deletingTriggerId === trigger.id}
                      >
                        {deletingTriggerId === trigger.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  </div>

                  {renderTriggerConfig(trigger)}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Create New Trigger */}
      {isCreating ? (
        <Card className="p-4">
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="trigger-name" className="text-sm font-medium">
                Trigger Name
              </Label>
              <Input
                id="trigger-name"
                value={newTrigger.name || ''}
                onChange={(e) => setNewTrigger(prev => ({ ...prev, name: e.target.value }))}
                placeholder="e.g., Daily Report, Webhook Notifications"
                className="text-sm"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="trigger-type" className="text-sm font-medium">
                Trigger Type
              </Label>
              <Select
                value={newTrigger.type}
                onValueChange={(value: 'webhook' | 'cron' | 'event') => 
                  setNewTrigger(prev => ({ ...prev, type: value }))
                }
              >
                <SelectTrigger className="text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="webhook">Webhook</SelectItem>
                  <SelectItem value="cron">Scheduled (Cron)</SelectItem>
                  <SelectItem value="event" disabled>Event-based (Coming Soon)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="trigger-description" className="text-sm font-medium">
                Description (Optional)
              </Label>
              <Textarea
                id="trigger-description"
                value={newTrigger.description || ''}
                onChange={(e) => setNewTrigger(prev => ({ ...prev, description: e.target.value }))}
                placeholder="Describe what this trigger does..."
                className="text-sm min-h-16"
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsCreating(false)}
              >
                Cancel
              </Button>
              <Button size="sm" onClick={handleCreateTrigger} disabled={isCreatingTrigger}>
                {isCreatingTrigger ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    Creating...
                  </>
                ) : (
                  'Create Trigger'
                )}
              </Button>
            </div>
          </div>
        </Card>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setIsCreating(true)}
          className="w-full border-dashed"
        >
          <Plus className="h-4 w-4 mr-2" />
          Add Trigger
        </Button>
      )}

      {triggers.length === 0 && !isCreating && (
        <div className="text-center py-8 text-muted-foreground">
          <Calendar className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p className="text-sm">No triggers configured yet</p>
          <p className="text-xs">Add triggers to automate agent activation</p>
        </div>
      )}
    </div>
  );
} 