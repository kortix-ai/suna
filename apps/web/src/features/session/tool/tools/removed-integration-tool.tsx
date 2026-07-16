'use client';
import { SessionRetryDisplay, TurnErrorDisplay } from '@/features/session/session-error-banner';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import {
  BasicTool,
  ToolOutputFallback,
  ToolSurfaceContext,
  partOutput,
  partStatus,
} from '@/features/session/tool/shared/infrastructure';
import { ToolPartRenderer } from '@/features/session/tool/tool-part-renderer';
import { useSyncStore } from '@/stores/opencode-sync-store';
import {
  Plug,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  getChildSessionError,
  getRetryInfo,
  getRetryMessage,
  type MessageWithParts,
  type ToolPart,
} from '@/ui';


export function RemovedIntegrationTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const output = partOutput(part);

  return (
    <BasicTool
      icon={<Plug className="size-3.5 flex-shrink-0" />}
      trigger={
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="text-foreground text-xs font-medium whitespace-nowrap">
            {tHardcodedUi.raw(
              'componentsSessionToolRenderers.line5270JsxTextLegacyIntegrationTool',
            )}
          </span>
          <span className="text-muted-foreground/60 ml-auto text-xs font-medium whitespace-nowrap">
            removed
          </span>
        </div>
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      <div className="space-y-2 px-3 py-2.5">
        <p className="text-muted-foreground text-xs leading-relaxed">
          {tHardcodedUi.raw(
            'componentsSessionToolRenderers.line5283JsxTextThisLegacyIntegrationToolSurfaceHasBeenRemoved',
          )}
        </p>
        {output ? (
          <ToolOutputFallback
            output={output}
            isStreaming={partStatus(part) === 'running'}
            toolName="legacy-integration"
          />
        ) : null}
      </div>
    </BasicTool>
  );
}
[
  'integration-list',
  'integration-connect',
  'integration-search',
  'integration-actions',
  'integration-run',
  'integration-request',
  'integration-exec',
].forEach((toolName) => ToolRegistry.register(toolName, RemovedIntegrationTool));

function SubAgentActivity({
  childSessionId,
  parts,
}: {
  childSessionId?: string;
  parts: ToolPart[];
}) {
  if (parts.length === 0) return null;
  return (
    <ToolSurfaceContext.Provider value="inline">
      <div className="space-y-1">
        {parts.map((tp) => (
          <ToolPartRenderer
            key={tp.callID}
            part={tp}
            sessionId={childSessionId}
            disableNavigation
          />
        ))}
      </div>
    </ToolSurfaceContext.Provider>
  );
}

function SubAgentStatusBanner({
  childSessionId,
  childMessages,
}: {
  childSessionId?: string;
  childMessages?: MessageWithParts[];
}) {
  const childStatus = useSyncStore((s) =>
    childSessionId ? s.sessionStatus[childSessionId] : undefined,
  );
  const retryInfo = useMemo(() => getRetryInfo(childStatus), [childStatus]);
  const retryMessage = useMemo(() => getRetryMessage(childStatus), [childStatus]);
  const childError = useMemo(() => getChildSessionError(childMessages), [childMessages]);

  const [secondsLeft, setSecondsLeft] = useState(0);
  useEffect(() => {
    if (!retryInfo) {
      setSecondsLeft(0);
      return;
    }
    const tick = () =>
      setSecondsLeft(Math.max(0, Math.round((retryInfo.next - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [retryInfo]);

  if (retryInfo && retryMessage) {
    return (
      <SessionRetryDisplay
        message={retryMessage}
        attempt={retryInfo.attempt}
        secondsLeft={secondsLeft}
        className="mt-2"
      />
    );
  }

  if (childError) {
    return <TurnErrorDisplay errorText={childError} className="mt-2" />;
  }

  return null;
}

