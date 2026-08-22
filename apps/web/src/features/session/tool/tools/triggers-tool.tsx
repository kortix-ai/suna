'use client';
import { Badge } from '@/components/ui/badge';
import { TextShimmer } from '@/components/ui/text-shimmer';
import {
  BasicTool,
  isErrorOutput,
  partInput,
  partOutput,
  ToolOutputFallback,
} from '@/features/session/tool/shared/infrastructure';
import { FoldedSection, OutputBlock } from '@/features/session/tool/shared/output-block';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import {
  ProhibitIcon as Ban,
  CalendarDotsIcon as CalendarClock,
  GlobeIcon as Globe,
  TreeStructureIcon as ListTree,
  MonitorPlayIcon as MonitorPlay,
  PlusIcon as Plus,
  ArrowClockwiseIcon as RefreshCw,
  TrashIcon as Trash2,
} from '@phosphor-icons/react';
import { useMemo } from 'react';

export function TriggersTool({ part, defaultOpen, forceOpen }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const action = (input.action as string) || 'list';

  const { title, subtitle, icon, args } = useMemo(() => {
    switch (action) {
      case 'create': {
        const name = (input.name as string) || '';
        const sourceType = (input.source_type as string) || '';
        const created = output.match(/Trigger created:\s*(\S+)/)?.[1];
        return {
          title: 'Create Trigger',
          subtitle: created || name || 'Creating...',
          icon: <Plus className="text-muted-foreground size-3.5" />,
          args: sourceType ? [sourceType] : undefined,
        };
      }
      case 'list': {
        const countMatch = output.match(/TRIGGERS\s*\((\d+)\)/);
        const count = countMatch ? countMatch[1] : undefined;
        return {
          title: 'List Triggers',
          subtitle: count
            ? `${count} trigger${count === '1' ? '' : 's'}`
            : output
              ? 'Loaded'
              : 'Loading...',
          icon: <ListTree className="text-muted-foreground size-3.5" />,
          args: count ? [count] : undefined,
        };
      }
      case 'delete': {
        const id = (input.trigger_id as string) || '';
        const deleted = output.toLowerCase().includes('deleted');
        return {
          title: 'Delete Trigger',
          subtitle: deleted ? 'Deleted' : id ? id.slice(0, 8) + '...' : 'Deleting...',
          icon: <Trash2 className="text-muted-foreground size-3.5" />,
          args: deleted ? ['deleted'] : undefined,
        };
      }
      case 'get': {
        const id = (input.trigger_id as string) || (input.name as string) || '';
        return {
          title: 'Trigger Details',
          subtitle: id ? (id.length > 20 ? id.slice(0, 20) + '...' : id) : 'Loading...',
          icon: <CalendarClock className="text-muted-foreground size-3.5" />,
          args: undefined,
        };
      }
      case 'update': {
        const name = (input.name as string) || (input.trigger_id as string) || '';
        return {
          title: 'Update Trigger',
          subtitle: name || 'Updating...',
          icon: <RefreshCw className="text-muted-foreground size-3.5" />,
          args: output ? ['updated'] : undefined,
        };
      }
      case 'test': {
        const name = (input.name as string) || (input.trigger_id as string) || '';
        return {
          title: 'Test Trigger',
          subtitle: name || 'Testing...',
          icon: <MonitorPlay className="text-muted-foreground size-3.5" />,
          args: output ? ['tested'] : undefined,
        };
      }
      case 'pause': {
        const name = (input.name as string) || (input.trigger_id as string) || '';
        return {
          title: 'Pause Trigger',
          subtitle: name || 'Pausing...',
          icon: <Ban className="text-muted-foreground size-3.5" />,
          args: output ? ['paused'] : undefined,
        };
      }
      case 'resume': {
        const name = (input.name as string) || (input.trigger_id as string) || '';
        return {
          title: 'Resume Trigger',
          subtitle: name || 'Resuming...',
          icon: <RefreshCw className="text-muted-foreground size-3.5" />,
          args: output ? ['resumed'] : undefined,
        };
      }
      default:
        return {
          title: 'Triggers',
          subtitle: action,
          icon: <CalendarClock className="text-muted-foreground size-3.5" />,
          args: undefined,
        };
    }
  }, [action, input, output]);

  const triggerLines = useMemo(() => {
    if (!output) return [];
    return output
      .split('\n')
      .filter((l) => l.trim().startsWith('['))
      .map((line) => {
        const m = line
          .trim()
          .match(
            /^\[(\w+)]\s+(\S+)\s*\|\s*(webhook|cron):\s*(.+?)\s*\|\s*(\w+)\s*→\s*(\w+)\s*\|\s*last_run:\s*(.+)$/,
          );
        if (!m) return { raw: line.trim() };
        return {
          status: m[1],
          name: m[2],
          sourceType: m[3] as 'webhook' | 'cron',
          sourceDetail: m[4].trim(),
          agent: m[6],
          lastRun: m[7].trim(),
        };
      });
  }, [output]);

  // `isErrorOutput` trims the whole output and attempts a `JSON.parse` over it,
  // and the fallback preview copies up to 3 KB. Both sat unmemoised in the render
  // path, so a trigger list re-parsed itself on every frame of the streaming turn.
  const isError = useMemo(() => isErrorOutput(output), [output]);
  const outputPreview = useMemo(() => output.slice(0, 3000), [output]);

  return (
    <BasicTool
      icon={icon}
      trigger={{ title, subtitle, args }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
    >
      <div className="p-2">
        {isError ? (
          <ToolOutputFallback output={output} toolName="triggers" />
        ) : triggerLines.length > 0 ? (
          <div className="space-y-1">
            {triggerLines.map((t, i) =>
              'name' in t ? (
                <div
                  key={`${t.name}|${t.sourceType}:${t.sourceDetail}`}
                  className="hover:bg-muted/30 flex items-center gap-2 rounded px-1 py-1 text-xs"
                >
                  {t.sourceType === 'webhook' ? (
                    <Globe className="text-muted-foreground size-3 shrink-0" />
                  ) : (
                    <CalendarClock className="text-muted-foreground size-3 shrink-0" />
                  )}
                  <span className="text-foreground truncate font-medium">{t.name}</span>
                  <span className="text-muted-foreground ml-auto truncate font-mono text-xs">
                    {t.sourceType === 'webhook' ? t.sourceDetail : t.sourceDetail}
                  </span>
                  <Badge
                    variant={
                      t.status === 'active'
                        ? 'success'
                        : t.status === 'paused'
                          ? 'warning'
                          : 'muted'
                    }
                    size="sm"
                    className="shrink-0"
                  >
                    {t.status}
                  </Badge>
                </div>
              ) : (
                <div key={i} className="text-muted-foreground py-0.5 font-mono text-xs">
                  {t.raw}
                </div>
              ),
            )}
          </div>
        ) : output ? (
          <OutputBlock text={outputPreview} />
        ) : (
          <div className="p-3">
            <TextShimmer>
              {action === 'create'
                ? 'Creating trigger...'
                : action === 'delete'
                  ? 'Deleting trigger...'
                  : 'Loading...'}
            </TextShimmer>
          </div>
        )}

        {/* The answer to "create a trigger" is the trigger — its name, its
            schedule, its status, all above. The prompt the trigger will run
            with is the instruction that produced it, and it is a paragraph,
            so it folds. */}
        {action === 'create' && typeof input.prompt === 'string' && (
          <div className="border-border/30 mt-2 border-t pt-2">
            <FoldedSection label="Prompt">
              <OutputBlock
                text={input.prompt.slice(0, 400) + (input.prompt.length > 400 ? '...' : '')}
              />
            </FoldedSection>
          </div>
        )}
      </div>
    </BasicTool>
  );
}
ToolRegistry.register('triggers', TriggersTool);
ToolRegistry.register('oc-triggers', TriggersTool);
ToolRegistry.register('trigger_create', TriggersTool);
ToolRegistry.register('trigger-create', TriggersTool);
ToolRegistry.register('oc-trigger_create', TriggersTool);
ToolRegistry.register('oc-trigger-create', TriggersTool);
ToolRegistry.register('trigger_list', TriggersTool);
ToolRegistry.register('trigger-list', TriggersTool);
ToolRegistry.register('oc-trigger_list', TriggersTool);
ToolRegistry.register('oc-trigger-list', TriggersTool);
ToolRegistry.register('trigger_get', TriggersTool);
ToolRegistry.register('trigger-get', TriggersTool);
ToolRegistry.register('oc-trigger_get', TriggersTool);
ToolRegistry.register('oc-trigger-get', TriggersTool);
ToolRegistry.register('trigger_delete', TriggersTool);
ToolRegistry.register('trigger-delete', TriggersTool);
ToolRegistry.register('oc-trigger_delete', TriggersTool);
ToolRegistry.register('oc-trigger-delete', TriggersTool);
ToolRegistry.register('trigger_update', TriggersTool);
ToolRegistry.register('trigger-update', TriggersTool);
ToolRegistry.register('oc-trigger_update', TriggersTool);
ToolRegistry.register('oc-trigger-update', TriggersTool);
ToolRegistry.register('trigger_test', TriggersTool);
ToolRegistry.register('trigger-test', TriggersTool);
ToolRegistry.register('oc-trigger_test', TriggersTool);
ToolRegistry.register('oc-trigger-test', TriggersTool);
ToolRegistry.register('trigger_pause', TriggersTool);
ToolRegistry.register('trigger-pause', TriggersTool);
ToolRegistry.register('oc-trigger_pause', TriggersTool);
ToolRegistry.register('oc-trigger-pause', TriggersTool);
ToolRegistry.register('trigger_resume', TriggersTool);
ToolRegistry.register('trigger-resume', TriggersTool);
ToolRegistry.register('oc-trigger_resume', TriggersTool);
ToolRegistry.register('oc-trigger-resume', TriggersTool);
