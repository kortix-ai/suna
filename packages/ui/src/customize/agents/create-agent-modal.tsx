'use client';

/**
 * New agent. Three ways to start, the agent-first one first: describe the
 * work to My Kortix (it drafts the agent with only the access the work
 * needs), start blank, or copy another agent. Each one opens a session of My
 * Kortix that writes `agents.<name>` and opens a change request: there is no
 * write path that skips review, so the modal never claims one.
 *
 * From `lg` the modal has two panes: the form, and a live preview of the
 * agent it makes (its mark, name, `agents.<name>` key, description, and what
 * it starts with). Below `lg` it is a bottom sheet capped at 90% of the
 * window, form only. Its body scrolls and its footer stays pinned, so Create
 * agent is reachable at 720×480.
 */

import { slugifySlug } from '@kortix/manifest-schema';
import type { ProjectConfigSummary } from '@kortix/sdk';
import { isMyKortixAgentName } from '@kortix/shared';
import type * as React from 'react';
import { useState } from 'react';

import { useTranslations as useI18nTranslations } from '../../i18n';
import { AgentMark, agentDisplayName } from '../../internal/components/agent-mark';
import { cn } from '../../internal/lib/utils';
import { Button } from '../../primitives/button';
import { Input } from '../../primitives/input';
import { Label } from '../../primitives/label';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '../../primitives/modal';
import { RadioGroup, RadioGroupItem } from '../../primitives/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../primitives/select';
import { StatusDot } from '../../primitives/status';
import { Textarea } from '../../primitives/textarea';
import { useConfigureThread } from '../use-configure-thread';

export type CreateAgentStart = 'describe' | 'blank' | 'duplicate';

/** A phone's footer clears the home indicator: the device inset, at least the footer's own py-3. */
const FOOTER_SAFE_AREA = 'max-lg:pb-[max(0.75rem,env(safe-area-inset-bottom))]'; // audit:allow device safe-area inset, not a spacing step

/** The request My Kortix receives. English, like every configure prompt. */
export function createAgentPrompt(input: {
  start: CreateAgentStart;
  name: string;
  description: string;
  from?: { name: string; path: string };
}): string {
  const review = 'Then open a change request so I can review and merge it.';
  const desc = input.description.trim();
  if (input.start === 'duplicate' && input.from) {
    return (
      `Create a new agent named "${input.name}" in kortix.yaml as a copy of the "${input.from.name}" agent ` +
      `(its config lives at \`${input.from.path}\`)${desc ? `, with the description "${desc}"` : ''}. ${review}`
    );
  }
  if (input.start === 'blank') {
    return (
      `Create a new agent named "${input.name}" in kortix.yaml${desc ? ` with the description "${desc}"` : ''}, ` +
      `no grants (write \`tools: none\`) and empty instructions. ${review}`
    );
  }
  return (
    `Create a new agent named "${input.name}" in kortix.yaml. What it does: ${desc || 'ask me.'} ` +
    `Write its instructions and give it only the tools, skills, connectors, secrets and permissions this work needs. ` +
    `Always write its \`tools:\` key: a list of the tools it needs, or \`all\`. ${review}`
  );
}

/** One fact of the preview: a label left, its value right. */
function PreviewFact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground flex min-w-0 items-center gap-1.5 truncate">{children}</span>
    </div>
  );
}

