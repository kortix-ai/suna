import { CodePanel } from '@/features/marketing/code-panel';

import { useTranslations } from '@/i18n/use-translations';

import type { ReactNode } from 'react';

import { localizeMarketingContent as localizeContent, type TopicId } from './content';
import { Terminal, Window } from './parts';

/*
 * One focused visual per topic tab. Each fits the tab's panel at 390 px: one
 * column or a short table, base-size labels, lines that wrap.
 */

const caption = 'text-muted-foreground font-mono text-xs tracking-wide uppercase';

function WherePanel() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { whereRows } = localizeContent(tMarketing);

  return (
    <table className="bg-background w-full table-fixed border-separate border-spacing-0 rounded-lg border text-left text-sm">
      <caption className="sr-only">{tMarketing('text2ec67e173f1e')}</caption>
      <thead>
        <tr>
          <th scope="col" className="w-5/12 border-b p-3 font-normal">
            <span className="sr-only">{tMarketing('text8570a2e1669f')}</span>
          </th>
          <th scope="col" className={`border-b p-3 font-normal ${caption}`}>
            {tMarketing('text493bdb7154e4')}
          </th>
          <th scope="col" className={`border-b p-3 font-normal ${caption}`}>
            {tMarketing('textbeafec79ffdd')}
          </th>
        </tr>
      </thead>
      <tbody>
        {whereRows.map((row, i) => {
          const edge = i < whereRows.length - 1 ? 'border-b' : '';
          return (
            <tr key={row.k}>
              <th scope="row" className={`text-foreground p-3 align-top font-medium ${edge}`}>
                {row.k}
              </th>
              <td className={`text-muted-foreground p-3 align-top ${edge}`}>{row.cloud}</td>
              <td className={`text-foreground p-3 align-top ${edge}`}>{row.self}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function UpdatesPanel() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { updateTracks } = localizeContent(tMarketing);

  return (
    <ul className="bg-background flex flex-col divide-y rounded-lg border">
      {updateTracks.map((track) => (
        <li key={track.k} className="flex flex-col gap-1 p-4">
          <div className="flex items-center gap-2">
            <code className="text-foreground font-mono text-sm font-medium">{track.k}</code>
            {track.tag ? <span className="text-muted-foreground text-xs">{track.tag}</span> : null}
          </div>
          <span className="text-muted-foreground text-sm text-pretty">{track.v}</span>
        </li>
      ))}
    </ul>
  );
}

function ModelsPanel() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { modelOrder } = localizeContent(tMarketing);

  return (
    <div className="flex flex-col gap-3">
      <span className={caption}>{tMarketing('text0661a8cc9ef3')}</span>
      <ol className="bg-background flex flex-col divide-y rounded-lg border">
        {modelOrder.map((item, i) => (
          <li key={item} className="flex items-center gap-4 px-4 py-3">
            <span className="text-muted-foreground w-4 shrink-0 font-mono text-xs tabular-nums">
              {i + 1}
            </span>
            <span className="text-foreground text-base">{item}</span>
          </li>
        ))}
      </ol>
      <span className="text-muted-foreground text-sm">{tMarketing('text3f6dbbaa3aa4')}</span>
    </div>
  );
}

const terminal = (title: string, lines: readonly string[]) => (
  <Window title={title}>
    <Terminal lines={lines} className="p-4" />
  </Window>
);

export const TOPIC_PANELS: Record<TopicId, () => ReactNode> = {
  where: () => <WherePanel />,
  install: function InstallPanel() {
    const tMarketing = useTranslations('hardcodedUi.i18nComplete');

    const { installLines } = localizeContent(tMarketing);
    return terminal('Terminal: your server', installLines);
  },
  updates: () => <UpdatesPanel />,
  models: () => <ModelsPanel />,
  files: function FilesPanel() {
    const tMarketing = useTranslations('hardcodedUi.i18nComplete');

    const { filesLines } = localizeContent(tMarketing);
    return terminal('Terminal: your laptop', filesLines);
  },
  secrets: function SecretsPanel() {
    const tMarketing = useTranslations('hardcodedUi.i18nComplete');

    const { secretsYaml } = localizeContent(tMarketing);
    return <CodePanel title={secretsYaml.title} lines={secretsYaml.lines} lang="yaml" />;
  },
};
