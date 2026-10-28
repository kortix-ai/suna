import { YamlLine } from '@/features/marketing/code-panel';

import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@kortix/ui';

import { ArrowDownIcon } from '@phosphor-icons/react/dist/ssr';
import type { ReactNode } from 'react';

import { FILES } from './content';
import { localizeMarketingContent as localizeModel, type Excerpt } from './model';

/*
 * One focused visual per How it works tab. Each fits the tab's panel at
 * 390 px: one column, a short real excerpt, a few marks at most.
 */

const caption = 'text-muted-foreground font-mono text-xs tracking-wide uppercase';

/** One file: a title bar, then its lines. YAML is tinted, a shell prompt
 *  is muted, anything else is plain text. */
function FilePanel({
  title,
  lines,
  lang,
}: {
  title: string;
  lines: readonly string[];
  lang?: 'yaml' | 'sh';
}) {
  const render = (line: string): ReactNode => {
    if (line === '') return ' ';
    if (lang === 'yaml') return <YamlLine line={line} />;
    if (lang === 'sh' && line.startsWith('$'))
      return (
        <>
          <span className="text-muted-foreground select-none">$</span>
          {line.slice(1)}
        </>
      );
    return line;
  };
  return (
    <div className="bg-background flex min-w-0 flex-col rounded-lg border">
      <p className="text-muted-foreground border-b px-4 py-3 font-mono text-xs">{title}</p>
      <pre className="text-foreground overflow-x-auto px-5 py-4 font-mono text-xs leading-6">
        <code>
          {lines.map((line, i) => (
            // A fixed, ordered snippet: the index is the identity of the line.
            <span
              key={`${title}-${i}`}
              className="block leading-6 break-words whitespace-pre-wrap lg:min-w-max lg:whitespace-pre"
            >
              {render(line)}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

const ManifestPanel = ({ excerpt }: { excerpt: Excerpt }) => {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  return <FilePanel title={tMarketing('text1965f383021e')} lang="yaml" lines={excerpt.lines} />;
};

function AgentsPanel() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { agentFiles } = localizeModel(tMarketing);

  return (
    <div className="flex flex-col gap-3">
      <ManifestPanel excerpt={agentFiles.yaml} />
      <FilePanel title={agentFiles.promptPath} lines={FILES[agentFiles.promptPath] ?? []} />
    </div>
  );
}

function ComputerPanel() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { computer } = localizeModel(tMarketing);

  return (
    <div className="flex flex-col">
      <div className="bg-background flex flex-col gap-4 rounded-lg border border-dashed p-5">
        <span className="text-foreground text-base font-medium">
          {tMarketing('text33fdae079088')}
        </span>
        <ul className="flex flex-col divide-y">
          {computer.inside.map((row) => (
            <li
              key={row.k}
              className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2.5"
            >
              <span
                className={cn(
                  'text-foreground text-sm',
                  row.k.startsWith('/') || row.k === 'pi' ? 'font-mono' : '',
                )}
              >
                {row.k}
              </span>
              <span className="text-muted-foreground text-sm">{row.v}</span>
            </li>
          ))}
        </ul>
      </div>
      <ArrowDownIcon aria-hidden className="text-muted-foreground mx-auto my-2 size-4" />
      <div className="bg-background flex flex-col gap-3 rounded-lg border p-5">
        <span className={caption}>{tMarketing('textb853a89073bc')}</span>
        <ul className="flex flex-col gap-2">
          {computer.outside.map((row) => (
            <li
              key={row.k}
              className="flex flex-wrap items-baseline justify-between gap-x-4 text-sm"
            >
              <span className="text-foreground">{row.k}</span>
              <span className="text-muted-foreground">{row.v}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export const FRAMEWORK_PANELS: Record<string, () => ReactNode> = {
  agents: () => <AgentsPanel />,
  rules: function RulesPanel() {
    const tMarketing = useTranslations('hardcodedUi.i18nComplete');
    const { rulesYaml } = localizeModel(tMarketing);
    return <FilePanel title={tMarketing('text1965f383021e')} lang="yaml" lines={rulesYaml} />;
  },
  triggers: function TriggersPanel() {
    const tMarketing = useTranslations('hardcodedUi.i18nComplete');

    const { triggerFiles } = localizeModel(tMarketing);
    return <ManifestPanel excerpt={triggerFiles} />;
  },
  computer: () => <ComputerPanel />,
  review: function ReviewPanel() {
    const tMarketing = useTranslations('hardcodedUi.i18nComplete');
    const { reviewTerminal } = localizeModel(tMarketing);
    return <FilePanel title={tMarketing('text4e686af7bdcc')} lang="sh" lines={reviewTerminal} />;
  },
  build: function BuildPanel() {
    const tMarketing = useTranslations('hardcodedUi.i18nComplete');
    const { uiSample } = localizeModel(tMarketing);
    return <FilePanel title={tMarketing('text2e9f6a751196')} lines={uiSample} />;
  },
};
