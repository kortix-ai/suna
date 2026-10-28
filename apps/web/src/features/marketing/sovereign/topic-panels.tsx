import { CodePanel } from '@/features/marketing/code-panel';
import type { ReactNode } from 'react';

import { filesLines, installLines, modelOrder, secretsYaml, updateTracks, whereRows, type TopicId } from './content';
import { Terminal, Window } from './parts';

/*
 * One focused visual per topic tab. Each fits the tab's panel at 390 px: one
 * column or a short table, base-size labels, lines that wrap.
 */

const caption = 'text-muted-foreground font-mono text-xs tracking-wide uppercase';

function WherePanel() {
  return (
    <table className="bg-background w-full table-fixed border-separate border-spacing-0 rounded-lg border text-left text-sm">
      <caption className="sr-only">What runs where</caption>
      <thead>
        <tr>
          <th scope="col" className="w-5/12 border-b p-3 font-normal">
            <span className="sr-only">Part</span>
          </th>
          <th scope="col" className={`border-b p-3 font-normal ${caption}`}>
            Kortix Cloud
          </th>
          <th scope="col" className={`border-b p-3 font-normal ${caption}`}>
            Self-hosted
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
  return (
    <div className="flex flex-col gap-3">
      <span className={caption}>Which model a session uses</span>
      <ol className="bg-background flex flex-col divide-y rounded-lg border">
        {modelOrder.map((item, i) => (
          <li key={item} className="flex items-center gap-4 px-4 py-3">
            <span className="text-muted-foreground w-4 shrink-0 font-mono text-xs tabular-nums">{i + 1}</span>
            <span className="text-foreground text-base">{item}</span>
          </li>
        ))}
      </ol>
      <span className="text-muted-foreground text-sm">The first one that is set wins.</span>
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
  install: () => terminal('Terminal: your server', installLines),
  updates: () => <UpdatesPanel />,
  models: () => <ModelsPanel />,
  files: () => terminal('Terminal: your laptop', filesLines),
  secrets: () => <CodePanel title={secretsYaml.title} lines={secretsYaml.lines} lang="yaml" />,
};
