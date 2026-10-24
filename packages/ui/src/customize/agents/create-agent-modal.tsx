'use client';

/**
 * New agent. Three ways to start, the agent-first one first: describe the
 * work to My Kortix (it drafts the agent with only the access the work
 * needs), start blank, or copy another agent. Each one opens a session of My
 * Kortix that writes `agents.<name>` and opens a change request: there is no
 * write path that skips review, so the modal never claims one.
 *
 * Below `lg` the modal is a bottom sheet capped at 90% of the window. Its body
 * scrolls and its footer stays pinned, so Create agent is reachable at 720×480.
 */

import { slugifySlug } from '@kortix/manifest-schema';
import type { ProjectConfigSummary } from '@kortix/sdk';
import { isMetaAgentName } from '@kortix/shared';
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
  ModalDescription,
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
      `no grants and empty instructions. ${review}`
    );
  }
  return (
    `Create a new agent named "${input.name}" in kortix.yaml. What it does: ${desc || 'ask me.'} ` +
    `Write its instructions and give it only the skills, connectors, secrets and permissions this work needs. ${review}`
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
  const taken = (config?.agents ?? []).some((a) => a.name === slug) || isMetaAgentName(slug);
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

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="flex flex-col overflow-hidden lg:max-w-lg">
        <ModalHeader className="shrink-0">
          <ModalTitle>{t('newAgent')}</ModalTitle>
          <ModalDescription>{t('newAgentHelp')}</ModalDescription>
        </ModalHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
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
              <p className={cn('flex items-center gap-1.5 text-xs', taken ? 'text-foreground' : 'text-muted-foreground')}>
                {taken ? <StatusDot tone="destructive" /> : null}
                {taken
                  ? t('nameTaken')
                  : t.rich('nameHelp', { slug: () => <span className="font-mono">agents.{slug || 'name'}</span> })}
              </p>
            </div>

            <div className="space-y-1.5">
              <p className="text-foreground text-sm font-medium">{t('howToStart')}</p>
              <RadioGroup
                aria-label={t('howToStart')}
                value={start}
                onValueChange={(next) => setStart(next as CreateAgentStart)}
              >
                {choices.map((choice) => (
                  <RadioGroupItem
                    key={choice.key}
                    value={choice.key}
                    label={choice.title}
                    description={choice.help}
                    variant="outline"
                  />
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
                rows={start === 'describe' ? 4 : 2}
              />
            </div>
            <p className="text-muted-foreground text-xs">{t('composerNote')}</p>
          </ModalBody>
          <ModalFooter className="shrink-0 border-t py-3">
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {tI18nComplete.raw('text19766ed6ccb2')}
            </Button>
            <Button type="submit" size="sm" disabled={!ready || configure.pending} aria-busy={configure.pending || undefined}>
              {t('createAgent')}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
