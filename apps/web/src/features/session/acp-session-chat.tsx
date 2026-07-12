'use client';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { useSession } from '@kortix/sdk/react';
import { projectAcpChatItems } from '@kortix/sdk';
import { Bot, Brain, ShieldCheck, Square, Terminal, User } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { AcpPlanCard, AcpToolCallCard } from './acp-tool-call-card';
import { SessionSiteHeader } from './header/session-site-header';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';

export function AcpSessionChat({
  acp,
  onReady,
  sessionId,
  sessionTitle,
}: {
  acp: NonNullable<ReturnType<typeof useSession>['acp']>;
  onReady?: () => void;
  sessionId: string;
  sessionTitle: string;
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
    configOptions,
    setConfigOption,
  } = acp;
  const items = useMemo(() => projectAcpChatItems(envelopes), [envelopes]);
  const isSidePanelOpen = useKortixComputerStore((state) => state.isSidePanelOpen);
  const setIsSidePanelOpen = useKortixComputerStore((state) => state.setIsSidePanelOpen);
  useEffect(() => { if (ready) onReady?.(); }, [onReady, ready]);

  const send = async () => {
    const text = draft.trim();
    if (!text || !acpSessionId || busy) return;
    setDraft('');
    await sendPrompt([{ type: 'text', text }]);
  };

  return (
    <div className="bg-background flex h-full min-h-0 flex-col" data-testid="acp-session-chat">
      <SessionSiteHeader
        sessionId={sessionId}
        sessionTitle={sessionTitle}
        isSidePanelOpen={isSidePanelOpen}
        onToggleSidePanel={() => setIsSidePanelOpen(!isSidePanelOpen)}
        supportsCompact={false}
      />
      {configOptions.length ? (
        <div className="border-border flex flex-wrap items-center justify-end gap-2 border-b px-3 py-2">
          {configOptions.filter((option) => option.type === 'select' && option.options?.length).map((option) => (
            <Select key={option.id} value={String(option.currentValue ?? '')} onValueChange={(value) => void setConfigOption(option.id, value)}>
              <SelectTrigger size="sm" className="w-auto min-w-40"><SelectValue placeholder={option.name ?? option.id} /></SelectTrigger>
              <SelectContent>
                {option.options!.map((choice, index) => {
                  const value = String(choice.value ?? choice.id ?? index);
                  return <SelectItem key={value} value={value}>{String(choice.name ?? choice.label ?? value)}</SelectItem>;
                })}
              </SelectContent>
            </Select>
          ))}
        </div>
      ) : null}
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
