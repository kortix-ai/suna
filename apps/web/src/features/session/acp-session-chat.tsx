'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { Textarea } from '@/components/ui/textarea';
import type { useSession } from '@kortix/sdk/react';
import { projectAcpChatItems } from '@kortix/sdk';
import { Bot, Brain, ShieldCheck, Square, Terminal, User } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { AcpPlanCard, AcpToolCallCard } from './acp-tool-call-card';

export function AcpSessionChat({
  acp,
  onReady,
}: {
  acp: NonNullable<ReturnType<typeof useSession>['acp']>;
  onReady?: () => void;
}) {
  const [draft, setDraft] = useState('');
  const {
    ready,
    busy,
    error,
    envelopes,
    runtimeSessionId: acpSessionId,
    send: sendPrompt,
    cancel,
    respondPermission,
    respondQuestion,
    rejectQuestion,
  } = acp;
  const items = useMemo(() => projectAcpChatItems(envelopes), [envelopes]);
  useEffect(() => { if (ready) onReady?.(); }, [onReady, ready]);

  const send = async () => {
    const text = draft.trim();
    if (!text || !acpSessionId || busy) return;
    setDraft('');
    await sendPrompt([{ type: 'text', text }]);
  };

  return (
    <div className="bg-background flex h-full min-h-0 flex-col" data-testid="acp-session-chat">
      <header className="border-border flex items-center gap-2 border-b px-4 py-3">
        <Bot className="size-4" />
        <span className="text-sm font-medium">Agent session</span>
        <Badge variant="kortix" size="xs">ACP</Badge>
        {acpSessionId ? <span className="text-muted-foreground ml-auto truncate font-mono text-xs">{acpSessionId}</span> : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto w-full max-w-3xl space-y-4">
          {items.length === 0 ? (
            <div className="text-muted-foreground py-16 text-center text-sm">Start a conversation with the selected native harness.</div>
          ) : items.map((item, index) => {
            if (item.kind === 'message') {
              const Icon = item.role === 'user' ? User : item.role === 'thought' ? Brain : Bot;
              return (
                <div key={item.id} className="bg-popover rounded-md border px-4 py-3">
                  <div className="mb-2 flex items-center gap-2 text-xs font-medium capitalize"><Icon className="size-3.5" />{item.role}</div>
                  <div className="text-sm whitespace-pre-wrap text-pretty">{item.text}</div>
                </div>
              );
            }
            if (item.kind === 'tool') return <AcpToolCallCard key={item.id} tool={item} />;
            if (item.kind === 'plan') return <AcpPlanCard key={`plan-${index}`} plan={item} />;
            if (item.kind === 'permission') {
              const options = Array.isArray(item.params.options) ? item.params.options as Array<any> : [];
              return (
                <div key={index} className="bg-popover rounded-md border px-4 py-3">
                  <div className="mb-3 flex items-center gap-2 text-sm font-medium"><ShieldCheck className="size-4" />Permission requested</div>
                  <pre className="text-muted-foreground mb-3 overflow-x-auto text-xs">{JSON.stringify(item.params, null, 2)}</pre>
                  <div className="flex flex-wrap gap-2">
                    {options.map((option) => <Button key={String(option.optionId ?? option.id)} size="sm" onClick={() => respondPermission(item.id, String(option.optionId ?? option.id))}>{String(option.name ?? option.title ?? option.optionId ?? option.id)}</Button>)}
                    <Button size="sm" variant="outline" onClick={() => respondPermission(item.id)}>Reject</Button>
                  </div>
                </div>
              );
            }
            if (item.kind === 'question') {
              return (
                <div key={index} className="bg-popover rounded-md border px-4 py-3">
                  <div className="mb-3 flex items-center gap-2 text-sm font-medium"><ShieldCheck className="size-4" />Input requested</div>
                  <div className="space-y-3">
                    {item.questions.map((question, questionIndex) => {
                      const key = question.key ?? `answer_${questionIndex + 1}`;
                      return (
                        <div key={`${item.id}:${key}`} className="space-y-2">
                          <div className="text-sm">{question.question}</div>
                          {question.options.length > 0 ? (
                            <div className="flex flex-wrap gap-2">
                              {question.options.map((option) => {
                                const value = option.value ?? option.optionId ?? option.id ?? option.label;
                                const label = option.label ?? value;
                                return (
                                  <Button
                                    key={String(value)}
                                    size="sm"
                                    onClick={() => respondQuestion(item.id, { [key]: value })}
                                  >
                                    {String(label)}
                                  </Button>
                                );
                              })}
                            </div>
                          ) : (
                            <pre className="text-muted-foreground overflow-x-auto text-xs">{JSON.stringify(item.params, null, 2)}</pre>
                          )}
                        </div>
                      );
                    })}
                    <Button size="sm" variant="outline" onClick={() => rejectQuestion(item.id)}>Dismiss</Button>
                  </div>
                </div>
              );
            }
            return (
              <details key={index} className="bg-popover rounded-md border px-4 py-3">
                <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium"><Terminal className="size-4" />{item.method}</summary>
                <pre className="text-muted-foreground mt-3 overflow-x-auto text-xs">{JSON.stringify(item.data, null, 2)}</pre>
              </details>
            );
          })}
          {busy ? <div className="text-muted-foreground flex items-center gap-2 text-sm"><Loading className="size-4" />Agent is working</div> : null}
          {error ? <div className="text-kortix-red text-sm">{error}</div> : null}
        </div>
      </div>
      <div className="border-border border-t px-4 py-3">
        <div className="mx-auto flex w-full max-w-3xl items-end gap-2">
          <Textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Message the agent" className="min-h-12" onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} />
          {busy ? <Button size="icon" variant="outline" onClick={() => void cancel()} aria-label="Stop"><Square className="size-4" /></Button> : <Button onClick={() => void send()} disabled={!draft.trim() || !acpSessionId}>Send</Button>}
        </div>
      </div>
    </div>
  );
}
