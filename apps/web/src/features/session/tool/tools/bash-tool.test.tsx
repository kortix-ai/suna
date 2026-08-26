import { ToolRunningContext } from '@/features/session/tool/shared/infrastructure';
import { ToolSurfaceContext } from '@/features/session/tool/shared/surface';
import type { ToolPart } from '@/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { BashTool, bashRowTitle, dedentCommand } from './bash-tool';

// Regression guard for `code.slice is not a function`.
//
// `CommandBlock` used to route its RICH output branch through
// `HighlightedCode`: `code={richOutput as unknown as string}`. `richOutput` is
// a React element, not source text, and `shikiKey` calls `.slice` on its
// `code` argument — from inside a `useState` INITIALIZER, so it threw during
// render and the error boundary swallowed the whole tool part. The double cast
// was the only thing letting an element past a prop typed `string`.
//
// `renderToStaticMarkup` reproduces it exactly: useState initializers run
// during a synchronous render, so a throw here is the same throw the browser
// hit. Each of the three rich branches gets its own case — they are three
// independent parsers feeding one shared crash site.

function withProviders(node: ReactNode) {
  const queryClient = new QueryClient();
  return (
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
      <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
    </NextIntlClientProvider>
  );
}

function makePart(command: string, output: string, description?: string): ToolPart {
  return {
    type: 'tool',
    tool: 'bash',
    callID: 'call-1',
    state: {
      status: 'completed',
      input: description === undefined ? { command } : { command, description },
      output,
      metadata: {},
    },
  } as unknown as ToolPart;
}

/**
 * The settled row's leading words, sliced out of the markup.
 *
 * The trigger's title is the FIRST span inside the title row (the one carrying
 * `min-w-0 truncate`), so every title assertion below is anchored to that
 * element rather than to bare text — a `toContain('Ran command')` over the
 * whole document would also pass if the phrase landed anywhere else, and the
 * command's own mono line sits two spans away.
 *
 * The marker doubles as the pin on the title's own geometry: the title span
 * must stay shrinkable (`min-w-0 truncate`) now that it can hold a sentence,
 * and a `shrink-0` regression returns '' here and fails every case below.
 */
function triggerTitle(html: string): string {
  const marker = html.indexOf('class="min-w-0 truncate ');
  if (marker < 0) return '';
  const start = html.lastIndexOf('<span', marker);
  return html.slice(start, html.indexOf('</span>', marker) + '</span>'.length);
}

// `hasStructuredContent` fires on a Python traceback.
const TRACEBACK = [
  'Traceback (most recent call last):',
  '  File "/workspace/main.py", line 3, in <module>',
  '    raise ValueError("boom")',
  'ValueError: boom',
].join('\n');

// `parseSessionMetadataOutput` needs `===` + a JSON blob carrying `id` + `time`.
const SESSION_META = [
  '=== /workspace/.kortix/sessions/ses_abc.json',
  JSON.stringify({
    id: 'ses_abc',
    slug: 'refactor-pricing',
    title: 'Refactor pricing',
    time: { created: 1_700_000_000, updated: 1_700_000_100 },
  }),
].join('\n');

// `parseSessionMessagesOutput` needs at least one `--- Msg N [role] cost=$X ---`.
const SESSION_MESSAGES = [
  '--- Msg 1 [user] cost=$0.0012 ---',
  'Ship the new pricing page',
  '--- Msg 2 [assistant] cost=$0.0340 ---',
  'On it.',
].join('\n');

describe('BashTool renders rich output without pushing elements through Shiki', () => {
  test('a traceback renders the structured-output block instead of throwing', () => {
    const html = renderToStaticMarkup(
      withProviders(<BashTool part={makePart('python main.py', TRACEBACK)} defaultOpen />),
    );

    // Pre-fix this render threw `code.slice is not a function`.
    expect(html).toContain('ValueError');
    expect(html).toContain('python main.py');
  });

  test('session metadata output renders the session list', () => {
    const html = renderToStaticMarkup(
      withProviders(<BashTool part={makePart('kortix sessions list', SESSION_META)} defaultOpen />),
    );

    expect(html).toContain('Refactor pricing');
    expect(html).toContain('1 session');
  });

  test('session messages output renders the message list', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <BashTool part={makePart('kortix sessions messages', SESSION_MESSAGES)} defaultOpen />,
      ),
    );

    expect(html).toContain('2 messages');
    expect(html).toContain('Ship the new pricing page');
  });

  test('plain output still renders as monospace text, not a rich block', () => {
    const html = renderToStaticMarkup(
      withProviders(<BashTool part={makePart('echo hi', 'hi')} defaultOpen />),
    );

    expect(html).toContain('echo hi');
    expect(html).toContain('hi');
  });
});

