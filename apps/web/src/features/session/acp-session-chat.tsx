'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { UnifiedMarkdown } from '@/components/markdown';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { useSession } from '@kortix/sdk/react';
import { projectAcpChatItems, projectAcpContext, projectAcpPendingPrompts, type AcpMessageAttachment, type AcpPendingQuestionItem } from '@kortix/sdk';
import { Bot, Brain, File, ImageIcon, ShieldCheck, Terminal, User } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AcpPlanCard, AcpToolCallCard } from './acp-tool-call-card';
import { SessionSiteHeader } from './header/session-site-header';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { SessionChatInput, type AttachedFile } from './session-chat-input';
import { SessionContextModal } from './session-context-modal';
import type { Session } from '@/hooks/runtime/use-runtime-sessions';
import { useAutoScroll } from '@/hooks/use-auto-scroll';

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
  const context = useMemo(() => projectAcpContext(envelopes), [envelopes]);
  const contextMessages = useMemo(
    () => {
      const created = Date.parse(envelopes[0]?.createdAt ?? '') || Date.now();
      return context.messages.map((message) => ({
        info: {
          id: message.id,
          role: message.role === 'user' ? 'user' as const : 'assistant' as const,
          sessionID: sessionId,
          time: { created },
        },
        parts: [{
          id: `${message.id}-content`,
          messageID: message.id,
          sessionID: sessionId,
          type: message.role === 'thought' ? 'reasoning' as const : 'text' as const,
          text: message.text,
        }],
      }));
    },
    [context.messages, envelopes, sessionId],
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
  const turns = useMemo(() => groupAcpTurns(items), [items]);
  const { scrollRef, contentRef, spacerElRef, showScrollButton, scrollToAbsoluteBottom, smoothScrollToAbsoluteBottom } = useAutoScroll({ working: busy, hasContent: items.length > 0 });
  const initialScrollSessionRef = useRef<string | null>(null);
  const isSidePanelOpen = useKortixComputerStore((state) => state.isSidePanelOpen);
  const setIsSidePanelOpen = useKortixComputerStore((state) => state.setIsSidePanelOpen);
  useEffect(() => { if (ready) onReady?.(); }, [onReady, ready]);
  useEffect(() => {
    if (!ready || !items.length) return;
    if (initialScrollSessionRef.current === sessionId) return;
    initialScrollSessionRef.current = sessionId;
    const frame = requestAnimationFrame(scrollToAbsoluteBottom);
    return () => cancelAnimationFrame(frame);
  }, [items.length, ready, scrollToAbsoluteBottom, sessionId]);

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
    const sent = await sendPrompt(blocks);
    if (!sent) throw new Error('The ACP prompt failed. Your draft has been restored so you can retry.');
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
      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-y-auto px-4 py-6">
        <div ref={contentRef} className="mx-auto w-full max-w-3xl space-y-4">
          {items.length === 0 ? (
            <div className="text-muted-foreground py-16 text-center text-sm">Start a conversation with the selected native harness.</div>
          ) : turns.map((turn, turnIndex) => <div key={`turn-${turnIndex}`} data-turn-id={`turn-${turnIndex}`} className="space-y-4">{turn.map((item, index) => {
            if (item.kind === 'message') {
              const Icon = item.role === 'user' ? User : item.role === 'thought' ? Brain : Bot;
              return (
                <div key={item.id} className={item.role === 'user' ? 'ml-auto max-w-[85%] rounded-2xl bg-muted px-4 py-3' : 'py-2'}>
                  <div className="text-muted-foreground mb-2 flex items-center gap-2 text-xs font-medium capitalize"><Icon className="size-3.5" />{item.role}</div>
                  {item.role === 'user'
                    ? <div className="text-sm whitespace-pre-wrap text-pretty">{item.text}</div>
                    : <UnifiedMarkdown content={item.text} isStreaming={busy && item === items.at(-1)} />}
                  {item.attachments?.length ? <AcpMessageAttachments attachments={item.attachments} /> : null}
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
              return <AcpQuestionCard key={index} questions={item.questions} onSubmit={(answers) => respondQuestion(item.id, answers)} onReject={() => rejectQuestion(item.id)} />;
            }
            return (
              <details key={index} className="bg-popover rounded-md border px-4 py-3">
                <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium"><Terminal className="size-4" />{item.method}</summary>
                <pre className="text-muted-foreground mt-3 overflow-x-auto text-xs">{JSON.stringify(item.data, null, 2)}</pre>
              </details>
            );
          })}</div>)}
          {busy ? <div className="text-muted-foreground flex items-center gap-2 text-sm"><Loading className="size-4" />Agent is working</div> : null}
          {error ? <div className="text-kortix-red text-sm">{error}</div> : null}
          <div ref={spacerElRef} />
        </div>
        <Button type="button" variant="outline" size="sm" className={showScrollButton ? 'bg-background/90 absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full shadow-lg' : 'pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full opacity-0'} onClick={smoothScrollToAbsoluteBottom}>
          Scroll to latest
        </Button>
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
            acpUsage={context.usage}
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

function groupAcpTurns(items: ReturnType<typeof projectAcpChatItems>) {
  const turns: Array<ReturnType<typeof projectAcpChatItems>> = [];
  for (const item of items) {
    if (item.kind === 'message' && item.role === 'user') turns.push([item]);
    else if (turns.length) turns.at(-1)!.push(item);
    else turns.push([item]);
  }
  return turns;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function AcpMessageAttachments({ attachments }: { attachments: AcpMessageAttachment[] }) {
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {attachments.map((attachment, index) => {
        const label = attachment.name ?? (attachment.kind === 'image' ? 'Image' : attachment.kind === 'audio' ? 'Audio' : 'Resource');
        const imageSource = attachment.kind === 'image'
          ? attachment.uri ?? (attachment.data && attachment.mimeType ? `data:${attachment.mimeType};base64,${attachment.data}` : null)
          : null;
        if (imageSource) {
          return (
            <a key={`${label}-${index}`} href={imageSource} target="_blank" rel="noopener noreferrer" className="bg-popover block overflow-hidden rounded-md border">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={imageSource} alt={label} className="h-24 w-32 object-cover" />
              <span className="text-muted-foreground flex max-w-32 items-center gap-1 px-2 py-1 text-xs"><ImageIcon className="size-3 shrink-0" /><span className="truncate">{label}</span></span>
            </a>
          );
        }
        const content = <span className="bg-popover text-muted-foreground inline-flex max-w-56 items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs"><File className="size-3.5 shrink-0" /><span className="truncate">{label}</span></span>;
        return attachment.uri?.startsWith('http')
          ? <a key={`${label}-${index}`} href={attachment.uri} target="_blank" rel="noopener noreferrer">{content}</a>
          : <span key={`${label}-${index}`}>{content}</span>;
      })}
    </div>
  );
}

function AcpQuestionCard({ questions, onSubmit, onReject }: {
  questions: AcpPendingQuestionItem[];
  onSubmit: (answers: Record<string, unknown>) => void;
  onReject: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const keys = questions.map((question, index) => question.key ?? `answer_${index + 1}`);
  const complete = keys.every((key) => Boolean(answers[key]?.trim()));
  return (
    <form className="bg-popover space-y-3 rounded-md border px-4 py-3" onSubmit={(event) => {
      event.preventDefault();
      if (complete) onSubmit(Object.fromEntries(keys.map((key) => [key, answers[key]!.trim()])));
    }}>
      <div className="flex items-center gap-2 text-sm font-medium"><ShieldCheck className="size-4" />Input requested</div>
      {questions.map((question, index) => {
        const key = keys[index]!;
        return (
          <div key={key} className="space-y-2">
            <div className="text-sm">{question.question}</div>
            {question.options.length ? (
              <div className="flex flex-wrap gap-2">
                {question.options.map((option) => {
                  const value = String(option.value ?? option.optionId ?? option.id ?? option.label);
                  return <Button key={value} type="button" size="sm" variant={answers[key] === value ? 'secondary' : 'outline'} onClick={() => setAnswers((current) => ({ ...current, [key]: value }))}>{option.label}</Button>;
                })}
              </div>
            ) : <Input value={answers[key] ?? ''} onChange={(event) => setAnswers((current) => ({ ...current, [key]: event.target.value }))} placeholder="Type your answer" />}
          </div>
        );
      })}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!complete}>Submit</Button>
        <Button type="button" size="sm" variant="outline" onClick={onReject}>Dismiss</Button>
      </div>
    </form>
  );
}
