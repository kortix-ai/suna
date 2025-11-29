"use client";

import { useState } from "react";
import { useTriggerWorkflow, useWorkflows } from "@/hooks/admin/use-notification-workflow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Send, Users, User, ChevronDown } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";

export default function NotificationManagementPage() {
  const [workflowId, setWorkflowId] = useState("");
  const [payload, setPayload] = useState(
    JSON.stringify(
      {
        message: "Your custom message here",
        action_url: "https://example.com"
      },
      null,
      2
    )
  );
  const [subscriberId, setSubscriberId] = useState("");
  const [subscriberEmail, setSubscriberEmail] = useState("");
  const [broadcast, setBroadcast] = useState(true);
  const [useEmail, setUseEmail] = useState(true);

  const { data: workflowsData, isLoading: loadingWorkflows } = useWorkflows();
  const triggerWorkflowMutation = useTriggerWorkflow({
    onSuccess: (data) => {
      if (broadcast) {
        toast.success("Broadcast triggered successfully!", {
          description: "The notification will be sent to all active subscribers in your Novu workspace."
        });
      } else if (useEmail) {
        toast.success("Notification sent!", {
          description: `Sent to: ${subscriberEmail}`
        });
      } else {
        toast.success("Notification sent!", {
          description: `Sent to subscriber: ${subscriberId}`
        });
      }
    },
    onError: (error) => {
      toast.error("Failed to send notification", {
        description: error instanceof Error ? error.message : "An error occurred"
      });
    }
  });
  
  const workflows = workflowsData?.workflows || [];
  const selectedWorkflow = workflows.find(w => w.workflow_id === workflowId);

  const handleTrigger = async () => {
    try {
      const parsedPayload = JSON.parse(payload);

      await triggerWorkflowMutation.mutateAsync({
        workflow_id: workflowId,
        payload: parsedPayload,
        subscriber_id: broadcast || useEmail ? undefined : subscriberId,
        subscriber_email: broadcast || !useEmail ? undefined : subscriberEmail,
        broadcast,
      });
    } catch (e) {
      if (e instanceof SyntaxError) {
        toast.error("Invalid JSON payload", {
          description: "Please check your JSON syntax and try again."
        });
      }
    }
  };

  return (
    <div className="container mx-auto py-8 max-w-6xl">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Notification Management</h1>
        <p className="text-muted-foreground">
          Send notifications to users via email, in-app, or push using Novu workflows
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Send Mode</CardTitle>
                  <CardDescription>Choose who receives this notification</CardDescription>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    <User className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm font-medium">Single User</span>
                  </div>
                  <Switch
                    checked={broadcast}
                    onCheckedChange={setBroadcast}
                    className="data-[state=checked]:bg-primary"
                  />
                  <div className="flex items-center gap-2">
                    <Users className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm font-medium">Broadcast All</span>
                  </div>
                </div>
              </div>
            </CardHeader>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Workflow Configuration</CardTitle>
              <CardDescription>
                Step 1: Select the workflow you want to trigger
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="workflow-id">Workflow</Label>
                <Select value={workflowId} onValueChange={setWorkflowId}>
                  <SelectTrigger id="workflow-id">
                    <SelectValue placeholder={loadingWorkflows ? "Loading workflows..." : "Select a workflow"} />
                  </SelectTrigger>
                  <SelectContent>
                    {loadingWorkflows ? (
                      <SelectItem value="loading" disabled>
                        <div className="flex items-center gap-2">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Loading workflows...
                        </div>
                      </SelectItem>
                    ) : workflows.length === 0 ? (
                      <SelectItem value="none" disabled>
                        No workflows found
                      </SelectItem>
                    ) : (
                      workflows.map((workflow) => (
                        <SelectItem key={workflow.workflow_id} value={workflow.workflow_id}>
                          <div className="flex flex-col">
                            <span className="font-medium">{workflow.name}</span>
                            {workflow.description && (
                              <span className="text-xs text-muted-foreground">{workflow.description}</span>
                            )}
                          </div>
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
                {selectedWorkflow && selectedWorkflow.description && (
                  <p className="text-xs text-muted-foreground">{selectedWorkflow.description}</p>
                )}
                {selectedWorkflow && selectedWorkflow.tags.length > 0 && (
                  <div className="flex gap-1 flex-wrap">
                    {selectedWorkflow.tags.map((tag, i) => (
                      <span key={i} className="text-xs px-2 py-0.5 bg-muted rounded-full">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {!broadcast && (
                <>
                  <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
                    <span className="text-sm font-medium">Target by:</span>
                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-2">
                        <span className="text-sm">User ID</span>
                      </div>
                      <Switch
                        checked={useEmail}
                        onCheckedChange={setUseEmail}
                      />
                      <div className="flex items-center gap-2">
                        <span className="text-sm">Email</span>
                      </div>
                    </div>
                  </div>

                  {useEmail ? (
                    <div className="space-y-2">
                      <Label htmlFor="subscriber-email">Email Address</Label>
                      <Input
                        id="subscriber-email"
                        type="email"
                        placeholder="user@example.com"
                        value={subscriberEmail}
                        onChange={(e) => setSubscriberEmail(e.target.value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        Will create/update subscriber if doesn't exist. Name will be extracted from email.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <Label htmlFor="subscriber-id">User ID</Label>
                      <Input
                        id="subscriber-id"
                        placeholder="Enter user/account ID"
                        value={subscriberId}
                        onChange={(e) => setSubscriberId(e.target.value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        The Supabase user ID of the recipient
                      </p>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Payload Data (Optional)</CardTitle>
              <CardDescription>
                Step 2: Define the data to send with this notification
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="payload">JSON Payload</Label>
                <Textarea
                  id="payload"
                  placeholder={
                    broadcast
                      ? '{"announcement": "New feature!", "action_url": "/features"}'
                      : '{"first_name": "{{first_name}}", "message": "Hello {{name}}!"}'
                  }
                  value={payload}
                  onChange={(e) => setPayload(e.target.value)}
                  rows={10}
                  className="font-mono text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  {broadcast
                    ? "This payload is sent to all subscribers. Use Novu template variables for personalization."
                    : "Template variables like {{name}} will be replaced with actual user data."}
                </p>
              </div>

              <Button
                onClick={handleTrigger}
                disabled={
                  triggerWorkflowMutation.isPending ||
                  !workflowId ||
                  (!broadcast && !useEmail && !subscriberId) ||
                  (!broadcast && useEmail && !subscriberEmail)
                }
                size="lg"
                className="w-full"
              >
                {triggerWorkflowMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Sending...
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4" />
                    {broadcast ? "Send to All Subscribers" : "Send Notification"}
                  </>
                )}
              </Button>
            </CardContent>
          </Card>

        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Template Variables</CardTitle>
              <CardDescription className="text-xs">
                {broadcast 
                  ? "Use in Novu workflow templates"
                  : "Use in payload (replaced with real data)"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!broadcast ? (
                <div className="space-y-3">
                  <div className="space-y-2">
                    <code className="text-xs px-2 py-1 bg-muted rounded">{"{{email}}"}</code>
                    <p className="text-xs text-muted-foreground">User's email</p>
                  </div>
                  <div className="space-y-2">
                    <code className="text-xs px-2 py-1 bg-muted rounded">{"{{name}}"}</code>
                    <p className="text-xs text-muted-foreground">Full name</p>
                  </div>
                  <div className="space-y-2">
                    <code className="text-xs px-2 py-1 bg-muted rounded">{"{{first_name}}"}</code>
                    <p className="text-xs text-muted-foreground">First name</p>
                  </div>
                  <div className="space-y-2">
                    <code className="text-xs px-2 py-1 bg-muted rounded">{"{{phone}}"}</code>
                    <p className="text-xs text-muted-foreground">Phone number</p>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-xs text-muted-foreground mb-2">
                    Novu automatically personalizes using subscriber data:
                  </p>
                  <div className="space-y-2">
                    <code className="text-xs px-2 py-1 bg-muted rounded block">{"{{subscriber.firstName}}"}</code>
                    <code className="text-xs px-2 py-1 bg-muted rounded block">{"{{subscriber.lastName}}"}</code>
                    <code className="text-xs px-2 py-1 bg-muted rounded block">{"{{subscriber.email}}"}</code>
                    <code className="text-xs px-2 py-1 bg-muted rounded block">{"{{subscriber.phone}}"}</code>
                  </div>
                  <p className="text-xs text-muted-foreground mt-3">
                    Use these in your Novu email/SMS template, not in the payload.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          {broadcast && (
            <Collapsible>
              <Card>
                <CardHeader>
                  <CollapsibleTrigger className="w-full">
                    <div className="flex items-center justify-between">
                      <div className="text-left">
                        <CardTitle className="text-base">Broadcast Example</CardTitle>
                        <CardDescription className="text-xs">
                          See how personalization works
                        </CardDescription>
                      </div>
                      <ChevronDown className="h-4 w-4 transition-transform shrink-0" />
                    </div>
                  </CollapsibleTrigger>
                </CardHeader>
                <CollapsibleContent>
                  <CardContent className="space-y-4">
                    <div className="space-y-2">
                      <p className="text-xs font-medium">Novu Template:</p>
                      <pre className="p-2 bg-muted rounded text-[10px] overflow-x-auto">
{`Hello {{subscriber.firstName}},

{{payload.message}}

{{payload.action_url}}`}
                      </pre>
                    </div>

                    <div className="space-y-2">
                      <p className="text-xs font-medium">Your Payload:</p>
                      <pre className="p-2 bg-muted rounded text-[10px]">
{`{
  "message": "New feature!",
  "action_url": "/features"
}`}
                      </pre>
                    </div>

                    <div className="space-y-2">
                      <p className="text-xs font-medium">Result:</p>
                      <div className="space-y-2">
                        <div className="p-2 bg-muted rounded text-[10px]">
                          <p className="font-medium">John receives:</p>
                          <pre className="text-muted-foreground mt-1">Hello John,

New feature!

/features</pre>
                        </div>
                        <div className="p-2 bg-muted rounded text-[10px]">
                          <p className="font-medium">Jane receives:</p>
                          <pre className="text-muted-foreground mt-1">Hello Jane,

New feature!

/features</pre>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </CollapsibleContent>
              </Card>
            </Collapsible>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Quick Tips</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-xs text-muted-foreground">
              <div className="flex gap-2">
                <span className="text-primary">•</span>
                <span>Workflows must be created in Novu dashboard first</span>
              </div>
              <div className="flex gap-2">
                <span className="text-primary">•</span>
                <span>Payload must be valid JSON format</span>
              </div>
              <div className="flex gap-2">
                <span className="text-primary">•</span>
                <span>Use email to auto-create subscribers (name extracted from email)</span>
              </div>
              <div className="flex gap-2">
                <span className="text-primary">•</span>
                <span>Broadcasts send to all active subscribers</span>
              </div>
              <div className="flex gap-2">
                <span className="text-primary">•</span>
                <span>Single user mode accepts ID or email address</span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
