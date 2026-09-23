/**
 * `pty_spawn`. Port of apps/web `tool/tools/pty-spawn-tool.tsx`:
 * - trigger: `TerminalWindow` · "Started terminal" · the model's title, else
 *   the command — which drops while the row is open (the card prints it);
 * - body: an error output → `ToolOutputFallback`; else a `ToolResultCard`
 *   (`space-y-2 px-2 py-1.5`) with `$ command` (mono `text-xs
 *   leading-relaxed`, `$` at `/50`, command at `text-foreground/80`) and a
 *   meta line (web `InlineMeta`: `text-xs text-muted-foreground/70 gap-2`,
 *   `·` separators at `/30`): the status badge (success + pulsing dot when
 *   running, muted otherwise), the PTY id, `PID n`, the workdir.
 */

import { Fragment, useMemo, type ReactNode } from 'react';
import { View } from 'react-native';
import { isErrorOutput } from '@kortix/sdk';
import { Text } from '@/components/ui/text';
import { TerminalWindowIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { PTY_TEXT, ptySpawnView } from '@/lib/session/tools/files-pty';
import { webSpace } from '@/lib/session/user-message';
import {
  BasicTool,
  partInput,
  partOutput,
  partStatus,
  ToolOutputFallback,
  ToolResultCard,
} from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { TURN_TYPE, monoFont, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';
import { ToneBadge } from './apply-patch-tool';

/** Web `InlineMeta`: items on one line, `·` between them, each truncating. */
function InlineMeta({ items }: { items: ReactNode[] }) {
  const palette = useTurnPalette();
  return (
    <View style={{ minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: webSpace(2) }}>
      {items.map((item, i) => (
        <Fragment key={i}>
          {i > 0 ? (
            <Text variant="muted" style={[TURN_TYPE.xs, { color: palette.muted30 }]}>
              ·
            </Text>
          ) : null}
          <View style={{ flexShrink: 1, minWidth: 0 }}>{item}</View>
        </Fragment>
      ))}
    </View>
  );
}

export function PtySpawnTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const palette = useTurnPalette();
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const view = useMemo(() => ptySpawnView(input, output), [input, output]);

  const metaText = (value: string) => (
    <Text variant="muted" numberOfLines={1} style={[TURN_TYPE.xs, { fontFamily: monoFont, color: palette.muted70 }]}>
      {value}
    </Text>
  );
  const meta: ReactNode[] = [];
  if (view.processStatus) {
    const live = view.processStatus === 'running';
    meta.push(
      <ToneBadge tone={live ? 'success' : 'muted'} dot={live ? { pulse: true } : undefined} uppercase={live}>
        {view.processStatus}
      </ToneBadge>,
    );
  }
  if (view.ptyId) meta.push(metaText(view.ptyId));
  if (view.pid) meta.push(metaText(`PID ${view.pid}`));
  if (view.workdir) meta.push(metaText(view.workdir));

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={TerminalWindowIcon}
      trigger={{
        title: PTY_TEXT.startedTerminal,
        subtitle: view.subtitle,
        hideSubtitleWhenOpen: view.hideSubtitleWhenOpen,
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {status === 'completed' && isErrorOutput(output) ? (
        <ToolOutputFallback output={output} toolName="pty_spawn" />
      ) : (
        <ToolResultCard>
          <View style={{ rowGap: webSpace(2), paddingHorizontal: webSpace(2), paddingVertical: webSpace(1.5) }}>
            {view.command ? (
              <Text variant="muted" selectable style={[TURN_TYPE.xsRelaxed, { fontFamily: monoFont }]}>
                <Text style={{ color: palette.muted50 }}>$</Text>{' '}
                <Text style={{ color: palette.foreground80 }}>{view.command}</Text>
              </Text>
            ) : null}
            {view.hasMeta ? <InlineMeta items={meta} /> : null}
          </View>
        </ToolResultCard>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('pty_spawn', PtySpawnTool);
