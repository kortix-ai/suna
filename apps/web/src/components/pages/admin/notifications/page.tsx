"use client";

import { useTranslations } from 'next-intl';

import { useState } from "react";
import { useTriggerWorkflow, useWorkflows } from "@/hooks/admin/use-notification-workflow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Send, Users, User, ChevronDown, Sparkles } from "lucide-react";
import { KortixLoader } from '@/components/ui/kortix-loader';
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
import { toast } from "@/lib/toast";
import { Badge } from "@/components/ui/badge";
import { LegacyBanner } from "@/components/admin/legacy-banner";

export default function NotificationManagementPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
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
    <div className="flex flex-col h-screen">
      <div className="max-w-6xl mx-auto px-6 pt-6 w-full">
        <LegacyBanner feature="Notifications" />
      </div>
      <div className="flex-none backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="max-w-6xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-semibold tracking-tight">{tHardcodedUi.raw('componentsPagesAdminNotificationsPage.line103JsxTextNotificationManagement')}</h1>
                <Badge variant="outline" className="text-xs">
                  {broadcast ? (
                    <><Users className="w-3 h-3 mr-1" />Broadcast</>
                  ) : (
                    <><User className="w-3 h-3 mr-1" />{tHardcodedUi.raw('componentsPagesAdminNotificationsPage.line108JsxTextSingleUser')}</>
                  )}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">{tHardcodedUi.raw('componentsPagesAdminNotificationsPage.line113JsxTextSendNotificationsViaNovuWorkflows')}</p>
            </div>
            <Button
              onClick={handleTrigger}
              disabled={
                triggerWorkflowMutation.isPending ||
                !workflowId ||
                (!broadcast && !useEmail && !subscriberId) ||
                (!broadcast && useEmail && !subscriberEmail)
              }
              size="default"
              className="gap-2 min-w-[120px]"
            >
              {triggerWorkflowMutation.isPending ? (
                <>
                  <KortixLoader size="small" />
                  Sending...
                </>
              ) : (
                <>
                  <Send className="w-4 h-4" />
                  {broadcast ? "Broadcast" : "Send"}
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        <div className="max-w-6xl mx-auto px-6 h-full flex gap-6 py-6">
          <div className="flex-1 overflow-y-auto space-y-4 pr-4">
            <div className="flex items-center gap-3 p-4 border rounded-2xl bg-card">
              <div className="flex items-center gap-2">
                <User className="w-4 h-4 text-muted-foreground" />
                <span className="text-sm font-medium">{tHardcodedUi.raw('componentsPagesAdminNotificationsPage.line148JsxTextSingleUser')}</span>
              </div>
              <Switch
                checked={broadcast}
                onCheckedChange={setBroadcast}
                className="data-[state=checked]:bg-primary"
              />
              <div className="flex items-center gap-2">
                <Users className="w-4 h-4 text-muted-foreground" />
                <span className="text-sm font-medium">{tHardcodedUi.raw('componentsPagesAdminNotificationsPage.line157JsxTextBroadcastAll')}</span>
              </div>
            </div>

            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <div className="flex items-center justify-center w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs font-medium">
                    1
                  </div>
                  <div>
                    <CardTitle className="text-base">{tHardcodedUi.raw('componentsPagesAdminNotificationsPage.line168JsxTextSelectWorkflow')}</CardTitle>
                    <CardDescription className="text-xs">{tHardcodedUi.raw('componentsPagesAdminNotificationsPage.line170JsxTextChooseFromYourNovuWorkflows')}</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <Select value={workflowId} onValueChange={setWorkflowId}>
                  <SelectTrigger>
                    <SelectValue placeholder={loadingWorkflows ? "Loading..." : "Select a workflow"} />
                  </SelectTrigger>
                  <SelectContent>
                    {loadingWorkflows ? (
                      <SelectItem value="loading" disabled>
                        <div className="flex items-center gap-2">
                          <KortixLoader size="small" />{tHardcodedUi.raw('componentsPagesAdminNotificationsPage.line185JsxTextLoadingWorkflows')}</div>
                      </SelectItem>
                    ) : workflows.length === 0 ? (
                      <SelectItem value="none" disabled>{tHardcodedUi.raw('componentsPagesAdminNotificationsPage.line190JsxTextNoWorkflowsFound')}</SelectItem>
                    ) : (
                      workflows.map((workflow) => (
                        <SelectItem key={workflow.workflow_id} value={workflow.workflow_id}>
                          {workflow.name}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
                {selectedWorkflow && (
                  <div className="space-y-2">
                    {selectedWorkflow.description && (
                      <p className="text-xs text-muted-foreground">{selectedWorkflow.description}</p>
                    )}
                    {selectedWorkflow.tags.length > 0 && (
                      <div className="flex gap-1 flex-wrap">
                        {selectedWorkflow.tags.map((tag, i) => (
                          <Badge key={i} variant="secondary" className="text-xs">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            {!broadcast && (
              <Card>
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <div className="flex items-center justify-center w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs font-medium">
                      2
                    </div>
                    <div>
                      <CardTitle className="text-base">{tHardcodedUi.raw('componentsPagesAdminNotificationsPage.line228JsxTextTargetRecipient')}</CardTitle>
                      <CardDescription className="text-xs">{tHardcodedUi.raw('componentsPagesAdminNotificationsPage.line230JsxTextWhoShouldReceiveThisNotification')}</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between p-3 bg-muted/50 rounded-2xl">
                    <span className="text-sm font-medium">{tHardcodedUi.raw('componentsPagesAdminNotificationsPage.line237JsxTextTargetBy')}</span>
                    <div className="flex items-center gap-3">
                      <span className="text-sm text-muted-foreground">{tHardcodedUi.raw('componentsPagesAdminNotificationsPage.line239JsxTextUserId')}</span>
                      <Switch
                        checked={useEmail}
                        onCheckedChange={setUseEmail}
                      />
                      <span className="text-sm text-muted-foreground">Email</span>
                    </div>
                  </div>

                  {useEmail ? (
                    <div className="space-y-2">
                      <Label htmlFor="subscriber-email">{tHardcodedUi.raw('componentsPagesAdminNotificationsPage.line250JsxTextEmailAddress')}</Label>
                      <Input
                        id="subscriber-email"
                        type="email"
                        placeholder={tHardcodedUi.raw('componentsPagesAdminNotificationsPage.line254JsxAttrPlaceholderUserExampleCom')}
                        value={subscriberEmail}
                        onChange={(e) => setSubscriberEmail(e.target.value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        <Sparkles className="w-3 h-3 inline mr-1" />{tHardcodedUi.raw('componentsPagesAdminNotificationsPage.line260JsxTextAutoCreatesSubscriberIfDoesnTExist')}</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <Label htmlFor="subscriber-id">{tHardcodedUi.raw('componentsPagesAdminNotificationsPage.line265JsxTextUserId')}</Label>
                      <Input type="text"
                        id="subscriber-id"
                        placeholder={tHardcodedUi.raw('componentsPagesAdminNotificationsPage.line268JsxAttrPlaceholderEnterUserAccountId')}
                        value={subscriberId}
                        onChange={(e) => setSubscriberId(e.target.value)}
                      />
                      <p className="text-xs text-muted-foreground">{tHardcodedUi.raw('componentsPagesAdminNotificationsPage.line273JsxTextTheSupabaseUserIdOfTheRecipient')}</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <div className="flex items-center justify-center w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs font-medium">
                    {broadcast ? "2" : "3"}
                  </div>
                  <div>
                    <CardTitle className="text-base">{tHardcodedUi.raw('componentsPagesAdminNotificationsPage.line288JsxTextPayloadDataOptional')}</CardTitle>
                    <CardDescription className="text-xs">{tHardcodedUi.raw('componentsPagesAdminNotificationsPage.line290JsxTextCustomDataToSendWithTheNotification')}</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <Textarea
                  id="payload"
                  placeholder={
                    broadcast
                      ? '{"announcement": "New feature!", "action_url": "/features"}'
                      : '{"message": "Hello {{name}}!"}'
                  }
                  value={payload}
                  onChange={(e) => setPayload(e.target.value)}
                  rows={12}
                  className="font-mono text-xs"
                />
                <p className="text-xs text-muted-foreground">
                  {broadcast
                    ? "Use subscriber.* variables in your Novu template for personalization"
                    : "Template variables like {{name}} will be replaced with actual user data"}
                </p>
              </CardContent>
            </Card>
          </div>

          <div className="w-[380px] flex-none overflow-y-auto space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">
                  {broadcast ? "Broadcast Variables" : "Template Variables"}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {!broadcast ? (
                  <div className="space-y-2">
                    <div className="space-y-1">
                      <code className="text-xs px-2 py-1 bg-muted rounded block">{"{{email}}"}</code>
                      <p className="text-xs text-muted-foreground pl-2">{tHardcodedUi.raw('componentsPagesAdminNotificationsPage.line329JsxTextUserSEmail')}</p>
                    </div>
                    <div className="space-y-1">
                      <code className="text-xs px-2 py-1 bg-muted rounded block">{"{{name}}"}</code>
                      <p className="text-xs text-muted-foreground pl-2">{tHardcodedUi.raw('componentsPagesAdminNotificationsPage.line333JsxTextFullName')}</p>
                    </div>
                    <div className="space-y-1">
                      <code className="text-xs px-2 py-1 bg-muted rounded block">{"{{first_name}}"}</code>
                      <p className="text-xs text-muted-foreground pl-2">{tHardcodedUi.raw('componentsPagesAdminNotificationsPage.line337JsxTextFirstName')}</p>
                    </div>
                    <div className="space-y-1">
                      <code className="text-xs px-2 py-1 bg-muted rounded block">{"{{phone}}"}</code>
                      <p className="text-xs text-muted-foreground pl-2">Phone</p>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground mb-2">{tHardcodedUi.raw('componentsPagesAdminNotificationsPage.line347JsxTextUseInNovuTemplate')}</p>
                    <code className="text-xs px-2 py-1 bg-muted rounded block">{"{{subscriber.firstName}}"}</code>
                    <code className="text-xs px-2 py-1 bg-muted rounded block">{"{{subscriber.lastName}}"}</code>
                    <code className="text-xs px-2 py-1 bg-muted rounded block">{"{{subscriber.email}}"}</code>
                    <code className="text-xs px-2 py-1 bg-muted rounded block">{"{{subscriber.phone}}"}</code>
                    <p className="text-xs text-muted-foreground mt-3">{tHardcodedUi.raw('componentsPagesAdminNotificationsPage.line354JsxTextPayloadData')}</p>
                    <code className="text-xs px-2 py-1 bg-muted rounded block">{"{{payload.yourKey}}"}</code>
                  </div>
                )}
              </CardContent>
            </Card>

            {broadcast && (
              <Collapsible>
                <Card>
                  <CollapsibleTrigger className="w-full">
                    <CardHeader>
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-sm text-left">Example</CardTitle>
                        <ChevronDown className="h-4 w-4 transition-transform" />
                      </div>
                    </CardHeader>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <CardContent className="space-y-3">
                      <div className="space-y-2">
                        <p className="text-xs font-medium">{tHardcodedUi.raw('componentsPagesAdminNotificationsPage.line376JsxTextNovuTemplate')}</p>
                        <pre className="p-2 bg-muted rounded text-xs overflow-x-auto">
{`Hello {{subscriber.firstName}},

{{payload.message}}

{{payload.action_url}}`}
                        </pre>
                      </div>

                      <div className="space-y-2">
                        <p className="text-xs font-medium">{tHardcodedUi.raw('componentsPagesAdminNotificationsPage.line387JsxTextYourPayload')}</p>
                        <pre className="p-2 bg-muted rounded text-xs">
{`{
  "message": "New feature!",
  "action_url": "/features"
}`}
                        </pre>
                      </div>

                      <div className="space-y-2">
                        <p className="text-xs font-medium">Result:</p>
                        <div className="p-2 bg-muted rounded text-xs">
                          <p className="font-medium">{tHardcodedUi.raw('componentsPagesAdminNotificationsPage.line399JsxTextJohnReceives')}</p>
                          <pre className="text-muted-foreground mt-1">{tHardcodedUi.raw('componentsPagesAdminNotificationsPage.line400JsxTextHelloJohnNewFeatureFeatures')}</pre>
                        </div>
                      </div>
                    </CardContent>
                  </CollapsibleContent>
                </Card>
              </Collapsible>
            )}

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">{tHardcodedUi.raw('componentsPagesAdminNotificationsPage.line415JsxTextQuickTips')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-xs text-muted-foreground">
                <div className="flex gap-2">
                  <span className="text-primary">•</span>
                  <span>{tHardcodedUi.raw('componentsPagesAdminNotificationsPage.line420JsxTextCreateWorkflowsInNovuDashboardFirst')}</span>
                </div>
                <div className="flex gap-2">
                  <span className="text-primary">•</span>
                  <span>{tHardcodedUi.raw('componentsPagesAdminNotificationsPage.line424JsxTextPayloadMustBeValidJson')}</span>
                </div>
                <div className="flex gap-2">
                  <span className="text-primary">•</span>
                  <span>{tHardcodedUi.raw('componentsPagesAdminNotificationsPage.line428JsxTextEmailModeAutoCreatesSubscribers')}</span>
                </div>
                <div className="flex gap-2">
                  <span className="text-primary">•</span>
                  <span>{tHardcodedUi.raw('componentsPagesAdminNotificationsPage.line432JsxTextBroadcastsSendToAllActiveSubscribers')}</span>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