// The command card's geometry, asserted on the emitted class attributes.
//
// Every one of these was broken at once, and all four were invisible to the
// existing tests because they only checked that text reached the DOM: the
// command sat at `px-0` against the card border while its own output sat at
// 12px, the copy button was a flex sibling centred on the vertical middle of a
// three-line command, `pr-9` reserved space for a control that ALSO took real
// width, and `SHIKI_RESET`'s `text-sm` on the <code> beat the <pre>'s inherited
// `text-xs`, drawing the command at 14px over 12px output.
//
// Class strings are the contract here because they are the whole bug — there
// is no behavior to assert, only geometry. Arbitrary variants arrive
// HTML-escaped (`[&_code]` → `[&amp;_code]`), so match a substring that skips
// the ampersand.
describe('BashTool command card geometry', () => {
  const html = renderToStaticMarkup(
    withProviders(<BashTool part={makePart('echo hi', 'hi')} defaultOpen />),
  );

  test('command and output share one left edge', () => {
    expect(html).toContain('p-3 pr-11');
    expect(html).not.toContain('px-0');
  });

  test('the copy button floats instead of sitting in a flex row', () => {
    expect(html).toContain('absolute top-2 right-2');
    expect(html).not.toContain('justify-between');
    expect(html).not.toContain('pr-9');
  });

  test('the highlighted command inherits the 12px type size', () => {
    expect(html).toContain('_code]:text-xs');
  });

  // NEW CONTRACT (spec W9): one line height across the whole card. The two
  // panes carried the arbitrary `leading-[1.65]`; both now carry the
  // `leading-relaxed` token, and the pre also overrides it onto the
  // highlighted `<code>`. That last clause is the load-bearing one:
  // `HighlightedCode` hardcodes `text-sm leading-[1.65]` on its own element,
  // so — exactly like the `[&_code]:text-xs` fight above — the pane's leading
  // only reaches the command through a `[&_code]:` variant. `iam/audit-tab.tsx`
  // pairs the same two overrides for the same reason.
  test('both panes share one line-height, and the command follows the pane not Shiki', () => {
    expect(html.match(/font-mono text-xs leading-relaxed/g)?.length).toBe(2);
    expect(html).toContain('_code]:leading-relaxed');
  });

  test('the empty state stands where a line of output would', () => {
    // `text-xs` alone is a flat 16px line, so the "No output" region used to
    // sit 3.5px shorter than the region it speaks for and the card twitched
    // between a silent command and a one-line one.
    const empty = renderToStaticMarkup(
      withProviders(<BashTool part={makePart('mkdir -p build', '')} defaultOpen />),
    );
    const marker = empty.indexOf('No output');
    const openTag = empty.slice(empty.lastIndexOf('<p', marker), marker);

    expect(openTag).toContain('p-3 text-xs leading-relaxed');
  });
});

