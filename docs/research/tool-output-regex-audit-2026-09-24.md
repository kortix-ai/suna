# Tool-output regex audit (2026-09-24)

Goal: no tool output can freeze the session view. Tool output is text an
attacker can choose: `read` returns file contents, `webfetch` returns web
pages, and `bash` returns command output. Every viewer of a session parses
every tool part in it, so a parser that is super-linear in its input freezes
the tab or the phone of each person who opens the session.

This report covers every regex that runs on tool output while a session
renders, on web (`apps/web`), mobile (`apps/mobile`), and the SDK
(`packages/sdk`). The full per-regex table is
[`tool-output-regex-audit-2026-09-24.csv`](./tool-output-regex-audit-2026-09-24.csv):
1,232 regex sites, each with its V8 and JSC timings and its disposition.

## Method

1. **Inventory.** The TypeScript parser listed every regex literal and every
   `new RegExp(…)` call (not grep) in the tool renderers, their helpers
   (`apps/web/src/lib/utils`, `apps/mobile/lib/session`), and 61 SDK and
   shared files. A second pass followed the import graph of the tool
   renderers with the TypeScript checker, one imported symbol at a time, and
   added every file they reach (1,054 web files, 429 mobile files).
2. **Screening.** Each regex ran in its own child process with a 12 s kill,
   on `node` (V8) and on `bun` (JSC), at 15k, 30k, and 60k characters. The
   attack inputs come from the regex's own syntax tree
   (`@eslint-community/regexpp`): for each quantifier, an example of what
   precedes it, a long run it accepts, and a stopper; the same with a breaker
   character; the prefix repeated; the prefix repeated once per line; and runs
   that end in a line terminator that `.` refuses but `\s` accepts (U+2028,
   U+2029, `\r`). A regex is super-linear when its time grows 3× or more per
   doubling (4× means quadratic, 8× cubic) above 15 ms, or passes 1.5 s.
   Calibration: 8 of 8 known-bad regexes flagged, the linear control not.
3. **Liveness.** Each flagged site was traced from its enclosing function to a
   registered renderer. Mobile's legacy `getExpandedContent` switch is
   unreachable: every tool name in it has a registered renderer, and
   `ToolRegistry.get` resolves it first.
4. **Fixes.** Each fix is test-driven: a parity test against a verbatim copy
   of the old code (seeded fuzz, 3,000 structured strings, with a floor of 600
   matching samples so the fuzz is not vacuous), a timing test (under 100 ms at
   about 240k characters, run first on the old code), and mutation checks (one
   deliberate bug per rule; the fuzz must fail).

## Results

| Disposition | Sites |
|---|---|
| Linear | 1,072 |
| Fixed | 86 |
| Out of scope (not tool output) | 35 |
| Blocked by an open PR from another contributor | 13 |
| Dead code | 10 |
| Dynamic regex, resolved and linear | 10 |
| User-message path, follow-up | 5 |
| Not screened (syntax-highlighter grammars) | 1 |

### Fixed

Both clients held a copy of most parsers. Each parser moved to
`@kortix/shared/tool-output` once, and both clients re-export it. Times are
the old code on the input named; each new reader takes under 100 ms on it.

| Parser | Old regex | Worst input, old time | Commit |
|---|---|---|---|
| `partOutput` | `<bash_metadata>[\s\S]*?<\/bash_metadata>` | 16k unclosed tags: 909 ms | `726341fd78` |
| pty read / spawn | `<pty_output\s+([^>]*)>…`, `<pty_spawned>…` | `<pty_output` + 240k spaces: 22.7 s | `726341fd78` |
| skill document | `Note:.*relative to the base directory.*$` | 48k `Note:` on one line: 4.6 s | `591aeae737` |
| grep | `Line\s+(\d+):\s*([\s\S]*?)(?=\s*(?:Line\s+\d+:\|$))` | a match holding 240k spaces: 27.9 s | `ade1b8d338` |
| session dump | `split(/^={2,}\s*(.*?)\s*={0,}\s*$/m)` | a title holding 240k spaces: over 60 s | `ade1b8d338` |
| session log | `^\s*Tools used:\s*(.+)$` (`m`) | 240k blank lines: 44.5 s | `ade1b8d338` |
| `session_get` | title, counts, `Todos:`, dates, header | 240k digits in the header: 45.7 s | `6bf34eb4c7` |
| `session_search` | `^(ses_\S+)\s*\|\s*"…"\s*\|\s*(\S+.*?)…` | 48k `\|"t"\|` choices: over 60 s | `e0e56a1028` |
| triggers | `^\[(\w+)]\s+(\S+)\s*\|…(.+?)…` | 240k spaces in the detail: 43.7 s | `c238fc9cdd` |
| background workers (mobile) | `\*\*(ses_\S+)\*\*.*?status:…project:…` | 10k starts × 10k statuses: over 60 s | `3c6e90b526` |
| `get_mem` | five lazy field readers, header, bullets | a field holding 240k spaces: over 60 s | `38e8d30fe3` |
| memory search | header, `[LTM/…]` blocks, compact hits | 240k `#`: 39.2 s | `eb545f0c85` |
| projects, connectors (mobile) | table rows, `(proj-…)`, `name (source)` | a row holding 240k spaces: over 60 s | `30de4952f8` |
| `looksLikeMarkdown` | `[link](url)`, `^\s*\d+\.\s+\S` (`m`) | 240k blank lines: 22.4 s | `d0523f11ea` |
| front matter | `\s+$` per line | 60k spaces: 1.4 s (V8; JSC is linear) | `d0523f11ea` |
| image / video path | `^["']+\|["']+$`, sandbox path, `\/+$` | 240k inner quotes: 22.9 s | `6cc437d558` |
| diagnostics (mobile) | block and line regexes | 40k `:1:1 [` candidates: 3.5 s | `fbf4edf5a6` |
| Mermaid front matter | `^\s*config\s*:` (`m`) | 240k blank lines: 23.1 s | `7cf47a620e` |
| SDK `cleanResultSnippet` | markdown image and link strippers | 48k `![a](`: 4.1 s | `3ef13c0c1e` |
| SDK `buildScrapeFailureResults` | per-URL lazy error reader | 240k spaces: 21.9 s | `3ef13c0c1e` |

