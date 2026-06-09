'use client';

import { MessageSquare } from 'lucide-react';
import { AssistantTurn, UserBubble } from '../chat/chat-turn';
import { Composer, HOME_PROMPT_MESSAGES } from '../chat/composer';
import type { DemoConversation } from '../chat/use-demo-conversation';

export function ChatPage({ convo }: { convo: DemoConversation }) {
  const sessionName = convo.scenario?.sessionName ?? 'new-session';
  const busy = convo.phase === 'thinking' || convo.phase === 'streaming';
  const others = HOME_PROMPT_MESSAGES.filter((p) => p !== convo.userText).slice(0, 3);

  return (
    <div className="flex h-full flex-col">
      <div className="text-muted-foreground mb-4 flex items-center gap-2 text-xs tracking-wide">
        <MessageSquare className="size-3.5" />
        sessions / {sessionName}
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto">
        {convo.userText && <UserBubble text={convo.userText} />}
        {convo.scenario && <AssistantTurn convo={convo} />}

        {convo.phase === 'done' && others.length > 0 && (
          <div className="pt-2">
            <div className="text-muted-foreground/70 mb-1.5 text-xs">Try another</div>
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