// The indent lines a card up with the trigger row's TEXT column, which exists
// only on the inline surface — the panel has no icon gutter and brings its own
// `p-4`, so the same indent just pushed the card off its header.
//
// The value is a variable with a 1.375rem (22px) default rather than a literal
// `ml-5.5`, because a surface that overrides the row's `gap-1.5` moves the text
// column the indent is supposed to match. The chain of thought does exactly
// that (`turn/activity-step.tsx` forces `gap-3`), and a hardcoded 22px left the
// card 6px short of every other row's content. Unset, the default is the same
// 22px this suite has always asserted.
// A shell's verdict, which nothing in the row could report.
//
// `partOutcome` — the predicate the chain uses for its warning mark — looks for
// an `Error:` prefix or the `{success:false}` contract, and a shell returns
// neither: a failing test run prints its failures to stdout exactly as a
// passing one prints its successes, and the heuristic gives up above 500
// characters anyway. So a red build and a green build drew the identical row,
// and the only way to tell them apart was to expand the card and read the log.
//
// The code was in the output the whole time, in the `<exit_code>` tag the bash
// tool appends — which `partOutput` strips before any renderer sees it.
describe('BashTool reports whether the command actually worked', () => {
  test('a failed command says so in words, without being expanded', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <BashTool part={makePart('bun test', 'FAIL 3 tests\n<exit_code>1</exit_code>')} />,
      ),
    );

    expect(html).toContain('Command failed');
    expect(html).not.toContain('Ran command');
  });

  test('a successful command keeps the neutral wording', () => {
    const html = renderToStaticMarkup(
      withProviders(<BashTool part={makePart('ls', 'a.txt\n<exit_code>0</exit_code>')} />),
    );

    expect(html).toContain('Ran command');
    expect(html).not.toContain('Command failed');
  });

  test('an untagged command is not accused of failing', () => {
    // No `<exit_code>` is an ABSENT verdict, not a bad one. Treating a missing
    // tag as 0 would be the same lie in the other direction.
    const html = renderToStaticMarkup(withProviders(<BashTool part={makePart('ls', 'a.txt')} />));

    expect(html).toContain('Ran command');
    expect(html).not.toContain('Command failed');
  });

  test('the exact code appears once, in the expanded card', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <BashTool part={makePart('bun test', 'FAIL\n<exit_code>2</exit_code>')} defaultOpen />,
      ),
    );

    expect(html).toContain('Exit code 2');
  });

  test('a successful command carries no exit-code line', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <BashTool part={makePart('ls', 'a.txt\n<exit_code>0</exit_code>')} defaultOpen />,
      ),
    );

    expect(html).not.toContain('Exit code');
  });
});

// NEW CONTRACT (spec W9), replacing "every settled bash row is titled 'Ran
// command'": when the model wrote a `description` for its own call, that
// sentence IS the row's title, and the command stays beside it as the mono
// secondary line. The fallback is untouched — no description means "Ran
// command", and nothing is ever derived from the command text, so a row can
// only claim a purpose the model actually stated.
//
// The failure tests above are deliberately left as they were: their fixtures
// carry no description, so they now pin the fallback path too. The verdict's
// precedence over a description gets its own case here.
describe('bashRowTitle — the row says what the command was for (W9)', () => {
  test('a description becomes the title, with only its opener lifted', () => {
    expect(bashRowTitle('install the workspace dependencies', false)).toBe(
      'Install the workspace dependencies',
    );
  });

  test('an opener that is already capital is left exactly alone', () => {
    // Sentence-casing the whole string would read "Run ci on the release
    // branch" — worse than the capitals it replaced.
    expect(bashRowTitle('Run CI on the release branch', false)).toBe(
      'Run CI on the release branch',
    );
    expect(bashRowTitle('CI smoke test', false)).toBe('CI smoke test');
  });

  test('a multi-line description collapses onto one line', () => {
    // A trigger row is one line whatever the input does.
    expect(bashRowTitle('  run the\n  unit suite  ', false)).toBe('Run the unit suite');
  });

  test('a long description is cut at 60 with no space stranded before the ellipsis', () => {
    const title = bashRowTitle(
      'rebuild the search index and reconcile every stale document row from the mirror',
      false,
    );

    expect(title).toBe('Rebuild the search index and reconcile every stale document…');
    // The 60-character cut lands right after "document ", which is exactly the
    // case a plain character-count truncate gets wrong: it would keep that
    // space and render "document …". The trimmed tail is why this is 60 and
    // not 61 characters.
    expect(title.length).toBe(60);
    expect(title).not.toContain(' …');
  });

  test('a description of exactly the limit keeps every character', () => {
    const sixty = 'a'.repeat(60);

    expect(bashRowTitle(sixty, false)).toBe(`A${'a'.repeat(59)}`);
    expect(bashRowTitle(sixty, false)).not.toContain('…');
  });

  test('no usable description falls back to exactly the old wording', () => {
    expect(bashRowTitle(undefined, false)).toBe('Ran command');
    expect(bashRowTitle('', false)).toBe('Ran command');
    expect(bashRowTitle('   \n  ', false)).toBe('Ran command');
    // Inputs arrive as unvalidated JSON; a non-string is not a summary.
    expect(bashRowTitle(42, false)).toBe('Ran command');
  });

  test('a failure keeps its verdict however good the description is', () => {
    // The one thing a friendly title must never soften.
    expect(bashRowTitle('install the workspace dependencies', true)).toBe('Command failed');
    expect(bashRowTitle(undefined, true)).toBe('Command failed');
  });
});

