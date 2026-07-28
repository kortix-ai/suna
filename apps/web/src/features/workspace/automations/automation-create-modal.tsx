'use client';

/**
 * Create an automation in one step.
 *
 * The old flow was a two-step wizard whose first field was a raw six-field cron
 * expression, and which REFUSED to continue until you invented a webhook
 * signing secret. Both of those are gone — the cadence is a preset list, and
 * the secret is generated for you.
 *
 * But a generated secret you never see is useless: the value is stored as a
 * project secret and is write-only afterwards, so creation is the ONLY moment
 * it can be shown. Making a webhook therefore ends on a reveal step with the
 * URL, the secret and a ready-to-run curl — not by closing the modal.
 *
 * Everything else a trigger carries (agent, model, session strategy, delivery
 * conditions) stays editable on the automation itself; this covers what you
 * need to get one running.
 */

import { AlarmClockSolid } from '@mynaui/icons-react';
import { useMutation } from '@tanstack/react-query';
import { Check, Copy, Webhook } from 'lucide-react';
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
import { errorToast, successToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { copyToClipboard } from '@/lib/utils/clipboard';
import { createProjectTrigger, upsertProjectSecret } from '@kortix/sdk';

import {
  CRON_PRESETS,
  DEFAULT_CRON_EXPR,
  TIMEZONES,
  buildCurlExample,
  dailyExprAt,
  describeCron,
  generateSecret,
  normalizeSecretEnvName,
  slugifyName,
} from './cron';

type Kind = 'cron' | 'webhook';
/** The presets, plus a custom time. Still no raw cron. */
type Cadence = string | 'custom-time';

/** What a freshly created webhook must show exactly once. */
interface CreatedWebhook {
  slug: string;
  url: string;
  secretEnv: string;
  /** Only set when we generated it — a reused secret is not ours to reveal. */
  secretValue: string | null;
}

function CopyRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <div className="flex items-center gap-2">
        <Input
          readOnly
          value={value}
          className="flex-1 font-mono text-xs"
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={async () => {
            const ok = await copyToClipboard(value);
            if (!ok) {
              errorToast('Copy failed — select and copy manually');
              return;
            }
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </Button>
      </div>
      {hint ? <FieldDescription>{hint}</FieldDescription> : null}
    </Field>
  );
}

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
  const [secretEnvOverride, setSecretEnvOverride] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedWebhook | null>(null);

  useEffect(() => {
    if (open) return;
    setKind(forcedKind ?? 'cron');
    setCadence('daily');
    setTime('09:00');
    setPrompt('');
    setName('');
    setTimezone('UTC');
    setSecretEnvOverride('');
    setError(null);
    setCreated(null);
  }, [open, forcedKind]);

  const cronExpr =
    cadence === 'custom-time'
      ? dailyExprAt(time)
      : (CRON_PRESETS.find((preset) => preset.id === cadence)?.expr ?? DEFAULT_CRON_EXPR);

  /** The name is derived from the task unless the user typed one. */
  const effectiveName = name.trim() || prompt.trim().split('\n')[0].slice(0, 60);
  const defaultSecretEnv = `WEBHOOK_${slugifyName(effectiveName || 'automation')
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')}_SECRET`;

  const create = useMutation({
    mutationFn: async () => {
      const trimmedPrompt = prompt.trim();
      if (!trimmedPrompt) throw new Error('Describe what should happen');
      const finalName = effectiveName;
      if (!finalName) throw new Error('Give this automation a name');
      const slug = slugifyName(finalName);

      if (kind === 'webhook') {
        // An override names a secret that already exists, so there is nothing
        // of ours to reveal. Otherwise mint one and show it once.
        const override = normalizeSecretEnvName(secretEnvOverride);
        const secretEnv = override || defaultSecretEnv;
        const secretValue = override ? null : generateSecret();
        if (secretValue) {
          await upsertProjectSecret(projectId, { name: secretEnv, value: secretValue });
        }
        const listing = await createProjectTrigger(projectId, {
          name: finalName,
          slug,
          type: 'webhook',
          prompt_template: trimmedPrompt,
          enabled: true,
          secret_env: secretEnv,
        });
        return { listing, slug, secretEnv, secretValue };
      }

      const listing = await createProjectTrigger(projectId, {
        name: finalName,
        slug,
        type: 'cron',
        prompt_template: trimmedPrompt,
        enabled: true,
        cron: cronExpr,
        timezone: timezone.trim() || 'UTC',
      });
      return { listing, slug, secretEnv: '', secretValue: null };
    },
    onSuccess: ({ listing, slug, secretEnv, secretValue }) => {
      if (kind === 'webhook') {
        const trigger = listing.triggers.find((t) => t.slug === slug);
        // Do NOT close: this is the only time the secret can be read.
        setCreated({ slug, url: trigger?.webhook_url ?? '', secretEnv, secretValue });
        return;
      }
      successToast('Automation created', { description: describeCron(cronExpr) });
      onCreated(slug);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Could not create'),
  });

  const finish = () => {
    if (!created) return;
    onCreated(created.slug);
    onOpenChange(false);
  };

  if (created) {
    return (
      <Modal
        open={open}
        onOpenChange={(next) => {
          if (!next) finish();
          else onOpenChange(next);
        }}
      >
        <ModalContent className="sm:max-w-2xl">
          <ModalHeader>
            <ModalTitle>Webhook ready</ModalTitle>
            <ModalDescription>
              POST to this URL and a session starts. Sign the raw body with the secret below.
            </ModalDescription>
          </ModalHeader>

          <ModalBody className="space-y-4">
            {created.secretValue ? (
              <InfoBanner tone="warning" title="Copy the secret now">
                It is stored as the project secret {created.secretEnv} and cannot be read again.
                Rotate it from Settings → Environment if you lose it.
              </InfoBanner>
            ) : (
              <InfoBanner tone="neutral" title={`Signed with ${created.secretEnv}`}>
                This webhook reuses an existing project secret, so its value is not shown here.
              </InfoBanner>
            )}

            <CopyRow label="Webhook URL" value={created.url} />
            {created.secretValue ? (
              <CopyRow
                label="Signing secret"
                value={created.secretValue}
                hint={`Stored as ${created.secretEnv}.`}
              />
            ) : null}

            <Field>
              <FieldLabel>Example request</FieldLabel>
              <Textarea
                readOnly
                rows={6}
                value={buildCurlExample(created.url)}
                className="font-mono text-xs"
                onFocus={(event) => event.currentTarget.select()}
              />
              <FieldDescription>
                The signature must cover the raw request body byte-for-byte.
              </FieldDescription>
            </Field>
          </ModalBody>

          <ModalFooter>
            <Button type="button" onClick={finish}>
              Done
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    );
  }

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
            <FieldDescription>
              Written the way you would ask a teammate. Placeholders like {'{{ message.text }}'} are
              filled from the payload.
            </FieldDescription>
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
            <InfoBanner tone="neutral" title="A signing secret is generated for you">
              You get the URL, the secret and a ready-to-run curl as soon as this is saved. The
              secret is shown once.
            </InfoBanner>
          )}

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
                  Derived from the task if left empty. The slug becomes{' '}
                  <code className="font-mono text-xs">
                    {slugifyName(effectiveName || 'automation')}
                  </code>
                  .
                </FieldDescription>
              </Field>

              {kind === 'cron' ? (
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
              ) : (
                <Field>
                  <FieldLabel htmlFor="automation-secret-env">Signing secret name</FieldLabel>
                  <Input
                    id="automation-secret-env"
                    value={secretEnvOverride}
                    onChange={(event) => setSecretEnvOverride(event.target.value)}
                    placeholder={defaultSecretEnv}
                    className="font-mono text-xs"
                  />
                  <FieldDescription>
                    Leave empty and one is generated. Name an existing project secret to reuse its
                    key instead — UPPER_SNAKE_CASE.
                  </FieldDescription>
                </Field>
              )}

              <p className="text-muted-foreground text-xs">
                Agent, model, session strategy and delivery conditions are editable on the
                automation once it exists.
              </p>
            </DisclosureContent>
          </Disclosure>

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
