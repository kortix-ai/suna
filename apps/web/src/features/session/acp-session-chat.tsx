'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { UnifiedMarkdown } from '@/components/markdown';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { useSession } from '@kortix/sdk/react';
import { projectAcpChatItems, projectAcpPendingPrompts } from '@kortix/sdk';
import { Bot, Brain, ShieldCheck, Terminal, User } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { AcpPlanCard, AcpToolCallCard } from './acp-tool-call-card';
import { SessionSiteHeader } from './header/session-site-header';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { SessionChatInput, type AttachedFile } from './session-chat-input';
import { SessionContextModal } from './session-context-modal';
import type { Session } from '@/hooks/runtime/use-runtime-sessions';
import { projectAcpContextMessages } from './acp-context-projection';

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
  const contextMessages = useMemo(
    () => projectAcpContextMessages(items, sessionId, Date.parse(envelopes[0]?.createdAt ?? '') || Date.now()),
    [envelopes, items, sessionId],
  );
  const contextSession = useMemo<Session>(() => ({
    id: sessionId,
    title: sessionTitle,
    time: {
      created: Date.parse(envelopes[0]?.createdAt ?? '') || Date.now(),
      updated: Date.parse(envelopes.at(-1)?.createdAt ?? '') || Date.now(),
    },
  }), [envelopes, sessionId, sessionTitle]);
  const [contextModalOpen, setContextModalOpen] = useState(false);
  const pendingPrompts = useMemo(() => projectAcpPendingPrompts(envelopes), [envelopes]);
  const pendingPermissionIds = useMemo(() => new Set(pendingPrompts.permissions.map((request) => JSON.stringify(request.id))), [pendingPrompts.permissions]);
  const pendingQuestionIds = useMemo(() => new Set(pendingPrompts.questions.map((request) => JSON.stringify(request.id))), [pendingPrompts.questions]);
  const isSidePanelOpen = useKortixComputerStore((state) => state.isSidePanelOpen);
  const setIsSidePanelOpen = useKortixComputerStore((state) => state.setIsSidePanelOpen);
  useEffect(() => { if (ready) onReady?.(); }, [onReady, ready]);

  const send = async (text: string, files: AttachedFile[] = []) => {
    if (!acpSessionId || busy) return;
    const blocks: Parameters<typeof sendPrompt>[0] = [{ type: 'text', text }];
    for (const file of files) {
      if (file.kind === 'remote') {
        blocks.push({ type: 'resource_link', uri: file.url, name: file.filename, mimeType: file.mime });
        continue;
      }
      const data = bytesToBase64(new Uint8Array(await file.file.arrayBuffer()));
      if (file.isImage) blocks.push({ type: 'image', data, mimeType: file.file.type || 'application/octet-stream' });
      else blocks.push({ type: 'resource', resource: { uri: `file:///${file.file.name}`, mimeType: file.file.type || 'application/octet-stream', blob: data } });
    }
    await sendPrompt(blocks);
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
                <div key={item.id} className={item.role === 'user' ? 'ml-auto max-w-[85%] rounded-2xl bg-muted px-4 py-3' : 'py-2'}>
                  <div className="text-muted-foreground mb-2 flex items-center gap-2 text-xs font-medium capitalize"><Icon className="size-3.5" />{item.role}</div>
                  {item.role === 'user'
                    ? <div className="text-sm whitespace-pre-wrap text-pretty">{item.text}</div>
                    : <UnifiedMarkdown content={item.text} isStreaming={busy && index === items.length - 1} />}
                </div>
              );
            }
            if (item.kind === 'tool') return <AcpToolCallCard key={item.id} tool={item} sessionId={sessionId} />;
            if (item.kind === 'plan') return <AcpPlanCard key={`plan-${index}`} plan={item} />;
            if (item.kind === 'permission') {
              if (!pendingPermissionIds.has(JSON.stringify(item.id))) return null;
              const request = pendingPrompts.permissions.find((candidate) => JSON.stringify(candidate.id) === JSON.stringify(item.id));
              const options = request?.options ?? [];
              return (
                <div key={index} className="bg-popover rounded-md border px-4 py-3">
                  <div className="mb-1 flex items-center gap-2 text-sm font-medium"><ShieldCheck className="size-4" />Permission requested</div>
                  <div className="text-muted-foreground mb-3 text-sm">{request?.permission ?? 'The agent needs approval to continue.'}</div>
                  {request?.patterns.length ? <div className="mb-3 space-y-1">{request.patterns.map((pattern) => <code key={pattern} className="bg-muted block rounded px-2 py-1 text-xs">{pattern}</code>)}</div> : null}
                  <div className="flex flex-wrap gap-2">
                    {options.map((option) => <Button key={String(option.optionId ?? option.id ?? option.value)} size="sm" onClick={() => respondPermission(item.id, String(option.optionId ?? option.id ?? option.value))}>{option.label}</Button>)}
                    <Button size="sm" variant="outline" onClick={() => respondPermission(item.id)}>Reject</Button>
                  </div>
                </div>
              );
            }
            if (item.kind === 'question') {
              if (!pendingQuestionIds.has(JSON.stringify(item.id))) return null;
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
                            <AcpTextAnswer onSubmit={(value) => respondQuestion(item.id, { [key]: value })} />
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
        <div className="mx-auto w-full max-w-3xl">
          <SessionChatInput
            sessionId={sessionId}
            onSend={send}
            isBusy={busy}
            onStop={() => void cancel()}
            disabled={!acpSessionId}
            placeholder="Message the agent"
            messages={contextMessages}
            onContextClick={() => setContextModalOpen(true)}
          />
        </div>
      </div>
      <SessionContextModal
        open={contextModalOpen}
        onOpenChange={setContextModalOpen}
        messages={contextMessages}
        session={contextSession}
        providers={undefined}
      />
    </div>
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function AcpTextAnswer({ onSubmit }: { onSubmit: (value: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <form
      className="flex gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const answer = value.trim();
        if (answer) onSubmit(answer);
      }}
    >
      <Input value={value} onChange={(event) => setValue(event.target.value)} placeholder="Type your answer" />
      <Button type="submit" size="sm" disabled={!value.trim()}>Submit</Button>
    </form>
  );
}