describe('BashTool trigger renders the title the helper answers (W9)', () => {
  test('a described call leads with the description and keeps the command beside it', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <BashTool part={makePart('pnpm install', 'done', 'install the workspace dependencies')} />,
      ),
    );

    expect(triggerTitle(html)).toBe(
      '<span class="min-w-0 truncate text-foreground">Install the workspace dependencies</span>',
    );
    // The command is not replaced by the summary, only demoted.
    expect(html).toContain('font-mono">pnpm install</span>');
    expect(html).not.toContain('Ran command');
  });

  test('a call with no description still reads "Ran command"', () => {
    const html = renderToStaticMarkup(withProviders(<BashTool part={makePart('ls -la', 'out')} />));

    expect(triggerTitle(html)).toBe(
      '<span class="min-w-0 truncate text-foreground">Ran command</span>',
    );
  });

  test('a failed call stays red and refuses the description', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <BashTool
          part={makePart(
            'bun test',
            'FAIL 3 tests\n<exit_code>1</exit_code>',
            'run the unit suite',
          )}
        />,
      ),
    );

    expect(triggerTitle(html)).toBe(
      '<span class="min-w-0 truncate text-kortix-red">Command failed</span>',
    );
    // Neither as written nor sentence-cased.
    expect(html).not.toContain('run the unit suite');
    expect(html).not.toContain('Run the unit suite');
    // The failure's own command still shows, so the row is not just a verdict.
    expect(html).toContain('font-mono">bun test</span>');
  });

  test('a RUNNING call is unchanged — the description titles a settled row only', () => {
    // Mid-flight the row already shimmers the live command under "Running
    // command"; swapping in a past-tense summary would report a result the
    // call has not returned.
    const running = {
      type: 'tool',
      tool: 'bash',
      callID: 'call-1',
      state: {
        status: 'running',
        input: { command: 'pnpm install', description: 'install the workspace dependencies' },
        metadata: {},
      },
    } as unknown as ToolPart;
    const html = renderToStaticMarkup(
      withProviders(
        <ToolRunningContext.Provider value>
          <BashTool part={running} />
        </ToolRunningContext.Provider>,
      ),
    );

    expect(html).toContain('Running command');
    expect(html).not.toContain('Install the workspace dependencies');
  });

  test('an ORPHANED running call — no ToolRunningContext — falls back to the description title', () => {
    // `running` comes from context, not from `state.status`, so a `running`
    // part rendered outside a provider (a replayed transcript, a dev-tools
    // one-off, the panel's own detail views) takes the SETTLED branch and is
    // titled by its description. Pinned so a future change to that fallback is
    // a deliberate one: the alternatives (shimmer without a live stream, or a
    // bare "Ran command" on a call that has not returned) are both worse, but
    // neither is currently guarded by anything.
    const orphaned = {
      type: 'tool',
      tool: 'bash',
      callID: 'call-1',
      state: {
        status: 'running',
        input: { command: 'pnpm install', description: 'install the workspace dependencies' },
        metadata: {},
      },
    } as unknown as ToolPart;
    const html = renderToStaticMarkup(withProviders(<BashTool part={orphaned} />));

    expect(triggerTitle(html)).toBe(
      '<span class="min-w-0 truncate text-foreground">Install the workspace dependencies</span>',
    );
    expect(html).not.toContain('Running command');
  });
});

