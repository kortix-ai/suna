'use client';

/**
 * /debug/genui — every generative UI block the agent can write, rendered by the real web renderer.
 *
 * Each sample goes through `UnifiedMarkdown` with `genui`, as the settled transcript renders a
 * reply: the ```openui fence reaches the lazy `GenuiMessageBlock` through `MarkdownCode`. The
 * replay goes through `ThrottledMarkdown`, the transcript's streaming renderer (KRTX-2119 repro).
 * Blocks render as UI whatever the Rich answers preference says (`GenuiForceEnabledContext`).
 * No `genui_block` telemetry: no turn scope is provided. Theme: the /debug toggle, or press `D`.
 */

import { useEffect, useMemo, useState } from 'react';

import { UnifiedMarkdown } from '@kortix/ui/markdown';
import { Button } from '@kortix/ui/button';
import { Textarea } from '@kortix/ui/textarea';
import { GenuiTelemetryContext, GenuiForceEnabledContext } from '@kortix/ui/genui';
import { ThrottledMarkdown } from '@kortix/ui/session';
import { cn } from '@kortix/ui';
// eslint-disable-next-line no-restricted-imports -- a debug route chunk: parse issues and the markdown fallback
import { genuiBlockToMarkdown, parseGenui, type GenuiIssue } from '@kortix/sdk/genui';

import {
  CHILD_ONLY,
  GENUI_SAMPLES,
  genuiCatalog,
  PLAYGROUND_SOURCE,
  type GenuiSample,
} from './samples';

const fence = (source: string) => `\`\`\`openui\n${source}\n\`\`\``;
const sectionId = (sample: GenuiSample) =>
  (sample.title ?? sample.component).toLowerCase().replace(/[^a-z0-9]+/g, '-');

const CATALOG = genuiCatalog();

const REPLAY_PROSE = 'Here is the replayed block.';
const REPLAY_TICK_MS = 50;
const REPLAY_SPEEDS = [
  { label: 'Slow', chars: 2 },
  { label: 'Normal', chars: 8 },
  { label: 'Fast', chars: 32 },
] as const;

function IssueList({ issues }: { issues: GenuiIssue[] }) {
  if (issues.length === 0) return <p className="text-muted-foreground text-xs">No parse issues.</p>;
  return (
    <ul className="space-y-1" data-genui-issues="">
      {issues.map((issue, i) => (
        <li key={i} className="text-kortix-red font-mono text-xs wrap-anywhere">
          {issue.code}
          {issue.statementId ? ` · ${issue.statementId}` : ''}
          {issue.component ? ` · ${issue.component}` : ''} — {issue.message}
        </li>
      ))}
    </ul>
  );
}

function SourceFold({ source }: { source: string }) {
  return (
    <details className="group" data-genui-source="">
      <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-xs select-none">
        OpenUI source
      </summary>
      <pre className="bg-muted text-foreground mt-2 overflow-x-auto rounded-md px-3 py-2 font-mono text-xs">
        {source}
      </pre>
    </details>
  );
}

function GallerySection({ sample }: { sample: GenuiSample }) {
  const entry = CATALOG.find((c) => c.name === sample.component);
  const children = CATALOG.filter(
    (c) => CHILD_ONLY[c.name] === sample.component && sample.source.includes(`${c.name}(`),
  );
  const issues = useMemo(() => parseGenui(sample.source).issues, [sample.source]);
  return (
    <section
      id={sectionId(sample)}
      data-genui-section={sample.title ?? sample.component}
      className="bg-popover border-border scroll-mt-4 space-y-3 rounded-md border px-4 py-3"
    >
      <header className="space-y-1">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-foreground text-sm font-medium">
            {sample.title ?? sample.component}
          </h2>
          <span
            className={cn('text-xs', issues.length ? 'text-kortix-red' : 'text-muted-foreground')}
          >
            {issues.length} {issues.length === 1 ? 'issue' : 'issues'}
          </span>
        </div>
        {entry ? (
          <>
            <p className="text-muted-foreground text-xs">{entry.description}</p>
            <p className="text-muted-foreground font-mono text-xs wrap-anywhere">
              {entry.signature}
            </p>
          </>
        ) : null}
        {children.map((child) => (
          <p key={child.name} className="text-muted-foreground font-mono text-xs wrap-anywhere">
            {child.signature} <span className="font-sans">— {child.description}</span>
          </p>
        ))}
        {sample.note ? <p className="text-foreground text-xs">{sample.note}</p> : null}
      </header>
      {sample.invalid ? <IssueList issues={issues} /> : null}
      <div className="border-border border-t">
        <UnifiedMarkdown content={fence(sample.source)} trust="agent" genui />
      </div>
      <SourceFold source={sample.source} />
    </section>
  );
}

