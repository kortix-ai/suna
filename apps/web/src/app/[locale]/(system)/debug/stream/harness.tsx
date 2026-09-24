'use client';

/**
 * The /debug/stream harness body. Loaded with `ssr: false` by `page.tsx`: its
 * first state comes from the URL and its setup links carry this page's origin,
 * and neither exists on the server.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { SESSION_TRANSCRIPT_CLASS } from '@/features/session/session-body';
import { SessionBusyIndicator } from '@/features/session/session-busy-indicator';
import { ThrottledMarkdown } from '@/features/session/turn/throttled-markdown';

/** Tokens are several hundred URL-safe characters; the length is what matters. */
const FAKE_TOKEN = `ksl_${'eyJwIjoiZGVidWciLCJrIjoic3RyZWFtIn0'.repeat(9)}`;

interface Scenario {
  id: string;
  label: string;
  text: (origin: string) => string;
}

const SCENARIOS: Scenario[] = [
  {
    id: 'setup-link',
    label: 'Setup link',
    text: (origin) =>
      [
        'Here’s a fresh Outlook authorization link:',
        '',
        `[Connect Outlook](${origin}/connect/${FAKE_TOKEN})`,
        '',
        'It expires in about 30 minutes. Sign in with your Microsoft account, then reply **done**.',
      ].join('\n'),
  },
  {
    // The link shares a paragraph with the bold line above it (one newline,
    // not a blank line), so the card is a block inside inline content.
    id: 'setup-links-under-headings',
    label: 'Setup links under headings',
    text: (origin) =>
      [
        'Both links are ready — **24h TTL, yours alone**:',
        '',
        '📅 **Google Calendar (member level — you@example.com):**',
        `[Authorize my private Calendar](${origin}/connect/${FAKE_TOKEN})`,
        '',
        '📄 **Google Docs (member level — you@example.com):**',
        `[Authorize my private Docs](${origin}/connect/${FAKE_TOKEN}2)`,
        '',
        'Two notes:',
        '',
        '1. Open them while signed into Google as you@example.com.',
        '2. Once both are authorized, I will verify the identities and clean up.',
      ].join('\n'),
  },
  {
    id: 'secret-link',
    label: 'Secret link',
    text: (origin) =>
      [
        'I need an API key to call the service.',
        '',
        `[Add the API key](${origin}/secret-intake/${FAKE_TOKEN})`,
        '',
        'The value stays encrypted; I only see that it exists.',
      ].join('\n'),
  },
  {
    id: 'bare-setup-url',
    label: 'Bare setup URL',
    text: (origin) =>
      `Open this to connect Gmail: ${origin}/connect/${FAKE_TOKEN}\n\nReply **done** when it says connected.`,
  },
  {
    id: 'reference-links',
    label: 'Reference links',
    text: () =>
      [
        'Two sources, cited by reference: [the docs][1] and [the changelog][2].',
        '',
        'A second paragraph, so the definitions land in a later block.',
        '',
        '[1]: https://kortix.com/docs',
        '[2]: https://kortix.com/changelog',
      ].join('\n'),
  },
  {
    id: 'links-and-list',
    label: 'Links and a list',
    text: () =>
      [
        'A list, then links. See [the changelog](https://kortix.com/changelog) for context:',
        '',
        '- The first item',
        '- The second item, with `inline code`',
        '- The last item, which is the last child while it streams',
        '',
        'A bare URL: https://kortix.com/docs',
      ].join('\n'),
  },
];

/** ~100 characters a second, about what a model streams. */
const TICK_MS = 40;
const CHARS_PER_TICK = 4;

function Control({
  label,
  onClick,
  active = false,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="border-border text-muted-foreground hover:text-foreground aria-pressed:bg-muted aria-pressed:text-foreground rounded-md border px-3 py-1.5 text-xs"
    >
      {label}
    </button>
  );
}

/**
 * The first state, from `?scenario=…&at=…&working=…`. `until=<text>` stops just
 * after the first occurrence of that text, so a check can name a phase without
 * counting characters. With neither `at` nor `until`, the replay plays from 0.
 */
function replayFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const scenario = SCENARIOS.find((s) => s.id === params.get('scenario')) ?? SCENARIOS[0];
  const text = scenario.text(window.location.origin);
  const atParam = params.get('at');
  const until = params.get('until');
  const untilIndex = until ? text.indexOf(until) : -1;
  const at =
    untilIndex !== -1
      ? untilIndex + (until?.length ?? 0)
      : atParam === 'end'
        ? text.length
        : Math.min(text.length, Math.max(0, Number(atParam) || 0));
  return {
    scenarioId: scenario.id,
    at,
    working: params.get('working') !== '0',
    play: atParam === null && until === null,
  };
}

export function DebugStreamHarness() {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } }),
  );
  const [initial] = useState(replayFromUrl);
  const [scenarioId, setScenarioId] = useState(initial.scenarioId);
  const [at, setAt] = useState(initial.at);
  const [working, setWorking] = useState(initial.working);
  const [play, setPlay] = useState(initial.play);

  const scenario = SCENARIOS.find((s) => s.id === scenarioId) ?? SCENARIOS[0];
  // Setup links are recognised by origin, so the text carries the real one.
  const text = useMemo(() => scenario.text(window.location.origin), [scenario]);
  const playing = play && at < text.length;

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(
      () => setAt((current) => Math.min(text.length, current + CHARS_PER_TICK)),
      TICK_MS,
    );
    return () => clearInterval(timer);
  }, [playing, text]);

  const restart = (id: string) => {
    setScenarioId(id);
    setAt(0);
    setWorking(true);
    setPlay(true);
  };

  const shown = text.slice(0, at);

  return (
    <QueryClientProvider client={queryClient}>
      <div className="bg-background min-h-dvh">
        <header className="border-border bg-background sticky top-0 z-10 border-b">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-7 py-4">
            <div className="space-y-0.5">
              <h1 className="text-foreground text-sm font-medium">Streaming markdown</h1>
              <p className="text-muted-foreground text-xs">
                One assistant message, replayed through the transcript renderer.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {SCENARIOS.map((s) => (
                <Control
                  key={s.id}
                  label={s.label}
                  active={s.id === scenario.id}
                  onClick={() => restart(s.id)}
                />
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Control
                label={playing ? 'Pause' : 'Play'}
                onClick={() => {
                  if (at >= text.length) setAt(0);
                  setWorking(true);
                  setPlay(!playing);
                }}
              />
              <Control
                label="Step +8"
                onClick={() => {
                  setPlay(false);
                  setAt((a) => Math.min(text.length, a + 8));
                }}
              />
              <Control
                label="To end"
                onClick={() => {
                  setPlay(false);
                  setAt(text.length);
                }}
              />
              <Control
                label={working ? 'Turn: working' : 'Turn: ended'}
                active={!working}
                onClick={() => setWorking((w) => !w)}
              />
              <span
                data-testid="stream-position"
                className="text-muted-foreground font-mono text-xs tabular-nums"
              >
                {at}/{text.length}
              </span>
            </div>
          </div>
        </header>

        <div role="log" className={SESSION_TRANSCRIPT_CLASS}>
          {/* The same wrapper session-chat.tsx puts around a turn's text. */}
          <div data-testid="stream-replay" className="min-w-0 text-sm">
            {shown ? <ThrottledMarkdown content={shown} isStreaming={working} /> : null}
          </div>
          {working ? <SessionBusyIndicator className="mt-3" /> : null}
        </div>
      </div>
    </QueryClientProvider>
  );
}