describe('BashTool card, for the cases with nothing to show', () => {
  test('a multi-line command admits there is more than the line shown', () => {
    // A collapsed row drew line 1 of a 30-line heredoc and said nothing about
    // the other 29, so a whole script looked like a one-liner.
    const html = renderToStaticMarkup(
      withProviders(<BashTool part={makePart('cat <<EOF\ntwo\nthree\nEOF', 'done')} />),
    );

    expect(html).toContain('+3');
  });

  test('a single-line command carries no line count', () => {
    const html = renderToStaticMarkup(withProviders(<BashTool part={makePart('ls -la', 'out')} />));

    expect(html).not.toContain('+0');
  });

  test('a settled command that printed nothing says so', () => {
    // The region used to be omitted entirely, leaving a command card with dead
    // space under it — indistinguishable from output we failed to capture.
    const html = renderToStaticMarkup(
      withProviders(<BashTool part={makePart('mkdir -p build', '')} defaultOpen />),
    );

    expect(html).toContain('No output');
  });

  test('a RUNNING command never claims it produced nothing', () => {
    // Silence mid-flight means "not yet". Saying "No output" would report a
    // result the call has not returned.
    const running = {
      type: 'tool',
      tool: 'bash',
      callID: 'call-1',
      state: { status: 'running', input: { command: 'sleep 10' }, metadata: {} },
    } as unknown as ToolPart;
    const html = renderToStaticMarkup(withProviders(<BashTool part={running} defaultOpen />));

    expect(html).not.toContain('No output');
  });

  test('command and output scroll independently', () => {
    // One shared `max-h-96` used to wrap both, so 200 lines of build log pushed
    // the command off the top of its own card — the reader lost the only line
    // saying what they were looking at. Two regions, two caps.
    const html = renderToStaticMarkup(
      withProviders(<BashTool part={makePart('bun test', 'x\n'.repeat(200))} defaultOpen />),
    );

    expect(html).toContain('max-h-64');
    expect(html).toContain('max-h-80');
    expect(html).not.toContain('max-h-96');
  });

  test('the output gets its own copy button', () => {
    // The command had one; the output — the half a reader wants to paste into
    // an issue — had none.
    const html = renderToStaticMarkup(
      withProviders(<BashTool part={makePart('ls', 'a.txt')} defaultOpen />),
    );

    expect(html.match(/absolute top-2 right-2/g)?.length).toBe(2);
  });
});

// The panel de-nest, for the FOURTH card.
//
// `shared/infrastructure.test.tsx` pins the other three — `ToolOutputCard`,
// `ToolCodeCard`, `ToolResultCard` — against the same gate finding: on the
// panel the row card is already the frame and the disclosure body is already
// the inset, so a payload that draws its own is a second edge and a second
// gutter around one thing. Bash's command card is a fourth card with a
// hand-rolled frame, so it was invisible to that sweep and unpinned until now.
//
// It de-nests on a SHARPER rule than the other three, which is the reason it
// needs its own pin. They drop the whole inset. This one cannot: the hairline
// between the command pane and the output pane is internal to this card, and
// text pressed against that line from both sides is worse than the redundant
// frame ever was. So `paneInset` keeps the VERTICAL half (`py-2` where inline
// has `p-3`) and lets the row body's `px-3` be the horizontal gutter. Assert
// both halves — the frame going away AND the inset shrinking rather than
// vanishing — because either one alone is a different, wrong card.
//
// Element-anchored, like the geometry suite above: read the open tag of the
// element in question rather than substring-matching the whole document, so a
// class landing on some unrelated node cannot satisfy the assertion.
describe('BashTool command card de-nests on the panel (gate finding 5, fourth card)', () => {
  const part = makePart('echo hi', 'hi');

  function render(surface: 'inline' | 'panel') {
    const tool = <BashTool part={part} defaultOpen />;
    return renderToStaticMarkup(
      withProviders(
        surface === 'panel' ? (
          <ToolSurfaceContext.Provider value="panel">{tool}</ToolSurfaceContext.Provider>
        ) : (
          tool
        ),
      ),
    );
  }

  /** The open tag of the element at `at`, found by walking back to its `<`. */
  function openTagAt(html: string, at: number) {
    return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
  }

  /** The card's own wrapper — the `relative` div that holds the command pane. */
  const cardTag = (html: string) =>
    openTagAt(html, html.lastIndexOf('<div class="relative', html.indexOf('max-h-64')));

  /** The `<pre>` the highlighted command is drawn in. */
  const commandPaneTag = (html: string) => openTagAt(html, html.indexOf('<pre'));

  /** The div holding the raw output text, inside the output pane's scroller. */
  const outputPaneTag = (html: string) =>
    openTagAt(html, html.lastIndexOf('<div', html.indexOf('>hi<')));

  test('inline: the card draws its own frame and both panes take the full 12px inset', () => {
    const html = render('inline');

    expect(cardTag(html)).toContain('border-border bg-popover rounded-md border');
    expect(commandPaneTag(html)).toContain('p-3 pr-11');
    expect(outputPaneTag(html)).toContain('p-3 pr-11');
  });

  test('panel: the frame is gone — the row card already drew it', () => {
    const html = render('panel');
    const card = cardTag(html);

    expect(card).not.toContain('bg-popover');
    expect(card).not.toContain('rounded-md');
    expect(card).not.toContain('border');
    // The card element itself survives; only its chrome went.
    expect(card).toContain('relative');
  });

  test('panel: the inset shrinks to the vertical half, not to nothing', () => {
    const html = render('panel');

    // `py-2`, not `p-3` — the row body's `px-3` is the horizontal gutter now,
    // but the command/output hairline still needs air above and below it.
    for (const tag of [commandPaneTag(html), outputPaneTag(html)]) {
      expect(tag).toContain('py-2 pr-11');
      expect(tag).not.toContain('p-3');
    }
  });

  test('panel: the empty state keeps the same vertical inset as a pane of output', () => {
    // Otherwise a command that printed nothing sits at a different height from
    // one that printed a line, and the card twitches between the two.
    const html = renderToStaticMarkup(
      withProviders(
        <ToolSurfaceContext.Provider value="panel">
          <BashTool part={makePart('mkdir -p build', '')} defaultOpen />
        </ToolSurfaceContext.Provider>,
      ),
    );

    expect(openTagAt(html, html.indexOf('>No output<'))).toContain('py-2 text-xs leading-relaxed');
  });

  test('panel: the hairline BETWEEN the two panes stays — it is not the frame', () => {
    // The de-nest drops edges the row card can redraw. This one separates the
    // command from what it printed, which nothing outside the card can say.
    expect(render('panel')).toContain('border-border/60 border-t');
  });
});