export function CreateAgentModal({
  open,
  onOpenChange,
  projectId,
  config,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  config: ProjectConfigSummary | null;
}) {
  const t = useI18nTranslations('agentEditor.tabs');
  const tPage = useI18nTranslations('agentEditor.page');
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const configure = useConfigureThread(projectId);
  const agents = (config?.agents ?? []).filter((a) => !a.platform);
  const [start, setStart] = useState<CreateAgentStart>('describe');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [from, setFrom] = useState<string>('');
  const slug = name.trim() ? slugifySlug(name, '') : '';
  // Every declared agent and the built-in ones: a new agent can never take a
  // platform agent's key. `agents` (the Duplicate sources) leaves them out.
  const taken = (config?.agents ?? []).some((a) => a.name === slug) || isMyKortixAgentName(slug);
  const source = agents.find((a) => a.name === from);
  const ready = slug.length > 0 && !taken && (start !== 'duplicate' || source !== undefined);

  const submit = () => {
    if (!ready || configure.pending) return;
    configure.start(
      createAgentPrompt({
        start,
        name: slug,
        description,
        from: source ? { name: source.name, path: source.path } : undefined,
      }),
    );
  };

  const choices: { key: CreateAgentStart; title: string; help: string }[] = [
    { key: 'describe', title: t('startDescribe'), help: t('startDescribeHelp') },
    { key: 'blank', title: t('startBlank'), help: t('startBlankHelp') },
    { key: 'duplicate', title: t('startDuplicate'), help: t('startDuplicateHelp') },
  ];

  // What the new agent starts with, per way to start.
  const startsWith = {
    describe: { instructions: t('previewDrafted'), access: t('previewAccessScoped') },
    blank: { instructions: t('previewEmpty'), access: t('previewAccessNone') },
    duplicate: { instructions: t('previewCopied'), access: t('previewCopied') },
  }[start];

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      {/* `space-y-0`: the modal's `space-y-4` puts a bottom margin on every
          child but the last (the absolute close button), so the form, footer
          included, sat 16px above the modal's edge. The header keeps its gap. */}
      <ModalContent className="flex flex-col space-y-0 overflow-hidden lg:max-w-4xl">
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="flex min-h-0 flex-1">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <ModalHeader className="shrink-0 pb-4">
                <ModalTitle>{t('newAgent')}</ModalTitle>
              </ModalHeader>
              <ModalBody className="min-h-0 overflow-y-auto">
                <div className="space-y-1.5">
                  <Label htmlFor="new-agent-name">{t('name')}</Label>
                  <Input
                    id="new-agent-name"
                    value={name}
                    placeholder={t('namePlaceholder')}
                    onChange={(e) => setName(e.target.value)}
                    autoFocus
                  />
                  {taken ? (
                    <p className="text-foreground flex items-center gap-1.5 text-xs">
                      <StatusDot tone="destructive" />
                      {t('nameTaken')}
                    </p>
                  ) : null}
                </div>

                <div className="space-y-1.5">
                  <p className="text-foreground text-sm font-medium">{t('howToStart')}</p>
                  <RadioGroup
                    aria-label={t('howToStart')}
                    value={start}
                    onValueChange={(next) => setStart(next as CreateAgentStart)}
                    className="gap-1"
                  >
                    {choices.map((choice) => (
                      <RadioGroupItem key={choice.key} value={choice.key} label={choice.title} description={choice.help} size="lg" />
                    ))}
                  </RadioGroup>
                </div>

                {start === 'duplicate' ? (
                  <div className="space-y-1.5">
                    <Label>{t('copyOf')}</Label>
                    <Select value={from} onValueChange={setFrom}>
                      <SelectTrigger aria-label={t('copyOf')} className="w-full">
                        <SelectValue placeholder={t('pickAgent')} />
                      </SelectTrigger>
                      <SelectContent>
                        {agents.map((agent) => (
                          <SelectItem key={agent.name} value={agent.name}>
                            <span className="flex min-w-0 items-center gap-2">
                              <AgentMark slug={agent.name} />
                              <span className="truncate">{agentDisplayName(agent.name)}</span>
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}

                <div className="space-y-1.5">
                  <Label htmlFor="new-agent-description">
                    {start === 'describe' ? t('whatItDoes') : tI18nComplete.raw('text526e0087cc3f')}
                  </Label>
                  <Textarea
                    id="new-agent-description"
                    value={description}
                    placeholder={start === 'describe' ? t('whatItDoesPlaceholder') : t('descriptionPlaceholderShort')}
                    onChange={(e) => setDescription(e.target.value)}
                    minHeight={start === 'describe' ? 90 : 52}
                  />
                </div>
              </ModalBody>
            </div>

            {/* The agent this makes, as it will show: updates as the form changes. */}
            <aside aria-label={t('preview')} className="bg-background hidden w-96 shrink-0 flex-col gap-4 overflow-y-auto border-l p-5 lg:flex">
              <p className="text-muted-foreground text-sm font-medium">{t('preview')}</p>
              <div className="space-y-1">
                <div className="pb-3">
                  <AgentMark slug={slug || 'new-agent'} size={42} />
                </div>
                <p className={cn('truncate text-lg font-medium', slug ? 'text-foreground' : 'text-muted-foreground')}>
                  {agentDisplayName(slug || t('namePlaceholder'))}
                </p>
                <p className="text-muted-foreground truncate font-mono text-xs">agents.{slug || t('namePlaceholder')}</p>
                {description.trim() ? (
                  <p className="text-foreground line-clamp-3 pt-1 text-sm text-pretty">{description.trim()}</p>
                ) : null}
              </div>
              <div className="space-y-2.5 border-t pt-4">
                {start === 'duplicate' && source ? (
                  <PreviewFact label={t('copyOf')}>
                    <AgentMark slug={source.name} />
                    <span className="truncate">{agentDisplayName(source.name)}</span>
                  </PreviewFact>
                ) : null}
                <PreviewFact label={tPage('instructions')}>{startsWith.instructions}</PreviewFact>
                <PreviewFact label={t('tabAccess')}>{startsWith.access}</PreviewFact>
              </div>
            </aside>
          </div>

          {/* A phone: full-width buttons, and the footer clears the home indicator. */}
          <ModalFooter className={cn('shrink-0 border-t py-3', FOOTER_SAFE_AREA)}>
            <p className="text-muted-foreground mr-auto hidden text-xs sm:block">{t('composerNote')}</p>
            <Button type="button" variant="ghost" size="sm" className="w-full sm:w-auto" onClick={() => onOpenChange(false)}>
              {tI18nComplete.raw('text19766ed6ccb2')}
            </Button>
            <Button type="submit" size="sm" className="w-full sm:w-auto" disabled={!ready || configure.pending} aria-busy={configure.pending || undefined}>
              {t('createAgent')}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
