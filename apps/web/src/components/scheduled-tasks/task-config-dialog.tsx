"use client";

import React, { useState, useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Calendar, ArrowRight, ArrowLeft, Loader2, Timer, Webhook, MessageSquare, Terminal, Globe, Ticket as TicketIcon } from 'lucide-react';
import {
  useCreateTrigger,
  type SessionMode,
  type TriggerType,
  type ActionType,
} from '@/hooks/scheduled-tasks';
import { useSandbox } from '@/hooks/platform/use-sandbox';
import { getSandboxUrl } from '@/lib/platform-client';
import { toast } from 'sonner';
import { ScheduleBuilder } from './schedule-builder';
import { cn } from '@/lib/utils';
import { useTickets, useColumns, useProjectAgents } from '@/hooks/kortix/use-kortix-tickets';

// Shared selectors from ChatInput (same as used in channels)
import { AgentSelector, flattenModels } from '@/components/session/session-chat-input';
import { ModelSelector } from '@/components/session/model-selector';
import { useVisibleAgents, useOpenCodeProviders } from '@/hooks/opencode/use-opencode-sessions';

interface TaskConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
  /** Scope the new trigger to a project — shows up in that project's Triggers tab. */
  projectId?: string;
  /** Pre-select a ticket to bind. Only meaningful when `projectId` is set. */
  defaultTicketId?: string;
}

const TIMEZONES = [
  'UTC', 'America/New_York', 'America/Chicago', 'America/Denver',
  'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Europe/Paris',
  'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Kolkata', 'Australia/Sydney',
];

type Step = 'source' | 'action' | 'config';