// The card's `whitespace-pre-wrap` pane renders the command VERBATIM, so
// incidental leading whitespace (a model quoting a command out of indented
// YAML) drew the first line two characters deeper than its own wrapped
// continuation — an inverse hanging indent the trigger row could not show,
// because its `truncate` span collapses spaces under normal white-space.
describe('dedentCommand — incidental indent never reaches the pane', () => {
  test('a single indented line loses its leading spaces', () => {
    expect(dedentCommand('  agent-browser open http://x/')).toBe('agent-browser open http://x/');
  });

  test('a multi-line script loses only the SHARED margin', () => {
    expect(dedentCommand('  if true; then\n    echo hi\n  fi')).toBe(
      'if true; then\n  echo hi\nfi',
    );
  });

  test('a heredoc with its terminator at column 0 is untouched', () => {
    // A non-`<<-` heredoc pins the common indent to 0 — dedent must be a
    // no-op exactly where indentation is load-bearing.
    const heredoc = 'cat <<EOF\n  indented body\nEOF';
    expect(dedentCommand(heredoc)).toBe(heredoc);
  });

  test('blank lines neither block the dedent nor gain content', () => {
    expect(dedentCommand('  a\n\n  b')).toBe('a\n\nb');
  });

  test('a trailing newline stops counting as a phantom extra line', () => {
    expect(dedentCommand('ls -la\n')).toBe('ls -la');
  });

  test('the rendered card starts the command at the pane inset, not two characters in', () => {
    const html = renderToStaticMarkup(
      withProviders(<BashTool part={makePart('  echo hi', 'hi')} defaultOpen />),
    );

    expect(html).toContain('echo hi');
    expect(html).not.toContain('  echo hi');
  });
});

describe('BashTool indent is surface-aware', () => {
  const part = makePart('echo hi', 'hi');
  const INDENT = 'ml-[var(--tool-indent,1.375rem)]';

  test('inline keeps the icon-gutter indent', () => {
    const html = renderToStaticMarkup(withProviders(<BashTool part={part} defaultOpen />));

    expect(html).toContain(INDENT);
    // NEW (Task 19): the seam is gated on the same condition as the indent, so
    // the command card lands on the inline surface exactly as it always did.
    expect(html).toContain('mt-1.5');
  });

  test('the panel drops it', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <ToolSurfaceContext.Provider value="panel">
          <BashTool part={part} defaultOpen />
        </ToolSurfaceContext.Provider>,
      ),
    );

    expect(html).not.toContain(INDENT);
    expect(html).not.toContain('--tool-indent');
    // NEW (Task 19): and the seam with it — the panel body is already
    // `px-3 py-3`, so a card that adds `mt-1.5` double-spaces its own top.
    expect(html).not.toContain('mt-1.5');
  });
});
