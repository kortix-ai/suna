'use client';

import { writeStartStash } from '@kortix/sdk/react';
import { ArrowUpIcon } from '@phosphor-icons/react';
import { useMemo, useState, type FormEvent, type KeyboardEvent } from 'react';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { Textarea } from '@/components/ui/textarea';
import { CapabilityPageShell } from '@/features/workspace/capabilities/shared/capability-page-shell';
import { useNewProjectSession } from '@/hooks/projects/use-new-project-session';
import { useTranslations } from '@/i18n/use-translations';
import { useFirstPromptPreviewStore } from '@/stores/session-composer-handoff-store';

import { localTimeZone } from '../capture-time';

const SUGGESTIONS = ['yesterday', 'lastOpened', 'byApp', 'said'] as const;

/**
 * Ask — a question over your own timeline, answered by an agent in a new
 * private session. It reuses the session stack: the agent reads the timeline
 * with `kortix capture search|timeline|frame` (the API scopes an agent to the
 * person its private session acts for, `capture.agent_read`) and cites each
 * moment as a link back into the Timeline (`?at=`) or a range page.
 *
 * The session title and preview carry the question alone (`pending_prompt.text`);
 * the delivered message (`parts`) adds the instructions, visible in the session.
 */
export function AskView({ projectId }: { projectId: string }) {
  const t = useTranslations('capture.ask');
  const newSession = useNewProjectSession(projectId);
  const [question, setQuestion] = useState('');
  const [sending, setSending] = useState(false);
  const tz = useMemo(() => localTimeZone(), []);

  const ask = (event?: FormEvent) => {
    event?.preventDefault();
    const text = question.trim();
    if (!text || sending) return;
    const instructions = t('instructions', { timelineUrl: `/projects/${projectId}/capture`, tz });
    setSending(true);
    newSession({
      create: {
        pending_prompt: {
          text,
          agent: null,
          model: null,
          variant: null,
          attachment_names: [],
          parts: [{ type: 'text', text: `${text}\n\n${instructions}` }],
        },
      },
      onError: () => setSending(false),
      onNavigate: (sessionId) => {
        writeStartStash(sessionId, { prompt: '', agent: null, model: null, variant: null });
        useFirstPromptPreviewStore
          .getState()
          .setFirstPromptPreview(sessionId, `${text}\n\n${instructions}`, []);
      },
    });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      ask();
    }
  };

  return (
    <CapabilityPageShell title={t('title')} description={t('description')}>
      <form onSubmit={ask} className="space-y-4">
        <Textarea
          aria-label={t('label')}
          placeholder={t('placeholder')}
          value={question}
          rows={3}
          maxLength={4000}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="flex flex-wrap items-center gap-2">
          {SUGGESTIONS.map((key) => (
            <Button
              key={key}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setQuestion(t(`suggestion.${key}`))}
            >
              {t(`suggestion.${key}`)}
            </Button>
          ))}
          <span className="flex-1" />
          <Button
            type="submit"
            size="sm"
            className="gap-1.5"
            disabled={!question.trim() || sending}
            aria-busy={sending}
          >
            {sending ? (
              <Loading className="size-3.5 shrink-0" />
            ) : (
              <ArrowUpIcon className="size-3.5 shrink-0" />
            )}
            {t('submit')}
          </Button>
        </div>
        <p className="text-muted-foreground text-xs text-pretty">{t('scope')}</p>
      </form>
    </CapabilityPageShell>
  );
}
