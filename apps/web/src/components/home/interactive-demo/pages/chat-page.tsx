'use client';

import { ChatIcon as MessageSquare } from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';
import { AssistantTurn, UserBubble } from '../chat/chat-turn';
import { Composer } from '../chat/composer';
import { localizedScenarios } from '../chat/scenarios';
import type { DemoConversation } from '../chat/use-demo-conversation';

export function ChatPage({
  convo,
  onSkillClick,
}: {
  convo: DemoConversation;
  onSkillClick?: (name: string) => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const homePromptMessages = [
    tI18nComplete.raw('textbe3f588110fe'),
    ...localizedScenarios(tI18nComplete).map((scenario) => scenario.prompt),
  ];
  const sessionName = convo.scenario?.sessionName ?? 'new-session';
  const busy = convo.phase === 'streaming';
  const others = homePromptMessages.filter((p) => p !== convo.userText).slice(0, 3);

  return (
    <div className="flex h-full flex-col">
      <div className="text-muted-foreground mb-4 flex items-center gap-2 text-xs tracking-wide">
        <MessageSquare className="size-3.5" />
        {tI18nHardcoded.raw(
          'autoComponentsHomeInteractiveDemoPagesChatPageJsxTextSessionsa01a2571',
        )}
        {sessionName}
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto">
        {convo.userText && <UserBubble text={convo.userText} />}
        {convo.scenario && <AssistantTurn convo={convo} onSkillClick={onSkillClick} />}

        {convo.phase === 'done' && others.length > 0 && (
          <div className="pt-2">
            <div className="text-muted-foreground/70 mb-1.5 text-xs">
              {tI18nHardcoded.raw(
                'autoComponentsHomeInteractiveDemoPagesChatPageJsxTextTry70dc3164',
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {others.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => {
                    convo.reset();
                    convo.submit(p);
                  }}
                  className="border-border/60 bg-card hover:bg-muted/40 text-muted-foreground hover:text-foreground rounded-full border px-3 py-1 text-xs transition-colors"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="mt-4">
        <Composer
          variant="reply"
          value={convo.draft}
          onChange={convo.setDraft}
          onSubmit={convo.submit}
          disabled={busy}
        />
      </div>
    </div>
  );
}