`afd4450684` deletes three unused local copies of SDK helpers in web
`agent-stop-tool.tsx` and `task-delete-tool.tsx`. Nothing called them.

Each reader reproduces its regex's backtracking exactly, including the
one-character results a regex gives back when only whitespace is left. The
fuzz caught every deliberate bug: 101 of 101 behavior-changing mutations
failed the tests. Eight more mutations changed nothing observable; three of
them exposed dead code, which was removed.

### Blocked

An open PR from another contributor changes each of these files. Each web or
SDK copy still runs the regex; the mobile copy is fixed.

| File | Open PR | Mobile copy |
|---|---|---|
| `apps/web/src/lib/utils/kortix-tool-output.ts` | #5480 | fixed in `30de4952f8` |
| `apps/web/src/features/session/tool/tools/session-list-background-tool.tsx` | #5480 | fixed in `3c6e90b526` |
| `apps/web/src/features/session/tool/tools/project-delete-tool.tsx` (dead code) | #5480 | n/a |
| `apps/web/src/stores/diagnostics-store.ts` | #6734, #6729, #5480 | fixed in `fbf4edf5a6` |
| `packages/sdk/src/browser/stores/diagnostics-store.ts` | #6729 | fixed in `fbf4edf5a6` |
| `apps/web/src/features/session/action-panel/shared/derive-panels.ts` (`\/+$`) | #7257 | n/a |

### Dead code

Mobile `ShellExpandedContent`, `ReadExpandedContent`, `WriteEditExpandedContent`,
and `parseSessionGet` are bodies of the legacy `getExpandedContent` switch in
`components/session/tool/tool-part-renderer.tsx`. A registered renderer
shadows every tool name in the switch, so none of them runs. Their regexes
stay super-linear.

### Linear, with a large constant

- `packages/shared/src/utils/url-autolink.ts:32` (`URL_PATTERN`): bounded
  quantifiers, 2× per doubling. `a.` repeated to 240k characters takes
  2.3 s on JSC and 29 ms on V8.
- `url-autolink.ts:107`: 303 ms at 240k on V8.
- `stripAnsi` (`packages/sdk/src/core/turns/parts.ts:698`, copied in
  `view-model.ts:247`): 90 ms at 240k on V8.

### Outside this scope

These are super-linear but do not run on tool output:

- User-message path: `mention-segments.ts` `TRAILING_PUNCTUATION` (web and
  mobile; 1.7 s at 60k on JSC), web `session-label.ts:143`
  `/<at[^>]*>.*?<\/at>/gi` (40k `<at>`: 1.1 s on V8, 1.8 s on JSC; #6308
  changes the file), web `strip-html-tags.ts` (minimap).
- `\/+$` on paths that are not tool output: 15 web sites (the file browser 9,
  the composer's slash menu 2, recents 1, change vocabulary 1, the setup-link
  page 1, and a service URL 1).
- SDK `merge-steps.ts:205` `stripMarkdown` (reasoning text).
- Configuration and settings text: command templates, model names, IAM
  screens, the setup-link page, upload names, MathJax and Mermaid SVG output,
  and the composer's live markdown.

## Verification

| Check | Result |
|---|---|
| `cd packages/shared && bun test` | 553 pass, 0 fail |
| `packages/shared` `tsc --noEmit` | exit 0 |
| `cd apps/web && bun test --isolate --parallel=4` | 9,933 pass, 1 fail; the base `e0c731be57` fails the same test (content timestamp manifest, fixed on main by #7576) |
| `apps/web` `tsc --noEmit` | 15 errors, the known baseline in 3 test files |
| `cd apps/mobile && bun test` | 2,085 pass, 0 fail |
| `apps/mobile` `tsc --noEmit` | 4 errors, the known baseline |
| `expo export --platform ios` | exit 0; 16 old regex sources are in the base bundle and absent from the new one; 5 controls are in both |
| SDK `typecheck`, `test`, `smoke:install` | exit 0; 3,672 pass, 0 fail; install smoke passed |

## Reproduce

The screening scripts ran from a scratch directory and are not committed.
To rerun a single regex, time it at 15k, 30k, and 60k characters on `node`
and `bun` with the attack input from its row in the CSV. The readers' tests
(`packages/shared/src/tool-output/*.test.ts`,
`packages/sdk/src/core/turns/text-scan.test.ts`) hold the parity oracles and
the timing inputs.
