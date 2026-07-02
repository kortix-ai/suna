'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useColumns, useProjectAgents, useTickets } from '@/hooks/kortix/use-kortix-tickets';
import {
  type ActionType,
  type SessionMode,
  type TriggerType,
  useCreateTrigger,
} from '@/hooks/scheduled-tasks';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { featureFlags } from '@kortix/sdk/feature-flags';
import { getSandboxUrl } from '@kortix/sdk/platform-client';
import {
  ArrowLeft,
  ArrowRight,
  Calendar,
  Clock,
  Globe,
  Loader2,
  MessageSquare,
  Terminal,
  Ticket as TicketIcon,
  Timer,
  Webhook,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { ScheduleBuilder } from './schedule-builder';

// Shared selectors from ChatInput (same as used in channels)
import { ModelSelector } from '@/features/session/model-selector';
import { AgentSelector, flattenModels } from '@/features/session/session-chat-input';
import { useOpenCodeProviders, useVisibleAgents } from '@/hooks/opencode/use-opencode-sessions';

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
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Kolkata',
  'Australia/Sydney',
];

type Step = 'source' | 'action' | 'config';

export function TaskConfigDialog({
  open,
  onOpenChange,
  onCreated,
  projectId,
  defaultTicketId,
}: TaskConfigDialogProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
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
  const [selectedModel, setSelectedModel] = useState<{
    providerID: string;
    modelID: string;
  } | null>(null);

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

  const createMutation = useCreateTrigger();

  // Docs/example webhook base shown in the dialog (real per-session sandbox URL
  // is resolved server-side; no client-side sandbox lookup needed).
  const webhookBaseUrl = 'https://<sandbox-url>';

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
        try {
          action.args = JSON.parse(commandArgs.trim());
        } catch {
          action.args = commandArgs.trim().split(/\s+/);
        }
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
      const slugs = newTicketAssignees
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
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
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 p-0 sm:max-w-[540px]">
        <DialogHeader className="border-border/60 shrink-0 space-y-0.5 border-b px-6 pt-6 pb-4">
          <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
            <Calendar className="text-muted-foreground h-3.5 w-3.5" />
            {tHardcodedUi.raw(
              'componentsScheduledTasksTaskConfigDialog.line217JsxTextCreateTrigger',
            )}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground/60 text-xs">
            {step === 'source' && 'Choose when this trigger should fire.'}
            {step === 'action' && 'Choose what happens when the trigger fires.'}
            {step === 'config' && 'Configure the details.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {/* ─── Step 1: Source Type ──────────────────────────────── */}
          {step === 'source' && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <div className="text-foreground/40 px-1 text-xs font-semibold tracking-[0.08em] uppercase">
                  {tHardcodedUi.raw(
                    'componentsScheduledTasksTaskConfigDialog.line232JsxTextTriggerSource',
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setSourceType('cron')}
                    className={cn(
                      'group flex h-auto w-full items-start gap-3 rounded-2xl border px-3.5 py-3 text-left transition-colors',
                      sourceType === 'cron'
                        ? 'border-primary/50 bg-primary/[0.04]'
                        : 'border-border/50 bg-muted/20 hover:bg-muted/35',
                    )}
                  >
                    <Timer className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-foreground text-sm font-medium">Cron</div>
                      <div className="text-muted-foreground/60 mt-0.5 text-xs">
                        {tHardcodedUi.raw(
                          'componentsScheduledTasksTaskConfigDialog.line249JsxTextTimeBasedSchedule',
                        )}
                      </div>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setSourceType('webhook')}
                    className={cn(
                      'group flex h-auto w-full items-start gap-3 rounded-2xl border px-3.5 py-3 text-left transition-colors',
                      sourceType === 'webhook'
                        ? 'border-primary/50 bg-primary/[0.04]'
                        : 'border-border/50 bg-muted/20 hover:bg-muted/35',
                    )}
                  >
                    <Webhook className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-foreground text-sm font-medium">Webhook</div>
                      <div className="text-muted-foreground/60 mt-0.5 text-xs">
                        {tHardcodedUi.raw(
                          'componentsScheduledTasksTaskConfigDialog.line267JsxTextFiresOnHttpRequest',
                        )}
                      </div>
                    </div>
                  </button>
                </div>
              </div>

              {/* Source config — timezone moved to the modal footer */}
              {sourceType === 'cron' && (
                <div className="space-y-1.5 pt-1">
                  <div className="text-foreground/40 px-1 text-xs font-semibold tracking-[0.08em] uppercase">
                    Schedule
                  </div>
                  <ScheduleBuilder value={cronExpr} onChange={setCronExpr} />
                </div>
              )}

              {sourceType === 'webhook' && (
                <div className="space-y-3 pt-2">
                  <div className="space-y-2">
                    <Label>Path</Label>
                    <Input
                      type="text"
                      value={webhookPath}
                      onChange={(e) => setWebhookPath(e.target.value)}
                      placeholder="/hooks/my-endpoint"
                    />
                  </div>

                  {/* Full URL preview */}
                  <div className="bg-muted/50 space-y-1.5 rounded-2xl border p-3">
                    <div className="text-muted-foreground text-xs font-medium">
                      {tHardcodedUi.raw(
                        'componentsScheduledTasksTaskConfigDialog.line293JsxTextExternalUrl',
                      )}
                    </div>
                    <code className="text-foreground block font-mono text-xs break-all">
                      {webhookBaseUrl}
                      {webhookPath || '/hooks/...'}
                    </code>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {tHardcodedUi.raw(
                        'componentsScheduledTasksTaskConfigDialog.line298JsxTextSendA',
                      )}
                      <span className="font-mono">POST</span>
                      {tHardcodedUi.raw(
                        'componentsScheduledTasksTaskConfigDialog.line298JsxTextRequestToThisUrlToFireTheTrigger',
                      )}
                      {webhookSecret
                        ? ' Include the secret in the '
                        : ' Optionally protect with a secret via '}
                      <code className="font-mono text-xs">X-Kortix-Trigger-Secret</code> header.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label>
                      {tHardcodedUi.raw(
                        'componentsScheduledTasksTaskConfigDialog.line305JsxTextSecretOptional',
                      )}
                    </Label>
                    <Input
                      value={webhookSecret}
                      onChange={(e) => setWebhookSecret(e.target.value)}
                      placeholder="shared-secret"
                      type="password"
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ─── Step 2: Action Type ─────────────────────────────── */}
          {step === 'action' && (
            <div className="space-y-1.5">
              <div className="text-foreground/40 px-1 text-xs font-semibold tracking-[0.08em] uppercase">
                {tHardcodedUi.raw(
                  'componentsScheduledTasksTaskConfigDialog.line317JsxTextActionType',
                )}
              </div>
              <div className="grid grid-cols-1 gap-2">
                {[
                  {
                    id: 'prompt' as ActionType,
                    icon: MessageSquare,
                    title: 'Prompt',
                    desc: 'Send to an AI agent',
                  },
                  {
                    id: 'command' as ActionType,
                    icon: Terminal,
                    title: 'Command',
                    desc: 'Run a shell command',
                  },
                  {
                    id: 'http' as ActionType,
                    icon: Globe,
                    title: 'HTTP',
                    desc: 'Call an external URL',
                  },
                  // "Create Ticket" — only with the multi-project paradigm
                  // AND when scoped to a project.
                  ...(featureFlags.enableProjects
                    ? [
                        {
                          id: 'ticket_create' as ActionType,
                          icon: TicketIcon,
                          title: 'Create ticket',
                          desc: 'Drop a new ticket on the board',
                          disabled: !projectId,
                          disabledHint: 'Only available when the trigger is scoped to a project',
                        },
                      ]
                    : []),
                ].map((action) => {
                  const Icon = action.icon;
                  const isActive = actionType === action.id;
                  const isDisabled = 'disabled' in action ? action.disabled : false;
                  return (
                    <button
                      key={action.id}
                      type="button"
                      onClick={() => !isDisabled && setActionType(action.id)}
                      disabled={isDisabled}
                      title={
                        isDisabled && 'disabledHint' in action ? action.disabledHint : undefined
                      }
                      className={cn(
                        'group flex h-auto w-full items-center gap-3 rounded-2xl border px-3.5 py-3 text-left transition-colors',
                        isActive
                          ? 'border-primary/50 bg-primary/[0.04]'
                          : 'border-border/50 bg-muted/20 hover:bg-muted/35',
                        isDisabled && 'hover:bg-muted/20 cursor-not-allowed opacity-50',
                      )}
                    >
                      <Icon className="text-muted-foreground h-4 w-4 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="text-foreground text-sm font-medium">{action.title}</div>
                        <div className="text-muted-foreground/60 mt-0.5 text-xs">{action.desc}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* ─── Step 3: Configure ───────────────────────────────── */}
          {step === 'config' && (
            <div className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="task-name">Name</Label>
                <Input
                  type="text"
                  id="task-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={tHardcodedUi.raw(
                    'componentsScheduledTasksTaskConfigDialog.line374JsxAttrPlaceholderDailyReport',
                  )}
                />
              </div>

              {/* Ticket binding — only when scoped to a project. Binding makes
                  the ticket the running review thread: every fire threads onto
                  the same session and the agent sees ticket_id in its event. */}
              {projectId && projectTickets.length > 0 && (
                <div className="space-y-2">
                  <Label>
                    {tHardcodedUi.raw(
                      'componentsScheduledTasksTaskConfigDialog.line382JsxTextBindToTicketOptional',
                    )}
                  </Label>
                  <Select
                    value={ticketId || '__none__'}
                    onValueChange={(v) => setTicketId(v === '__none__' ? '' : v)}
                  >
                    <SelectTrigger className="hover:bg-muted/40 cursor-pointer transition-colors">
                      <SelectValue
                        placeholder={tHardcodedUi.raw(
                          'componentsScheduledTasksTaskConfigDialog.line385JsxAttrPlaceholderNoTicket',
                        )}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__" className="text-muted-foreground cursor-pointer">
                        {tHardcodedUi.raw(
                          'componentsScheduledTasksTaskConfigDialog.line388JsxTextNoTicketGenericProjectTrigger',
                        )}
                      </SelectItem>
                      {projectTickets.map((t) => (
                        <SelectItem key={t.id} value={t.id} className="cursor-pointer">
                          #{t.number} · {t.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-muted-foreground text-xs">
                    {tHardcodedUi.raw(
                      'componentsScheduledTasksTaskConfigDialog.line397JsxTextEachFireThreadsOntoOneSessionPerTicket',
                    )}
                    <code className="font-mono">ticket_comment</code>
                    {tHardcodedUi.raw(
                      'componentsScheduledTasksTaskConfigDialog.line397JsxTextStatusUpdates',
                    )}
                  </p>
                </div>
              )}

              {actionType === 'prompt' && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="task-prompt">Prompt</Label>
                    <Textarea
                      id="task-prompt"
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      placeholder={tHardcodedUi.raw(
                        'componentsScheduledTasksTaskConfigDialog.line408JsxAttrPlaceholderGenerateTheDailyStatusReportAndSaveIt',
                      )}
                      rows={4}
                    />
                    <p className="text-muted-foreground text-xs">
                      {tHardcodedUi.raw(
                        'componentsScheduledTasksTaskConfigDialog.line411JsxTextTheInstructionSentToYourAgentOnEach',
                      )}
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label>
                      {tHardcodedUi.raw(
                        'componentsScheduledTasksTaskConfigDialog.line415JsxTextSessionMode',
                      )}
                    </Label>
                    <Select
                      value={sessionMode}
                      onValueChange={(v) => setSessionMode(v as SessionMode)}
                    >
                      <SelectTrigger className="hover:bg-muted/40 cursor-pointer transition-colors">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="new" className="cursor-pointer">
                          {tHardcodedUi.raw(
                            'componentsScheduledTasksTaskConfigDialog.line421JsxTextNewSession',
                          )}
                        </SelectItem>
                        <SelectItem value="reuse" className="cursor-pointer">
                          {tHardcodedUi.raw(
                            'componentsScheduledTasksTaskConfigDialog.line422JsxTextReuseSession',
                          )}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Agent — shared CommandPopover component from ChatInput */}
                  <div className="space-y-2">
                    <Label>Agent</Label>
                    <div className="bg-card rounded-2xl border px-2 py-1">
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
                      <div className="text-muted-foreground flex h-9 items-center gap-2 px-3 text-sm">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        {tHardcodedUi.raw(
                          'componentsScheduledTasksTaskConfigDialog.line444JsxTextLoadingModels',
                        )}
                      </div>
                    ) : (
                      <div className="bg-card rounded-2xl border px-2 py-1">
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
                    <Input
                      type="text"
                      value={command}
                      onChange={(e) => setCommand(e.target.value)}
                      placeholder="bash"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Arguments</Label>
                    <Input
                      type="text"
                      value={commandArgs}
                      onChange={(e) => setCommandArgs(e.target.value)}
                      placeholder={tHardcodedUi.raw(
                        'componentsScheduledTasksTaskConfigDialog.line467JsxAttrPlaceholderCScriptsBackupSh',
                      )}
                    />
                    <p className="text-muted-foreground text-xs">
                      {tHardcodedUi.raw(
                        'componentsScheduledTasksTaskConfigDialog.line468JsxTextJsonArrayOrSpaceSeparated',
                      )}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label>
                      {tHardcodedUi.raw(
                        'componentsScheduledTasksTaskConfigDialog.line471JsxTextWorkingDirectoryOptional',
                      )}
                    </Label>
                    <Input
                      type="text"
                      value={workdir}
                      onChange={(e) => setWorkdir(e.target.value)}
                      placeholder="/workspace"
                    />
                  </div>
                </>
              )}

              {actionType === 'http' && (
                <>
                  <div className="space-y-2">
                    <Label>URL</Label>
                    <Input
                      type="text"
                      value={httpUrl}
                      onChange={(e) => setHttpUrl(e.target.value)}
                      placeholder="https://hooks.slack.com/services/XXX"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Method</Label>
                    <Select value={httpMethod} onValueChange={setHttpMethod}>
                      <SelectTrigger className="hover:bg-muted/40 cursor-pointer transition-colors">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="POST" className="cursor-pointer">
                          POST
                        </SelectItem>
                        <SelectItem value="GET" className="cursor-pointer">
                          GET
                        </SelectItem>
                        <SelectItem value="PUT" className="cursor-pointer">
                          PUT
                        </SelectItem>
                        <SelectItem value="PATCH" className="cursor-pointer">
                          PATCH
                        </SelectItem>
                        <SelectItem value="DELETE" className="cursor-pointer">
                          DELETE
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>
                      {tHardcodedUi.raw(
                        'componentsScheduledTasksTaskConfigDialog.line499JsxTextBodyTemplateOptional',
                      )}
                    </Label>
                    <Textarea
                      value={httpBody}
                      onChange={(e) => setHttpBody(e.target.value)}
                      placeholder={tHardcodedUi.raw(
                        'componentsScheduledTasksTaskConfigDialog.line500JsxAttrPlaceholderTextAlertMessage',
                      )}
                      rows={3}
                    />
                    <p className="text-muted-foreground text-xs">
                      {'Use {{ var }} for template variables from webhook payloads'}
                    </p>
                  </div>
                </>
              )}

              {actionType === 'ticket_create' && (
                <>
                  <div className="space-y-2">
                    <Label>
                      {tHardcodedUi.raw(
                        'componentsScheduledTasksTaskConfigDialog.line509JsxTextTicketTitle',
                      )}
                    </Label>
                    <Input
                      type="text"
                      value={newTicketTitle}
                      onChange={(e) => setNewTicketTitle(e.target.value)}
                      placeholder={tHardcodedUi.raw(
                        'componentsScheduledTasksTaskConfigDialog.line514JsxAttrPlaceholderSummarySource',
                      )}
                    />
                    <p className="text-muted-foreground text-xs">
                      {'Supports {{ var }} substitution from webhook payloads.'}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label>
                      {tHardcodedUi.raw(
                        'componentsScheduledTasksTaskConfigDialog.line519JsxTextBodyOptional',
                      )}
                    </Label>
                    <Textarea
                      value={newTicketBody}
                      onChange={(e) => setNewTicketBody(e.target.value)}
                      rows={3}
                      placeholder={tHardcodedUi.raw(
                        'componentsScheduledTasksTaskConfigDialog.line524JsxAttrPlaceholderFromUserNNText',
                      )}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label>
                        {tHardcodedUi.raw(
                          'componentsScheduledTasksTaskConfigDialog.line529JsxTextLandInColumn',
                        )}
                      </Label>
                      <Select
                        value={newTicketColumn || '__default__'}
                        onValueChange={(v) => setNewTicketColumn(v === '__default__' ? '' : v)}
                      >
                        <SelectTrigger className="hover:bg-muted/40 cursor-pointer transition-colors">
                          <SelectValue
                            placeholder={tHardcodedUi.raw(
                              'componentsScheduledTasksTaskConfigDialog.line532JsxAttrPlaceholderBacklogDefault',
                            )}
                          />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem
                            value="__default__"
                            className="text-muted-foreground cursor-pointer"
                          >
                            {tHardcodedUi.raw(
                              'componentsScheduledTasksTaskConfigDialog.line535JsxTextFirstColumnDefault',
                            )}
                          </SelectItem>
                          {projectColumns.map((c) => (
                            <SelectItem key={c.key} value={c.key} className="cursor-pointer">
                              {c.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>
                        {tHardcodedUi.raw(
                          'componentsScheduledTasksTaskConfigDialog.line543JsxTextAssignTo',
                        )}
                      </Label>
                      <Input
                        type="text"
                        value={newTicketAssignees}
                        onChange={(e) => setNewTicketAssignees(e.target.value)}
                        placeholder={tHardcodedUi.raw(
                          'componentsScheduledTasksTaskConfigDialog.line548JsxAttrPlaceholderEngineerQa',
                        )}
                        className="font-mono text-sm"
                      />
                      <p className="text-muted-foreground text-xs">
                        {tHardcodedUi.raw(
                          'componentsScheduledTasksTaskConfigDialog.line552JsxTextCommaSeparatedAgentSlugs',
                        )}
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
        <div className="border-border/60 bg-muted/30 flex shrink-0 items-center justify-between gap-3 border-t px-6 py-3">
          <div className="flex items-center gap-2">
            {step !== 'source' && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setStep(step === 'config' ? 'action' : 'source')}
                className="cursor-pointer"
              >
                <ArrowLeft className="mr-1 h-4 w-4" /> Back
              </Button>
            )}
            {step === 'source' && sourceType === 'cron' && (
              <Select value={timezone} onValueChange={setTimezone}>
                <SelectTrigger
                  className="border-border/50 text-muted-foreground hover:bg-muted/40 hover:text-foreground h-8 w-auto cursor-pointer gap-1.5 rounded-full bg-transparent px-3 text-sm"
                  title="Timezone"
                >
                  <Clock className="h-3.5 w-3.5" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIMEZONES.map((tz) => (
                    <SelectItem key={tz} value={tz} className="cursor-pointer">
                      {tz}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="flex gap-3">
            <Button variant="outline" size="sm" onClick={handleClose} className="cursor-pointer">
              Cancel
            </Button>
            {step === 'source' && (
              <Button size="sm" onClick={() => setStep('action')} className="cursor-pointer">
                Next <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            )}
            {step === 'action' && (
              <Button size="sm" onClick={() => setStep('config')} className="cursor-pointer">
                Next <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            )}
            {step === 'config' && (
              <Button
                size="sm"
                onClick={handleCreate}
                disabled={!isValid() || createMutation.isPending}
                className="cursor-pointer"
              >
                {createMutation.isPending ? 'Creating...' : 'Create Trigger'}
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