function Playground({
  source,
  onSourceChange,
}: {
  source: string;
  onSourceChange: (source: string) => void;
}) {
  const issues = useMemo(() => parseGenui(source).issues, [source]);
  const markdown = useMemo(() => genuiBlockToMarkdown(source), [source]);
  return (
    <section
      id="playground"
      data-genui-section="Playground"
      className="bg-popover border-border scroll-mt-4 space-y-3 rounded-md border px-4 py-3"
    >
      <header className="space-y-1">
        <h2 className="text-foreground text-sm font-medium">Playground</h2>
        <p className="text-muted-foreground text-xs">
          Edit the OpenUI source. The block below renders on every change.
        </p>
      </header>
      <Textarea
        aria-label="OpenUI source"
        data-genui-playground-input=""
        value={source}
        onChange={(event) => onSourceChange(event.target.value)}
        spellCheck={false}
        minHeight={240}
        maxHeight={480}
        className="font-mono text-xs"
      />
      <div className="border-border border-t" data-genui-playground-output="">
        <UnifiedMarkdown content={fence(source)} trust="agent" genui />
      </div>
      <div className="border-border grid gap-3 border-t pt-3 md:grid-cols-2">
        <div className="space-y-2">
          <h3 className="text-foreground text-xs font-medium">Parse issues</h3>
          <IssueList issues={issues} />
        </div>
        <div className="space-y-2">
          <h3 className="text-foreground text-xs font-medium">
            Markdown fallback (Slack, Copy, Export)
          </h3>
          <pre
            data-genui-markdown=""
            className="bg-muted text-foreground max-h-80 overflow-auto rounded-md px-3 py-2 font-mono text-xs whitespace-pre-wrap"
          >
            {markdown || '(empty)'}
          </pre>
        </div>
      </div>
    </section>
  );
}

function Replay({ source }: { source: string }) {
  const [shown, setShown] = useState<number | null>(null);
  const [cut, setCut] = useState(false);
  const [speed, setSpeed] = useState<number>(REPLAY_SPEEDS[1].chars);
  const total = source.length;
  const running = shown !== null && shown < total && !cut;

  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(
      () => setShown((n) => Math.min(total, (n ?? 0) + speed)),
      REPLAY_TICK_MS,
    );
    return () => clearTimeout(timer);
  }, [running, shown, speed, total]);

  // The model closes the fence when it finishes. A cut-off turn ends with the fence still open.
  const content =
    shown === null
      ? ''
      : `${REPLAY_PROSE}\n\n\`\`\`openui\n${source.slice(0, shown)}${running || cut ? '' : '\n```'}`;
  const state = shown === null ? 'idle' : running ? 'streaming' : cut ? 'cut-off' : 'settled';

  return (
    <section
      id="replay"
      data-genui-section="Streaming replay"
      className="bg-popover border-border scroll-mt-4 space-y-3 rounded-md border px-4 py-3"
    >
      <header className="space-y-1">
        <h2 className="text-foreground text-sm font-medium">Streaming replay</h2>
        <p className="text-muted-foreground text-xs">
          Replays the playground source into ThrottledMarkdown, the transcript&apos;s streaming
          renderer: <span className="font-mono">isStreaming</span> is true while it runs, then the
          fence closes and it turns false. Cut off ends the turn with the fence open. KRTX-2119
          repro.
        </p>
      </header>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="xs"
          onClick={() => {
            setCut(false);
            setShown(0);
          }}
        >
          {shown === null ? 'Play' : 'Restart'}
        </Button>
        <Button size="xs" variant="outline" disabled={!running} onClick={() => setCut(true)}>
          Cut off
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={shown === null}
          onClick={() => {
            setCut(false);
            setShown(null);
          }}
        >
          Reset
        </Button>
        <span className="text-muted-foreground ml-2 text-xs">Speed</span>
        {REPLAY_SPEEDS.map((option) => (
          <Button
            key={option.label}
            size="xs"
            variant={speed === option.chars ? 'secondary' : 'ghost'}
            aria-pressed={speed === option.chars}
            onClick={() => setSpeed(option.chars)}
          >
            {option.label}
          </Button>
        ))}
        <span data-replay-state={state} className="text-muted-foreground ml-auto font-mono text-xs">
          {state} · {shown ?? 0}/{total}
        </span>
      </div>
      <div className="border-border min-h-20 border-t" data-genui-replay-output="">
        {shown === null ? null : <ThrottledMarkdown content={content} isStreaming={running} />}
      </div>
    </section>
  );
}

export default function GenuiDebugPage() {
  const [source, setSource] = useState(PLAYGROUND_SOURCE);
  return (
    <GenuiForceEnabledContext.Provider value>
      <GenuiTelemetryContext.Provider value={null}>
        <main className="bg-background min-h-dvh">
          <div className="mx-auto w-full max-w-3xl space-y-5 px-4 py-10 pb-20">
            <header className="space-y-2">
              <h1 className="text-foreground text-xl font-medium">Generative UI</h1>
              <p className="text-muted-foreground text-xs">
                Every catalog block, rendered by the web renderer the transcript uses. Blocks render
                as UI even with Rich answers off. No telemetry fires from this page.
              </p>
              <nav className="flex flex-wrap gap-x-3 gap-y-1">
                {[
                  ...GENUI_SAMPLES.map((s) => ({
                    id: sectionId(s),
                    label: s.title ?? s.component,
                  })),
                  { id: 'playground', label: 'Playground' },
                  { id: 'replay', label: 'Replay' },
                ].map((link) => (
                  <a
                    key={link.id}
                    href={`#${link.id}`}
                    className="text-muted-foreground hover:text-foreground text-xs"
                  >
                    {link.label}
                  </a>
                ))}
              </nav>
            </header>
            {GENUI_SAMPLES.map((sample) => (
              <GallerySection key={sectionId(sample)} sample={sample} />
            ))}
            <Playground source={source} onSourceChange={setSource} />
            <Replay source={source} />
          </div>
        </main>
      </GenuiTelemetryContext.Provider>
    </GenuiForceEnabledContext.Provider>
  );
}