export function TaskConfigDialog({ open, onOpenChange, onCreated, projectId, defaultTicketId }: TaskConfigDialogProps) {
  const [step, setStep] = useState<Step>('source');

  // Source
  const [sourceType, setSourceType] = useState<TriggerType>('cron');
  const [cronExpr, setCronExpr] = useState('0 0 9 * * *');
  const [timezone, setTimezone] = useState('UTC');
  const [webhookPath, setWebhookPath] = useState('/hooks/');
  const [webhookSecret, setWebhookSecret] = useState('');

  // Action
  const [actionType, setActionType] = useState<ActionType>('prompt');

  // Prompt action
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [sessionMode, setSessionMode] = useState<SessionMode>('new');
  const [agentName, setAgentName] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<{ providerID: string; modelID: string } | null>(null);

  // Command action
  const [command, setCommand] = useState('');
  const [commandArgs, setCommandArgs] = useState('');
  const [workdir, setWorkdir] = useState('');

  // HTTP action
  const [httpUrl, setHttpUrl] = useState('');
  const [httpMethod, setHttpMethod] = useState('POST');
  const [httpBody, setHttpBody] = useState('');

  // ticket_create action (only usable when scoped to a project — the new
  // ticket lands in that project)
  const [newTicketTitle, setNewTicketTitle] = useState('');
  const [newTicketBody, setNewTicketBody] = useState('');
  const [newTicketColumn, setNewTicketColumn] = useState<string>('');
  const [newTicketAssignees, setNewTicketAssignees] = useState<string>(''); // comma-separated slugs

  // Optional ticket binding (only surfaces when scoped to a project)
  const [ticketId, setTicketId] = useState<string>(defaultTicketId ?? '');
  const { data: projectTickets = [] } = useTickets(projectId, { enabled: !!projectId });
  const { data: projectColumns = [] } = useColumns(projectId);
  const { data: projectAgents = [] } = useProjectAgents(projectId);

  const { sandbox } = useSandbox();
  const createMutation = useCreateTrigger();

  // Build the public webhook base URL
  const webhookBaseUrl = useMemo(() => {
    try {
      if (sandbox) return getSandboxUrl(sandbox);
    } catch {}
    return 'https://<sandbox-url>';
  }, [sandbox]);

  // Use the same hooks as ChatInput / channels for agents + models
  const agents = useVisibleAgents();
  const { data: providers, isLoading: modelsLoading } = useOpenCodeProviders();
  const models = useMemo(() => flattenModels(providers), [providers]);

  const handleClose = () => {
    setStep('source');
    setSourceType('cron');
    setCronExpr('0 0 9 * * *');
    setTimezone('UTC');
    setWebhookPath('/hooks/');
    setWebhookSecret('');
    setActionType('prompt');
    setName('');
    setPrompt('');
    setSessionMode('new');
    setAgentName(null);
    setSelectedModel(null);
    setCommand('');
    setCommandArgs('');
    setWorkdir('');
    setHttpUrl('');
    setHttpMethod('POST');
    setHttpBody('');
    setNewTicketTitle('');
    setNewTicketBody('');
    setNewTicketColumn('');
    setNewTicketAssignees('');
    setTicketId(defaultTicketId ?? '');
    onOpenChange(false);
  };

  const handleCreate = async () => {
    const source: any = { type: sourceType };
    if (sourceType === 'cron') {
      source.cron_expr = cronExpr.trim();
      source.timezone = timezone;
    } else {
      source.path = webhookPath.trim();
      source.method = 'POST';
      if (webhookSecret) source.secret = webhookSecret;
    }

    const action: any = { type: actionType };
    if (actionType === 'prompt') {
      action.prompt = prompt.trim();
      action.session_mode = sessionMode;
      if (agentName) action.agent = agentName;
      if (selectedModel) action.model = `${selectedModel.providerID}/${selectedModel.modelID}`;
    } else if (actionType === 'command') {
      action.command = command.trim();
      if (commandArgs.trim()) {
        try { action.args = JSON.parse(commandArgs.trim()); }
        catch { action.args = commandArgs.trim().split(/\s+/); }
      }
      if (workdir.trim()) action.workdir = workdir.trim();
    } else if (actionType === 'http') {
      action.url = httpUrl.trim();
      action.method = httpMethod;
      if (httpBody.trim()) action.body_template = httpBody.trim();
    } else if (actionType === 'ticket_create') {
      action.title = newTicketTitle.trim();
      if (newTicketBody.trim()) action.body_md = newTicketBody.trim();
      if (newTicketColumn) action.column = newTicketColumn;
      const slugs = newTicketAssignees.split(',').map((s) => s.trim()).filter(Boolean);
      if (slugs.length) action.assignee_slugs = slugs;
    }

    try {
      await createMutation.mutateAsync({
        name: name.trim(),
        source,
        action,
        ...(projectId ? { project_id: projectId } : {}),
        ...(ticketId ? { ticket_id: ticketId } : {}),
      });
      toast.success('Trigger created');
      handleClose();
      onCreated?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create trigger');
    }
  };

  const isValid = (): boolean => {
    if (!name.trim()) return false;
    if (sourceType === 'cron' && !cronExpr.trim()) return false;
    if (sourceType === 'webhook' && !webhookPath.trim()) return false;
    if (actionType === 'prompt' && !prompt.trim()) return false;
    if (actionType === 'command' && !command.trim()) return false;
    if (actionType === 'http' && !httpUrl.trim()) return false;
    if (actionType === 'ticket_create' && (!newTicketTitle.trim() || !projectId)) return false;
    return true;
  };

  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <div className="flex items-center justify-center w-8 h-8 rounded-xl bg-primary/10">
              <Calendar className="h-4 w-4 text-primary" />
            </div>
            Create Trigger
          </DialogTitle>
          <DialogDescription>
            {step === 'source' && 'Choose when this trigger should fire.'}
            {step === 'action' && 'Choose what happens when the trigger fires.'}
            {step === 'config' && 'Configure the details.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto -mx-6 px-6 py-1">
          {/* ─── Step 1: Source Type ──────────────────────────────── */}
          {step === 'source' && (
            <div className="space-y-4">
              <Label>Trigger Source</Label>
              <div className="grid grid-cols-2 gap-3">
                <Button
                  type="button"
                  onClick={() => setSourceType('cron')}
                  variant="outline"
                  className={cn("flex flex-col items-center gap-2 p-4 h-auto rounded-xl border-2", sourceType === 'cron'
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-primary/50 hover:bg-muted/30"
                 )}
                >
                  <Timer className="h-6 w-6" />
                  <div className="text-sm font-medium">Cron Schedule</div>
                  <div className="text-xs text-muted-foreground text-center">Runs on a time-based schedule</div>
                </Button>
                <Button
                  type="button"
                  onClick={() => setSourceType('webhook')}
                  variant="outline"
                  className={cn("flex flex-col items-center gap-2 p-4 h-auto rounded-xl border-2", sourceType === 'webhook'
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-primary/50 hover:bg-muted/30"
                 )}
                >
                  <Webhook className="h-6 w-6" />
                  <div className="text-sm font-medium">Webhook</div>
                  <div className="text-xs text-muted-foreground text-center">Fires when an HTTP request is received</div>
                </Button>
              </div>

              {/* Source config */}
              {sourceType === 'cron' && (
                <div className="space-y-3 pt-2">
                  <div className="space-y-2">
                    <Label>Schedule</Label>
                    <ScheduleBuilder value={cronExpr} onChange={setCronExpr} />
                  </div>
                  <div className="space-y-2">
                    <Label>Timezone</Label>
                    <Select value={timezone} onValueChange={setTimezone}>
                      <SelectTrigger className="cursor-pointer rounded-xl hover:bg-muted/40 transition-colors">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TIMEZONES.map((tz) => (
                          <SelectItem key={tz} value={tz} className="cursor-pointer">{tz}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}

              {sourceType === 'webhook' && (
                <div className="space-y-3 pt-2">
                  <div className="space-y-2">
                    <Label>Path</Label>
                    <Input type="text" value={webhookPath} onChange={(e) => setWebhookPath(e.target.value)} placeholder="/hooks/my-endpoint" className="rounded-xl" />
                  </div>

                   {/* Full URL preview */}
                  <div className="rounded-xl bg-muted/50 border p-3 space-y-1.5">
                    <div className="text-xs font-medium text-muted-foreground">External URL</div>
                    <code className="text-xs font-mono text-foreground break-all block">
                      {webhookBaseUrl}{webhookPath || '/hooks/...'}
                    </code>
                    <p className="text-xs text-muted-foreground mt-1">
                      Send a <span className="font-mono">POST</span> request to this URL to fire the trigger.
                      {webhookSecret ? ' Include the secret in the ' : ' Optionally protect with a secret via '}
                      <code className="text-xs font-mono">X-Kortix-Trigger-Secret</code> header.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label>Secret (optional)</Label>
                    <Input value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} placeholder="shared-secret" type="password" className="rounded-xl" />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ─── Step 2: Action Type ─────────────────────────────── */}
          {step === 'action' && (
            <div className="space-y-4">
              <Label>Action Type</Label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Button
                  type="button"
                  onClick={() => setActionType('prompt')}
                  variant="outline"
                  className={cn("flex flex-col items-center gap-2 p-4 h-auto rounded-xl border-2", actionType === 'prompt'
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-primary/50 hover:bg-muted/30"
                 )}
                >
                  <MessageSquare className="h-5 w-5" />
                  <div className="text-sm font-medium">Prompt</div>
                  <div className="text-xs text-muted-foreground text-center">Send to AI agent</div>
                </Button>
                <Button
                  type="button"
                  onClick={() => setActionType('command')}
                  variant="outline"
                  className={cn("flex flex-col items-center gap-2 p-4 h-auto rounded-xl border-2", actionType === 'command'
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-primary/50 hover:bg-muted/30"
                 )}
                >
                  <Terminal className="h-5 w-5" />
                  <div className="text-sm font-medium">Command</div>
                  <div className="text-xs text-muted-foreground text-center">Run shell command</div>
                </Button>
                <Button
                  type="button"
                  onClick={() => setActionType('http')}
                  variant="outline"
                  className={cn("flex flex-col items-center gap-2 p-4 h-auto rounded-xl border-2", actionType === 'http'
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-primary/50 hover:bg-muted/30"
                 )}
                >
                  <Globe className="h-5 w-5" />
                  <div className="text-sm font-medium">HTTP</div>
                  <div className="text-xs text-muted-foreground text-center">Call external URL</div>
                </Button>
                <Button
                  type="button"
                  onClick={() => setActionType('ticket_create')}
                  disabled={!projectId}
                  variant="outline"
                  title={!projectId ? 'Only available when the trigger is scoped to a project' : undefined}
                  className={cn("flex flex-col items-center gap-2 p-4 h-auto rounded-xl border-2", actionType === 'ticket_create'
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-primary/50 hover:bg-muted/30",
                    !projectId && "opacity-50 cursor-not-allowed")}
                >
                  <TicketIcon className="h-5 w-5" />
                  <div className="text-sm font-medium">Create Ticket</div>
                  <div className="text-xs text-muted-foreground text-center">Drop a new ticket on the board</div>
                </Button>
              </div>
            </div>
          )}

          {/* ─── Step 3: Configure ───────────────────────────────── */}
          {step === 'config' && (
            <div className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="task-name">Name</Label>
                <Input type="text" id="task-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Daily Report" className="rounded-xl" />
              </div>

              {/* Ticket binding — only when scoped to a project. Binding makes
                  the ticket the running review thread: every fire threads onto
                  the same session and the agent sees ticket_id in its event. */}
              {projectId && projectTickets.length > 0 && (
                <div className="space-y-2">
                  <Label>Bind to ticket (optional)</Label>
                  <Select value={ticketId || '__none__'} onValueChange={(v) => setTicketId(v === '__none__' ? '' : v)}>
                    <SelectTrigger className="cursor-pointer rounded-xl hover:bg-muted/40 transition-colors">
                      <SelectValue placeholder="No ticket" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__" className="cursor-pointer text-muted-foreground">No ticket — generic project trigger</SelectItem>
                      {projectTickets.map((t) => (
                        <SelectItem key={t.id} value={t.id} className="cursor-pointer">
                          #{t.number} · {t.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Each fire threads onto one session per ticket — the agent sees prior fires and can post <code className="font-mono">ticket_comment</code> status updates.
                  </p>
                </div>
              )}

              {actionType === 'prompt' && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="task-prompt">Prompt</Label>
                    <Textarea
                      id="task-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)}
                      placeholder="Generate the daily status report and save it to /workspace/reports/"
                      rows={4}
                      className="rounded-xl"
                    />
                    <p className="text-xs text-muted-foreground">The instruction sent to your agent on each run</p>
                  </div>

                  <div className="space-y-2">
                    <Label>Session Mode</Label>
                    <Select value={sessionMode} onValueChange={(v) => setSessionMode(v as SessionMode)}>
                      <SelectTrigger className="cursor-pointer rounded-xl hover:bg-muted/40 transition-colors">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="new" className="cursor-pointer">New Session</SelectItem>
                        <SelectItem value="reuse" className="cursor-pointer">Reuse Session</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Agent — shared CommandPopover component from ChatInput */}
                  <div className="space-y-2">
                    <Label>Agent</Label>
                    <div className="rounded-xl border bg-card px-2 py-1">
                      <AgentSelector
                        agents={agents}
                        selectedAgent={agentName}
                        onSelect={(next) => setAgentName(next)}
                      />
                    </div>
                  </div>

                  {/* Model — shared CommandPopover component from ChatInput */}
                  <div className="space-y-2">
                    <Label>Model</Label>
                    {modelsLoading ? (
                      <div className="flex items-center gap-2 h-9 px-3 text-sm text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" /> Loading models...
                      </div>
                    ) : (
                      <div className="rounded-xl border bg-card px-2 py-1">
                        <ModelSelector
                          models={models}
                          selectedModel={selectedModel}
                          onSelect={(next) => setSelectedModel(next)}
                        />
                      </div>
                    )}
                  </div>
                </>
              )}

              {actionType === 'command' && (
                <>
                  <div className="space-y-2">
                    <Label>Command</Label>
                    <Input type="text" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="bash" className="rounded-xl" />
                  </div>
                  <div className="space-y-2">
                    <Label>Arguments</Label>
                    <Input type="text" value={commandArgs} onChange={(e) => setCommandArgs(e.target.value)} placeholder='["-c", "./scripts/backup.sh"]' className="rounded-xl" />
                    <p className="text-xs text-muted-foreground">JSON array or space-separated</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Working Directory (optional)</Label>
                    <Input type="text" value={workdir} onChange={(e) => setWorkdir(e.target.value)} placeholder="/workspace" className="rounded-xl" />
                  </div>
                </>
              )}

              {actionType === 'http' && (
                <>
                  <div className="space-y-2">
                    <Label>URL</Label>
                    <Input type="text" value={httpUrl} onChange={(e) => setHttpUrl(e.target.value)} placeholder="https://hooks.slack.com/services/XXX" className="rounded-xl" />
                  </div>
                  <div className="space-y-2">
                    <Label>Method</Label>
                    <Select value={httpMethod} onValueChange={setHttpMethod}>
                      <SelectTrigger className="cursor-pointer rounded-xl hover:bg-muted/40 transition-colors">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="POST" className="cursor-pointer">POST</SelectItem>
                        <SelectItem value="GET" className="cursor-pointer">GET</SelectItem>
                        <SelectItem value="PUT" className="cursor-pointer">PUT</SelectItem>
                        <SelectItem value="PATCH" className="cursor-pointer">PATCH</SelectItem>
                        <SelectItem value="DELETE" className="cursor-pointer">DELETE</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Body Template (optional)</Label>
                    <Textarea value={httpBody} onChange={(e) => setHttpBody(e.target.value)} placeholder='{"text": "Alert: {{ message }}"}' rows={3} className="rounded-xl" />
                    <p className="text-xs text-muted-foreground">{'Use {{ var }} for template variables from webhook payloads'}</p>
                  </div>
                </>
              )}

              {actionType === 'ticket_create' && (
                <>
                  <div className="space-y-2">
                    <Label>Ticket title</Label>
                    <Input
                      type="text"
                      value={newTicketTitle}
                      onChange={(e) => setNewTicketTitle(e.target.value)}
                      placeholder="{{ summary }} — {{ source }}"
                      className="rounded-xl"
                    />
                    <p className="text-xs text-muted-foreground">{'Supports {{ var }} substitution from webhook payloads.'}</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Body (optional)</Label>
                    <Textarea
                      value={newTicketBody}
                      onChange={(e) => setNewTicketBody(e.target.value)}
                      rows={3}
                      placeholder="From {{ user }}:\n\n{{ text }}"
                      className="rounded-xl"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label>Land in column</Label>
                      <Select value={newTicketColumn || '__default__'} onValueChange={(v) => setNewTicketColumn(v === '__default__' ? '' : v)}>
                        <SelectTrigger className="cursor-pointer rounded-xl hover:bg-muted/40 transition-colors">
                          <SelectValue placeholder="Backlog (default)" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__default__" className="cursor-pointer text-muted-foreground">First column (default)</SelectItem>
                          {projectColumns.map((c) => (
                            <SelectItem key={c.key} value={c.key} className="cursor-pointer">{c.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Assign to</Label>
                      <Input
                        type="text"
                        value={newTicketAssignees}
                        onChange={(e) => setNewTicketAssignees(e.target.value)}
                        placeholder="engineer,qa"
                        className="rounded-xl font-mono text-[13px]"
                      />
                      <p className="text-[11px] text-muted-foreground">
                        Comma-separated agent slugs.
                        {projectAgents.length > 0 && (
                          <> Available: {projectAgents.map((a) => a.slug).join(', ')}</>
                        )}
                      </p>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* ─── Footer ────────────────────────────────────────────── */}
        <div className="flex justify-between gap-3 pt-4 shrink-0 border-t mt-2">
          <div>
            {step !== 'source' && (
              <Button variant="ghost" size="sm" onClick={() => setStep(step === 'config' ? 'action' : 'source')} className="cursor-pointer rounded-xl">
                <ArrowLeft className="h-4 w-4 mr-1" /> Back
              </Button>
            )}
          </div>
          <div className="flex gap-3">
            <Button variant="outline" size="sm" onClick={handleClose} className="cursor-pointer ">Cancel</Button>
            {step === 'source' && (
              <Button size="sm" onClick={() => setStep('action')} className="cursor-pointer rounded-xl">
                Next <ArrowRight className="h-4 w-4 ml-1" />
              </Button>
            )}
            {step === 'action' && (
              <Button size="sm" onClick={() => setStep('config')} className="cursor-pointer rounded-xl">
                Next <ArrowRight className="h-4 w-4 ml-1" />
              </Button>
            )}
            {step === 'config' && (
              <Button size="sm" onClick={handleCreate} disabled={!isValid() || createMutation.isPending} className="cursor-pointer ">
                {createMutation.isPending ? 'Creating...' : 'Create Trigger'}
                <ArrowRight className="h-4 w-4 ml-2" />
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
