'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CountBadge } from '@/components/ui/count-badge';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { EmptyState } from '@/features/layout/section/empty-state';
import type { SessionLogBlock, SessionLogMessage } from '@kortix/sdk';

export function trajectoryText(block: SessionLogBlock): string {
  switch (block.type) {
    case 'text':
    case 'reasoning':
      return block.text;
    case 'tool_call':
      return [
        'Input',
        JSON.stringify(block.input, null, 2),
        'Result',
        ...(block.result?.content.map((item) => (item.type === 'text' ? item.text : item.mime)) ??
          []),
        block.result?.error?.message,
      ]
        .filter(Boolean)
        .join('\n');
    case 'compaction':
      return block.summary ?? 'Encrypted summary';
    case 'subtask':
      return block.description;
    case 'attachment':
      return block.name ?? block.label ?? block.mime;
    case 'step':
      return block.phase;
    case 'harness':
      return JSON.stringify(block.data, null, 2);
  }
}

/** Uses the same canonical log as the transcript: no second event stream or polling. */
export function SessionTrajectory({ messages }: { messages: readonly SessionLogMessage[] }) {
  return (
    <section aria-label="Trajectory" className="shrink-0 space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium">Trajectory</h2>
        <CountBadge count={messages.length} />
      </div>
      <p className="text-muted-foreground text-xs">
        Agent activity in order. Open a step to inspect reasoning, tool inputs and results.
      </p>
      {messages.length === 0 ? (
        <EmptyState size="sm" title="No activity yet" />
      ) : (
        <ol className="space-y-2">
          {messages.map((message, index) => (
            <li key={message.message_id}>
              <Disclosure variant="outline" className="shrink-0">
                <DisclosureTrigger variant="outline">
                  <Button
                    variant="popover"
                    className="flex w-full flex-wrap justify-start gap-2 rounded-none"
                  >
                    <span className="text-muted-foreground tabular-nums">{index + 1}</span>
                    <span className="text-sm font-medium">{message.role}</span>
                    <Badge
                      size="sm"
                      variant={message.status === 'error' ? 'destructive' : 'outline'}
                    >
                      {message.status}
                    </Badge>
                    {!message.in_context && (
                      <Badge size="sm" variant="outline">
                        Outside context
                      </Badge>
                    )}
                    <time
                      className="text-muted-foreground ml-auto text-xs tabular-nums"
                      dateTime={message.created_at}
                    >
                      {new Date(message.created_at).toLocaleTimeString()}
                    </time>
                  </Button>
                </DisclosureTrigger>
                <DisclosureContent variant="outline">
                  <div className="space-y-3 px-4 py-3">
                    <p className="text-muted-foreground font-mono text-xs break-all">
                      {message.message_id}
                    </p>
                    {message.error && (
                      <p className="text-sm wrap-anywhere">{message.error.message}</p>
                    )}
                    {message.blocks.map((block) => (
                      <div key={block.id} className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2 text-xs font-medium">
                          <span>{block.type === 'tool_call' ? block.name : block.type}</span>
                          {block.type === 'tool_call' && (
                            <Badge
                              size="sm"
                              variant={
                                block.status === 'error' || block.result?.is_error
                                  ? 'destructive'
                                  : 'outline'
                              }
                            >
                              {block.result?.is_error ? 'error' : block.status}
                            </Badge>
                          )}
                        </div>
                        <pre className="bg-muted max-h-80 overflow-auto rounded-md p-3 font-mono text-xs break-words whitespace-pre-wrap">
                          {trajectoryText(block)}
                        </pre>
                      </div>
                    ))}
                  </div>
                </DisclosureContent>
              </Disclosure>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
