'use client';

/**
 * Create an automation in one step.
 *
 * The old flow was a two-step wizard whose first field was a raw six-field cron
 * expression, and which REQUIRED you to invent a webhook signing secret before
 * it would let you continue. Both are gone:
 *
 * - Cadence is a preset list rendered through describeCron ("Daily at 09:00").
 *   The raw expression lives in the detail sheet under Advanced.
 * - The webhook secret is generated. generateSecret() already existed; the
 *   wizard just never called it.
 *
 * Shape follows ux-references/perplexity/11-workflow-run-modal.png: what it
 * does on the left, a short form on the right, one collapsed "Additional
 * settings", one primary button.
 */

import { AlarmClockSolid } from '@mynaui/icons-react';
import { useMutation } from '@tanstack/react-query';
import { Webhook } from 'lucide-react';
import { type ComponentType, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { successToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { createProjectTrigger, upsertProjectSecret } from '@kortix/sdk';

import {
  CRON_PRESETS,
  DEFAULT_CRON_EXPR,
  TIMEZONES,
  dailyExprAt,
  describeCron,
  generateSecret,
  normalizeSecretEnvName,
  slugifyName,
} from './cron';

type Kind = 'cron' | 'webhook';
/** The presets, plus a custom time. Still no raw cron. */
type Cadence = string | 'custom-time';

export function AutomationCreateModal({
  projectId,
  open,
  onOpenChange,
  onCreated,
  forcedKind,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (slug: string) => void;
  forcedKind?: Kind;
}) {
  const [kind, setKind] = useState<Kind>(forcedKind ?? 'cron');
  const [cadence, setCadence] = useState<Cadence>('daily');
  const [time, setTime] = useState('09:00');
  const [prompt, setPrompt] = useState('');
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('UTC');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) return;
    setKind(forcedKind ?? 'cron');
    setCadence('daily');
    setTime('09:00');
    setPrompt('');
    setName('');
    setTimezone('UTC');
    setError(null);
  }, [open, forcedKind]);

  const cronExpr =
    cadence === 'custom-time'
      ? dailyExprAt(time)
      : (CRON_PRESETS.find((preset) => preset.id === cadence)?.expr ?? DEFAULT_CRON_EXPR);

  /** The name is derived from the task unless the user typed one. */
  const effectiveName = name.trim() || prompt.trim().split('\n')[0].slice(0, 60);

  const create = useMutation({
    mutationFn: async () => {
      const trimmedPrompt = prompt.trim();
      if (!trimmedPrompt) throw new Error('Describe what should happen');
      const finalName = effectiveName;
      if (!finalName) throw new Error('Give this automation a name');
      const slug = slugifyName(finalName);

      if (kind === 'webhook') {
        // Generated, not demanded. Shown once in the detail sheet afterwards.
        const secretEnv = `WEBHOOK_${slug.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}_SECRET`;
        await upsertProjectSecret(projectId, {
          name: normalizeSecretEnvName(secretEnv),
          value: generateSecret(),
        });
        return createProjectTrigger(projectId, {
          name: finalName,
          slug,
          type: 'webhook',
          prompt_template: trimmedPrompt,
          enabled: true,
          secret_env: normalizeSecretEnvName(secretEnv),
        });
      }

      return createProjectTrigger(projectId, {
        name: finalName,
        slug,
        type: 'cron',
        prompt_template: trimmedPrompt,
        enabled: true,
        cron: cronExpr,
        timezone: timezone.trim() || 'UTC',
      });
    },
    onSuccess: (listing) => {
      const created = listing.triggers.filter((t) => t.name === effectiveName).slice(-1)[0];
      successToast('Automation created', {
        description: kind === 'cron' ? describeCron(cronExpr) : 'Webhook URL ready in the panel',
      });
      if (created) onCreated(created.slug);
      else onOpenChange(false);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Could not create'),
  });

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="sm:max-w-2xl">
        <ModalHeader>
          <ModalTitle>New automation</ModalTitle>
          <ModalDescription>
            Describe the work once. It runs on your cadence, or when an event arrives.
          </ModalDescription>
        </ModalHeader>

        <ModalBody className="space-y-5">
          {forcedKind ? null : (
            <div className="flex gap-2">
              {(
                [
                  { id: 'cron' as const, label: 'On a schedule', icon: AlarmClockSolid },
                  { id: 'webhook' as const, label: 'On a webhook', icon: Webhook },
                ] as { id: Kind; label: string; icon: ComponentType<{ className?: string }> }[]
              ).map((option) => {
                const OptionIcon = option.icon;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setKind(option.id)}
                    className={cn(
                      'flex flex-1 items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
                      kind === option.id
                        ? 'border-foreground/30 bg-accent/40 text-foreground'
                        : 'border-border text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <OptionIcon className="size-4" />
                    {option.label}
                  </button>
                );
              })}
            </div>
          )}

          <Field>
            <FieldLabel htmlFor="automation-prompt">What should happen</FieldLabel>
            <Textarea
              id="automation-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={3}
              placeholder="Summarise yesterday's support tickets and post the digest to #support."
            />
            <FieldDescription>Written the way you would ask a teammate.</FieldDescription>
          </Field>

          {kind === 'cron' ? (
            <Field>
              <FieldLabel htmlFor="automation-cadence">How often</FieldLabel>
              <div className="flex flex-wrap items-center gap-2">
                <Select value={cadence} onValueChange={(value) => setCadence(value as Cadence)}>
                  <SelectTrigger id="automation-cadence" className="w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CRON_PRESETS.map((preset) => (
                      <SelectItem key={preset.id} value={preset.id}>
                        {preset.label}
                      </SelectItem>
                    ))}
                    <SelectItem value="custom-time">Every day at…</SelectItem>
                  </SelectContent>
                </Select>
                {cadence === 'custom-time' ? (
                  <Input
                    type="time"
                    aria-label="Time of day"
                    value={time}
                    onChange={(event) => setTime(event.target.value)}
                    className="w-32"
                  />
                ) : null}
              </div>
              <FieldDescription>
                {describeCron(cronExpr)} · {timezone}
              </FieldDescription>
            </Field>
          ) : (
            <InfoBanner tone="neutral" title="A signing secret is created for you">
              You will get the webhook URL and its secret as soon as this is saved.
            </InfoBanner>
          )}

          {kind === 'cron' ? (
            <Disclosure>
              <DisclosureTrigger>Additional settings</DisclosureTrigger>
              <DisclosureContent className="space-y-4 pt-3">
                <Field>
                  <FieldLabel htmlFor="automation-name">Name</FieldLabel>
                  <Input
                    id="automation-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={effectiveName || 'Daily support digest'}
                  />
                  <FieldDescription>
                    Derived from the task if you leave this empty.
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="automation-timezone">Time zone</FieldLabel>
                  <Select value={timezone} onValueChange={setTimezone}>
                    <SelectTrigger id="automation-timezone" className="w-56">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TIMEZONES.map((tz) => (
                        <SelectItem key={tz} value={tz}>
                          {tz}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </DisclosureContent>
            </Disclosure>
          ) : null}

          {error ? (
            <InfoBanner tone="destructive" title="Could not create">
              {error}
            </InfoBanner>
          ) : null}
        </ModalBody>

        <ModalFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              setError(null);
              create.mutate();
            }}
            disabled={create.isPending || !prompt.trim()}
          >
            {create.isPending ? 'Creating…' : 'Create automation'}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

export default AutomationCreateModal;
