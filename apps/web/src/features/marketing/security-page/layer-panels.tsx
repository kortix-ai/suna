import { CodePanel } from '@/features/marketing/code-panel';

import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@kortix/ui';

import { ArrowDownIcon, CaretRightIcon, CheckIcon, XIcon } from '@phosphor-icons/react/dist/ssr';
import type { ReactNode } from 'react';

import { localizeMarketingContent as localizeModel } from './model';
import { Verdict } from './parts';

/*
 * One focused visual per layer tab. Each fits the tab's panel at 390px:
 * a single column, base-size labels, no more than a few marks.
 */

const caption = 'text-muted-foreground font-mono text-xs tracking-wide uppercase';

function Ladder({ title, rungs }: { title: string; rungs: readonly string[] }) {
  return (
    <div className="flex flex-col gap-2">
      <span className={caption}>{title}</span>
      <ol className="flex flex-wrap items-center gap-1.5">
        {rungs.map((rung, i) => (
          <li key={rung} className="flex items-center gap-1.5">
            <span className="bg-background text-foreground rounded-md border px-3 py-1.5 text-base">
              {rung}
            </span>
            {i < rungs.length - 1 ? (
              <CaretRightIcon aria-hidden className="text-muted-foreground size-3.5" />
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

function IdentityPanel() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { roles } = localizeModel(tMarketing);

  return (
    <div className="flex flex-col gap-6">
      <Ladder title={tMarketing('textad8cbd037148')} rungs={roles.account} />
      <Ladder title={tMarketing('text93cdb5341490')} rungs={roles.project} />
      <div className="flex flex-col gap-2">
        <span className={caption}>{tMarketing('text5bbbe53187ad')}</span>
        <ul className="flex flex-wrap gap-1.5">
          {roles.signIn.map((item) => (
            <li key={item} className="bg-muted text-foreground rounded-md px-2.5 py-1 text-sm">
              {item}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function ComputerPanel() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { computerBox } = localizeModel(tMarketing);

  const list = (items: readonly string[], keep: boolean) => (
    <ul className="flex flex-col gap-2">
      {items.map((item) => (
        <li
          key={item}
          className={cn(
            'flex items-start gap-2 text-base',
            keep ? 'text-foreground' : 'text-muted-foreground',
          )}
        >
          {keep ? (
            <CheckIcon aria-hidden className="mt-1 size-4 shrink-0" weight="bold" />
          ) : (
            <XIcon aria-hidden className="mt-1 size-4 shrink-0" weight="bold" />
          )}
          {item}
        </li>
      ))}
    </ul>
  );
  return (
    <div className="bg-background flex flex-col gap-5 rounded-lg border border-dashed p-5">
      <span className="text-foreground text-base font-medium">
        {tMarketing('text33fdae079088')}
      </span>
      <div className="flex flex-col gap-2">
        <span className={caption}>{tMarketing('text7f1d4110839d')}</span>
        {list(computerBox.holds, true)}
      </div>
      <div className="flex flex-col gap-2 border-t border-dashed pt-4">
        <span className={caption}>{tMarketing('texte3c297d8068e')}</span>
        {list(computerBox.never, false)}
      </div>
    </div>
  );
}

function ConnectorsPanel() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { approval } = localizeModel(tMarketing);

  return (
    <div className="flex flex-col gap-4">
      <div className="bg-background flex flex-col gap-4 rounded-lg border p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <code className="text-foreground font-mono text-sm">{approval.call}</code>
          <Verdict kind="ask" label={tMarketing('textdb0e960b68b5')} />
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
          {approval.args.map((arg) => (
            <div key={arg.k} className="contents">
              <dt className="text-muted-foreground font-mono text-xs leading-5">{arg.k}</dt>
              <dd className="text-foreground min-w-0 truncate">{arg.v}</dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-wrap items-center gap-2 border-t pt-4">
          {/* A picture of the card, not a control: the labels are not buttons. */}
          <span className="bg-foreground text-background rounded-md px-3 py-1.5 text-sm font-medium">
            {tMarketing('text6007acbe30b2')}
          </span>
          <span className="text-foreground rounded-md border px-3 py-1.5 text-sm font-medium">
            {tMarketing('text05a2d7332eb9')}
          </span>
          <span className="text-muted-foreground ms-auto text-xs">{approval.expires}</span>
        </div>
      </div>
      <ul className="flex flex-wrap gap-2">
        <li>
          <Verdict kind="allow" label={tMarketing('textf32a91808be4')} />
        </li>
        <li>
          <Verdict kind="ask" label={tMarketing('text4d3c93cd2cd6')} />
        </li>
        <li>
          <Verdict kind="block" label={tMarketing('text60656a88b0cb')} />
        </li>
      </ul>
    </div>
  );
}

function SecretsPanel() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { secretModes } = localizeModel(tMarketing);

  return (
    <ul className="bg-background flex flex-col divide-y rounded-lg border">
      {secretModes.map((mode) => (
        <li key={mode.k} className="flex flex-col gap-1 p-4">
          <div className="flex items-center gap-2">
            <span className="text-foreground text-base font-medium">{mode.k}</span>
            {mode.tag ? (
              <span className="text-muted-foreground font-mono text-xs">{mode.tag}</span>
            ) : null}
          </div>
          <span className="text-muted-foreground text-sm text-pretty">{mode.v}</span>
        </li>
      ))}
    </ul>
  );
}

function Path({ steps }: { steps: readonly { k: string; v: ReactNode }[] }) {
  return (
    <ol className="flex flex-col">
      {steps.map((step, i) => (
        <li key={step.k} className="flex flex-col">
          <div
            className={cn(
              'bg-background flex flex-wrap items-center justify-between gap-2 rounded-lg border px-4 py-3',
              i === 1 && 'border-foreground',
            )}
          >
            <span className="text-foreground text-base font-medium">{step.k}</span>
            <span className="text-muted-foreground text-sm">{step.v}</span>
          </div>
          {i < steps.length - 1 ? (
            <ArrowDownIcon aria-hidden className="text-muted-foreground mx-auto my-2 size-4" />
          ) : null}
        </li>
      ))}
    </ol>
  );
}

export const LAYER_PANELS: Record<string, () => ReactNode> = {
  identity: () => <IdentityPanel />,
  agent: function AgentPanel() {
    const tMarketing = useTranslations('hardcodedUi.i18nComplete');

    const { agentYaml } = localizeModel(tMarketing);
    return <CodePanel title={agentYaml.title} lines={agentYaml.lines} lang="yaml" />;
  },
  computer: () => <ComputerPanel />,
  connectors: () => <ConnectorsPanel />,
  secrets: () => <SecretsPanel />,
  models: function ModelsPanel() {
    const tMarketing = useTranslations('hardcodedUi.i18nComplete');

    const { modelPath } = localizeModel(tMarketing);
    return <Path steps={modelPath} />;
  },
  changes: function ChangesPanel() {
    const tMarketing = useTranslations('hardcodedUi.i18nComplete');

    const { changePath } = localizeModel(tMarketing);
    return (
      <Path
        steps={changePath.map((s) => ({
          k: s.k,
          v: <code className="font-mono text-xs">{s.chip}</code>,
        }))}
      />
    );
  },
};
