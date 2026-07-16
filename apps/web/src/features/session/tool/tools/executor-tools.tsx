'use client';

import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import {
  BasicTool,
  ToolEmptyState,
  isErrorOutput,
  ToolOutputFallback,
  ToolRunningContext,
  partInput,
  partOutput,
  partStatus,
} from '@/features/session/tool/shared/infrastructure';
import {
  ExecutorJson,
  ExecutorRiskBadge,
  parseExecutorOutput,
} from '@/features/session/tool/shared/error-and-executor';
import { ToolSection } from '@/features/session/tool/shared/output-block';
import { STATUS_TEXT } from '@/components/ui/status';
import { cn } from '@/lib/utils';
import { Code2, Plug, Search, Terminal } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useContext, useMemo } from 'react';

export function ExecutorConnectorsTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const output = partOutput(part);
  const status = partStatus(part);
  const running = useContext(ToolRunningContext);
  const parsed = useMemo(() => parseExecutorOutput(output), [output]);
  const connectors = (Array.isArray(parsed?.connectors) ? parsed!.connectors : []) as Array<
    Record<string, unknown>
  >;
  const isStreaming = (status === 'pending' && running) || status === 'running';

  return (
    <BasicTool
      icon={<Plug className="size-3.5 flex-shrink-0" />}
      trigger={{
        title: 'Connectors',
        args: status === 'completed' ? [`${connectors.length} available`] : undefined,
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      <div className="p-2.5">
        {connectors.length > 0 ? (
          <div className="space-y-0.5">
            {connectors.map((c, i) => (
              <div key={String(c.slug ?? i)} className="flex items-center gap-2 px-2 py-1 text-xs">
                <Plug className="text-muted-foreground/50 size-3 flex-shrink-0" />
                <span className="text-foreground truncate font-medium">
                  {String(c.name || c.slug || '')}
                </span>
                <span className="text-muted-foreground/60 font-mono">
                  {String(c.provider ?? '')}
                </span>
                <span className="text-muted-foreground/50 ml-auto">
                  {String(c.tools ?? 0)} tools
                </span>
                <span
                  className={cn(
                    'text-[10px] font-semibold uppercase',
                    c.status === 'active' ? STATUS_TEXT.success : 'text-muted-foreground/60',
                  )}
                >
                  {String(c.status ?? '')}
                </span>
              </div>
            ))}
          </div>
        ) : output ? (
          <ToolOutputFallback output={output} isStreaming={isStreaming} toolName="connectors" />
        ) : (
          <ToolEmptyState message={isStreaming ? 'Loading connectors…' : 'No connectors.'} />
        )}
      </div>
    </BasicTool>
  );
}
ToolRegistry.register('kortix-executor_connectors', ExecutorConnectorsTool);

export function ExecutorDiscoverTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const running = useContext(ToolRunningContext);
  const parsed = useMemo(() => parseExecutorOutput(output), [output]);
  const matches = (Array.isArray(parsed?.matches) ? parsed!.matches : []) as Array<
    Record<string, unknown>
  >;
  const query = String(input.query ?? '').trim();
  const isStreaming = (status === 'pending' && running) || status === 'running';

  return (
    <BasicTool
      icon={<Search className="size-3.5 flex-shrink-0" />}
      trigger={{
        title: 'Discover tools',
        subtitle: query || undefined,
        args:
          status === 'completed'
            ? [`${matches.length} ${matches.length === 1 ? 'match' : 'matches'}`]
            : undefined,
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      <div className="p-2.5">
        {isErrorOutput(output) ? (
          <ToolOutputFallback output={output} isStreaming={isStreaming} toolName="discover" />
        ) : matches.length > 0 ? (
          <div className="space-y-1.5">
            {matches.map((m, i) => (
              <div key={String(m.tool ?? i)} className="px-2 py-1 text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-foreground truncate font-mono">{String(m.tool ?? '')}</span>
                  <ExecutorRiskBadge risk={m.risk} />
                </div>
                {m.description ? (
                  <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs leading-relaxed">
                    {String(m.description)}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        ) : parsed ? (
          <ToolEmptyState message={isStreaming ? 'Searching…' : `No tools match "${query}".`} />
        ) : output ? (
          <ToolOutputFallback output={output} isStreaming={isStreaming} toolName="discover" />
        ) : (
          <ToolEmptyState message={isStreaming ? 'Searching…' : 'No results yet.'} />
        )}
      </div>
    </BasicTool>
  );
}
ToolRegistry.register('kortix-executor_discover', ExecutorDiscoverTool);

export function ExecutorDescribeTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const running = useContext(ToolRunningContext);
  const parsed = useMemo(() => parseExecutorOutput(output), [output]);
  const tool = String(parsed?.tool ?? input.tool ?? '').trim();
  const isStreaming = (status === 'pending' && running) || status === 'running';

  return (
    <BasicTool
      icon={<Code2 className="size-3.5 flex-shrink-0" />}
      trigger={{
        title: 'Describe',
        subtitle: tool || undefined,
        args: parsed?.risk ? [String(parsed.risk)] : undefined,
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      <div className="space-y-2.5 p-2.5">
        {isErrorOutput(output) ? (
          <ToolOutputFallback output={output} isStreaming={isStreaming} toolName="describe" />
        ) : parsed ? (
          <>
            <div className="flex items-center gap-2">
              <span className="text-foreground font-mono text-xs">{tool}</span>
              <ExecutorRiskBadge risk={parsed.risk} />
            </div>
            {parsed.description ? (
              <p className="text-muted-foreground text-xs leading-relaxed">
                {String(parsed.description)}
              </p>
            ) : null}
            <ToolSection
              label={tI18nHardcoded.raw(
                'autoFeaturesSessionToolRenderersJsxTextInputSchema878a1df6',
              )}
            >
              <ExecutorJson value={parsed.inputSchema ?? { type: 'object', properties: {} }} />
            </ToolSection>
          </>
        ) : output ? (
          <ToolOutputFallback output={output} isStreaming={isStreaming} toolName="describe" />
        ) : (
          <ToolEmptyState message={isStreaming ? 'Loading schema…' : 'No schema yet.'} />
        )}
      </div>
    </BasicTool>
  );
}
ToolRegistry.register('kortix-executor_describe', ExecutorDescribeTool);

export function ExecutorCallTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const running = useContext(ToolRunningContext);
  const parsed = useMemo(() => parseExecutorOutput(output), [output]);
  const connector = String(input.connector ?? '').trim();
  const action = String(input.action ?? '').trim();
  const args = (input.args && typeof input.args === 'object' ? input.args : {}) as Record<
    string,
    unknown
  >;
  const ref = connector && action ? `${connector}.${action}` : connector || action;
  const isStreaming = (status === 'pending' && running) || status === 'running';

  const ok = parsed?.ok === true;
  const callStatus =
    typeof parsed?.status === 'string'
      ? (parsed.status as string)
      : ok
        ? 'ok'
        : parsed
          ? 'error'
          : '';
  const outcome =
    callStatus === 'pending_approval'
      ? { label: 'Needs approval', tint: STATUS_TEXT.warning }
      : callStatus === 'denied'
        ? { label: 'Denied', tint: STATUS_TEXT.destructive }
        : ok
          ? { label: 'OK', tint: STATUS_TEXT.success }
          : parsed
            ? { label: 'Error', tint: STATUS_TEXT.destructive }
            : null;

  return (
    <BasicTool
      icon={<Terminal className="size-3.5 flex-shrink-0" />}
      trigger={{
        title: 'Run tool',
        subtitle: ref || undefined,
        args: [
          ...(parsed?.risk ? [String(parsed.risk)] : []),
          ...(outcome ? [outcome.label] : []),
        ].filter(Boolean) as string[],
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      <div className="space-y-2.5 p-2.5">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-foreground font-mono">{ref}</span>
          <ExecutorRiskBadge risk={parsed?.risk} />
          {outcome && (
            <span className={cn('ml-auto text-[10px] font-semibold uppercase', outcome.tint)}>
              {outcome.label}
            </span>
          )}
        </div>

        {Object.keys(args).length > 0 && (
          <ToolSection label="Request">
            <ExecutorJson value={args} />
          </ToolSection>
        )}

        {isErrorOutput(output) ? (
          <ToolOutputFallback output={output} isStreaming={isStreaming} toolName="call" />
        ) : parsed ? (
          <ToolSection label="Response">
            {parsed.reason && !ok ? (
              <p className="text-destructive font-mono text-xs">{String(parsed.reason)}</p>
            ) : (
              <ExecutorJson value={'data' in parsed ? parsed.data : parsed} />
            )}
          </ToolSection>
        ) : output ? (
          <ToolOutputFallback output={output} isStreaming={isStreaming} toolName="call" />
        ) : (
          <ToolEmptyState message={isStreaming ? 'Running…' : 'No result yet.'} />
        )}
      </div>
    </BasicTool>
  );
}
ToolRegistry.register('kortix-executor_call', ExecutorCallTool);
