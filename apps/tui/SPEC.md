# Kortix TUI — `apps/tui` (experimental)

A full terminal client for Kortix. It is a thin consumer of `@kortix/sdk`,
rendered with OpenTUI (`@opentui/core` + `@opentui/react`), and runs on Bun.
It mirrors `apps/web`'s session product: sidebar (accounts, projects,
sessions), session view (transcript, composer, pickers), and the right-hand
terminal panel. Secondary surfaces (files, review, apps, customize, members,
billing) follow in later waves.

Status: **experimental**. Not in the release CLI bundle. Run from the repo.

---

## 1. Non-negotiable constraints (from `CLAUDE.md`)

1. `@kortix/sdk` is the source of truth. `apps/tui` never calls the Kortix API
   with raw `fetch`, never imports `@opencode-ai/sdk`, never hand-rolls
   transport. Missing capability → add it to the SDK (load the `sdk` skill:
   TDD, three synchronized edits per new export, no version bump).
2. One client per host: `createKortix({ backendUrl, getToken, clientSource: 'tui' })`
   created once at boot. Auth is `getToken` only.
3. A whole session is one hook: `useSession(projectId, sessionId)` from
   `@kortix/sdk/react`. No separate `/start` driver, no separate SSE provider,
   no health poller in the host.
4. Session-scoped, provider-agnostic. Never resolve a runtime from ambient
   state.
5. Never write a plaintext secret into a tracked file.
6. Brand: monochrome surfaces, one accent, dense-but-legible. No decorative
   color. Terminal analogue of the Jay/Kortix aesthetic.
7. Communication in commits/PR/docs: ASD-STE100 style. Facts, numbers, files.

## 2. Stack decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Runtime | Bun ≥ 1.3 | OpenTUI targets Bun; the repo's CLI is Bun. |
| TUI engine | `@opentui/core` 0.5.11 | Native Zig renderer used by opencode; flexbox layout; `Markdown`, `Diff`, `Code`, `ScrollBox`, `Textarea`, `EmbeddedTerminal` renderables. |
| Binding | `@opentui/react` 0.5.11 + React 19 | Lets the TUI consume `@kortix/sdk/react` hooks verbatim (`useSession`, `useProjectSessions`, …). This is the same thin-consumer contract `apps/web` has. Solid was the earlier research pick; React wins because the SDK's session hook is React. |
| State/query | `@tanstack/react-query` ^5.75 | SDK peer dependency. One `QueryClient` at boot. |
| Auth source | `~/.config/kortix/config.json` via `@kortix/cli` `src/api/config.ts` | Same hosts/tokens as `kortix login`. `KORTIX_API_URL` + `KORTIX_API_KEY` env override for scripts. |
| Component kit | Own primitives in `src/ui/*`; `@tuiparts/react` only if a primitive is not trivial (dialog, checkbox). termcn as reference only. | Keep the dependency graph small; the brand kit is ours. |
| Key routing | `@opentui/keymap` if it fits; otherwise a small `src/keymap.ts` | One keymap table; help overlay renders from it. |

Package: `@kortix/tui`, `private: true`, `apps/tui`. Entries: `src/main.tsx`
(`runTui(options)`, the app as a function) and `src/index.tsx` (the
standalone `dev` wrapper that owns `process.exit`). `kortix tui` calls
`runTui` through a dynamic import, so no other subcommand loads React or the
OpenTUI native library.
Scripts: `dev` (`bun run src/index.tsx`), `typecheck`, `keymap`, `test`
(`bun test`). Dependencies: `@kortix/sdk` (workspace), `@kortix/cli`
(workspace, deep imports — the allowlist below), `@opentui/core`,
`@opentui/react`, `react`, `@tanstack/react-query`. `tsconfig.json`:
`"jsx": "react-jsx"`, `"jsxImportSource": "@opentui/react"`, extends
`@tsconfig/bun`.

**`@kortix/cli` deep-import allowlist.** `@kortix/cli` publishes no barrel for
these, so the TUI reaches into its source. That is allowed for exactly five
modules and nothing else — anything not on this list is either SDK work or a
new entry here, decided deliberately:

| Module | What the TUI takes | Used by |
| --- | --- | --- |
| `src/api/config.ts` | `Host`, `loadConfig`, `activeHostName`, `listHosts`, `getHost`, `upsertHost`, `removeHost`, `useHost`, `validateHostName`, `secureRemoteBase` | `auth/hosts.ts`, `features/login` |
| `src/api/sdk.ts` | `sdkBackendUrl` — the one rule for when `http` is legitimate | `auth/hosts.ts`, `features/login` |
| `src/web-url.ts` | `webDashboardUrl` — the billing/settings link the TUI prints instead of running checkout | `features/account/account-screen.tsx` |
| `src/attach-opencode.ts` | `attachOpenCodeSession`, `AttachOpenCodeError` — SPEC §5.11's seam | `features/attach` |
| `src/api/auth.ts` | `Auth`, the type that seam takes | `features/attach` |

pnpm note: `minimumReleaseAge` is 72 h; `@opentui/*` 0.5.11 was published
2026-09-07 and resolves. Add nothing to `onlyBuiltDependencies` unless install
fails; report if it does.

**Why the six `@opentui/core-<platform>` packages are direct dependencies.**
`@opentui/core` declares its prebuilt native libraries as `optionalDependencies`
gated on `os`/`cpu`, so pnpm installs only the current machine's. `bun build
--compile --target=bun-<os>-<arch>` inlines `process.platform`/`process.arch`
and keeps exactly the matching `await import("@opentui/core-<os>-<arch>")`
branch, which then has to RESOLVE at build time — otherwise every cross-target
CLI bundle dies on `Could not resolve: "@opentui/core-linux-x64"`. Declaring
all six here puts them in pnpm's hoisted store next to `@opentui/core`, where
Bun finds them for every target. `pnpm tui:bundle:all` and the release
workflows — which cross-compile all four targets on one linux-x64 runner —
depend on this. Both libc variants stay declared even though each build bakes
`--define process.env.OPENTUI_LIBC="glibc"` (which drops the unused one from
the output, -6.3 MB on `linux-x64`): a musl build is one `OPENTUI_LIBC=musl`
away and the package must still resolve.

## 3. Architecture

```
apps/tui/
  SPEC.md                    this file
  README.md                  run / keys / troubleshooting
  package.json  tsconfig.json
  src/
    index.tsx                standalone entry (`pnpm --filter @kortix/tui dev`): resolveHost + env → runTui → process.exit
    main.tsx                 `runTui()`: config → kortix client → QueryClient → createCliRenderer → <App/>; resolves an exit code
    app.tsx                  route state (screen enum), global keymap, layout frame
    kortix.ts                createKortix once; exports `kortix` + `hostInfo`
    auth/hosts.ts            load hosts from CLI config; env override; `saveHost` after login
    keymap.ts                one table: { id, keys, when, description }
    theme.ts                 tokens: fg, dim, accent, border, surface, danger (light+dark aware)
    ui/                      primitives: Panel, List, Modal, Picker, StatusBar, Spinner, Kbd, Toast
    features/
      sidebar/               account switcher, project switcher, session list (grouped by day, children indented)
      session/               transcript, turn, part renderers, composer, pickers, prompts (question/permission), error banner
      terminal/              PTY panel over `getKortixPtyWebSocketUrl` + EmbeddedTerminal
      login/                 host picker + PAT paste + validate + save
      files/                 sandbox file browser (session files)
      review/                change requests + diff viewer
      apps/                  project apps list/deploy status
      customize/             agents, skills, secrets, triggers, connectors (read + the small writes web exposes)
      account/               members, invites, roles, billing readout
      help/                  keymap overlay
    lib/                     pure helpers with unit tests (grouping by day, relative time, part → view model glue, focus ring)
  test/                      bun tests using @opentui/core/testing (createTestRenderer) + @opentui/react/test-utils
```

Rules:

- Every feature folder owns its files. Shared files (`app.tsx`, `keymap.ts`,
  `theme.ts`, `ui/*`) are edited only by the integrator (this thread or the
  wave-0 agent) after wave 0.
- No feature imports another feature's internals. Cross-feature state goes
  through `app.tsx` route state or the SDK's own stores.
- All data via `@kortix/sdk` / `@kortix/sdk/react`. The one exception is the
  PTY WebSocket, which uses the SDK-resolved URL and Bun's `WebSocket` with a
  `User-Agent` header (same as `apps/cli/src/api/pty-socket.ts`).

## 4. Layout (mirrors apps/web screenshot)

```
┌ sidebar 28c ──┬ session ───────────────────────────┬ terminal (toggle, 40%) ┐
│ ▾ Project Atlas     │ Casual greeting            ⌥T ⌥F   │ Terminal            × │
│ + New session  │ ─────────────────────────────────── │ kortix@sandbox:/ws $  │
│   Customize    │ ▸ Completed 7 steps                 │                       │
│   Apps         │ I can do a full …                   │                       │
│ Sessions       │  1. Deal sourcing …                 │                       │
│ Today          │                                     │                       │
│ ● Casual gre 56│ ┌───────────────────────────────┐   │                       │
│   · Fix claims │ │ Type / for skills, commands… │   │                       │
│   · Fix lifecy │ │ GPT-5.6 Sol ▾  Auto ▾  Galileo│   │                       │
│ Review       2 │ └───────────────────────────────┘   │                       │
│ Files          │ ⠋ working · 12s        ? help      │                       │
└────────────────┴─────────────────────────────────────┴───────────────────────┘
```

Minimum size 80×24. Below 100 columns the terminal panel is a full-screen
toggle instead of a split. Below 60 columns the sidebar collapses to a picker
(`Ctrl+P`).

## 5. Screens and behaviors

### 5.1 Boot and login (`features/login`)

- Read hosts from CLI config. Active host with a token → skip to app.
- Env override: `KORTIX_API_URL` + `KORTIX_API_KEY` beat config (for scripts
  and CI).
- No usable host → Login screen: list of configured hosts; `Enter` selects;
  `n` adds a host: URL input + PAT input (masked). Validate with
  `kortix.validateToken` (or `whoami` equivalent the SDK exposes), then
  `upsertHost` + `setActiveHost` via the CLI config module. Errors render
  inline with the HTTP status.
- `Ctrl+H` anywhere: host switcher (reuses the same list).

### 5.2 Sidebar (`features/sidebar`)

- Account row: active account name; `Enter` → account picker
  (`kortix.accounts.list`). Switching account re-lists projects.
- Project row: active project; `Enter` → project picker
  (`kortix.projects.listForAccount`). Default = CLI host `default_project`,
  else the first project.
- `New session` → `kortix.projects.createSession` then navigate. Title is
  server-owned (see memory `session-titles-kortix-owned`): send no title.
- `Customize`, `Apps`, `Review (n)`, `Files` rows navigate to those screens.
- Session list: `useProjectSessions(projectId)`. Group by day (`Today`,
  `Yesterday`, weekday, date). Root sessions at depth 0; sub-sessions
  (`parent_session_id`) indented under their parent with `·`. Right column:
  relative age; the active session shows its turn count when the SDK exposes
  it, else the age. Status glyph: `●` running, `○` stopped, `!` failed.
- Keyboard: `j/k` or arrows, `Enter` open, `d` delete (confirm modal),
  `r` rename (input), `/` filter, `g/G` first/last. Keyset paging: load more
  on reaching the end (`hasNextPage`).

### 5.3 Session view (`features/session`)

Data: `useSession(projectId, sessionId)`. Use its `phase`, `messages`,
`working`, `isBusy`, `questions`, `permissions`, `sendError`, `models`,
`agents`, `commands`, `picks`, `send`, `cancel`, `answerQuestion`,
`rejectQuestion`, `answerPermission`, `runCommand`, `hasOlder`, `loadOlder`,
`rewind`. Do not call runtime endpoints directly.

Transcript:
- One `<scrollbox>` with sticky-bottom autoscroll; scrolling up unlocks; `G`
  re-locks.
- Turn header: role glyph + agent name + relative time. User turns right-aligned
  block with a dim border; assistant turns plain.
- Parts: `classifyTurn(message)` → `ClassifiedPart` switch (exhaustive).
  `text` → `<markdown>`; `reasoning` → dim collapsible; `tool` →
  `toolViewModel` (SDK `core/turns/view-model`) → one card per `kind`
  (shell: command + stdout tail; file-read/write/edit: path + preview/diff via
  `<diff>`; search: pattern + match count; task: description + agent;
  todo: checklist; question: inline prompt; web-search: query + results;
  generic: label + pretty I/O). Consecutive tool parts collapse into
  "Completed N steps" like web; `Enter` on the header expands.
- Streaming: text parts update in place. Working indicator in the status bar
  (spinner + elapsed) driven by `working`/`isBusy`.
- Errors: `sendError` and turn `error` render an inline banner with
  `kind`/`message`, plus `gateway.provider/code/suggestion` when present;
  billing → "Upgrade plan" hint with the 402 detail.
- Question prompt: options list, `Enter` answer, `Esc` reject.
- Permission prompt: `y` allow once, `a` allow always, `n` deny; show the
  tool + arguments (memory `approval-gate-must-show-arguments`).
- `hasOlder` → `PgUp` at top loads older.

Composer:
- `<textarea>` 1–6 rows, grows with content. `Enter` sends, `Shift+Enter`
  newline, `Esc` clears or (if busy) prompts to stop — `Esc Esc` aborts.
- `/` at column 0 opens the command picker from `commands` (+ built-ins
  `/new`, `/model`, `/agent`, `/effort`, `/terminal`, `/files`, `/help`,
  `/quit`).
- Model picker: `useSessionModelSelection`/`models` grouped by provider; shows
  availability (memory: hidden vs unavailable). Effort picker: the model's
  effort options (`Auto`, `low`…). Agent picker: `agents` with
  `defaultAgent` marked. Persist picks through the SDK (`picks`), not local
  state.
- Attachments: `@path` mention inserts a file part when the SDK's
  `usePromptAttachments` supports non-browser `File`; otherwise out of scope
  for wave 1 and flagged in README.
- Queue: when busy, `Enter` queues (SDK message queue) and the status bar shows
  `queued N`.

### 5.4 Terminal panel (`features/terminal`)

- `Alt+T` toggles. Creates or reuses a PTY via the SDK PTY functions
  (`useCreatePty`/`useOpenCodePtyList`, `getPtyWebSocketUrl`).
- Bytes flow into `<embedded-terminal>` (OpenTUI's VT parser renderable) and
  keystrokes flow back over the WebSocket. Resize sends the PTY size.
- Header: "Connect from your machine" hint with the exact `kortix sessions
  connect <id>` line and copy-to-clipboard (`y`).
- Reconnect on close with backoff; show state in the panel title.

### 5.5 Files (`features/files`)

- Session sandbox tree via the SDK session files surface
  (`kortix.session(pid, sid).files.*`). Lazy directory expansion, `Enter`
  opens a file in a `<code>` viewer with `filetype` from the extension, images
  as a placeholder line.

### 5.6 Review (`features/review`)

- `useChangeRequests(projectId)`: list with status; `Enter` opens the diff
  (`<diff>` unified/split toggle `s`), `a` approve / `m` merge where the SDK
  exposes the action; otherwise read-only with the action name greyed and a
  note.

### 5.7 Apps (`features/apps`)

- `useProjectApps(projectId)`: name, status, URL; `o` opens URL in the
  browser (`open`/`xdg-open`), `Enter` shows deploy details.

### 5.8 Customize (`features/customize`)

Tabs: Agents · Skills · Secrets · Triggers · Connectors.
- Agents/skills: read via the session capabilities and project config the SDK
  exposes (`useProjectConfig`, `useVisibleAgents`).
- Secrets: `useProjectSecrets` list (names only, never values); `n` add
  (name + value input, value masked), `d` delete with confirm.
- Triggers: `useProjectTriggers` list; enable/disable toggle.
- Connectors: `kortix.project(pid).connectors.catalog()` + connections list.

### 5.9 Account (`features/account`)

- Members (`kortix.accounts.members`), invites, roles (read-only table).
- Billing: `kortix.billing.accountState` → plan, credits, hard-block state.

### 5.11 Attach mode — hand a session to the stock opencode TUI

The CLI already ships a version-matched opencode attach (`kortix sessions
connect`, memory `kortix-tui-attach-shipped`): resolve the session runtime,
download the exact opencode binary the sandbox runs, start a localhost proxy
that injects the Kortix token, `opencode attach <proxy> --session <id>`.
The TUI reuses that seam instead of re-implementing it:

- `a` on a session row, or `/attach` in the composer, or `Alt+O`.
- Flow: `renderer.suspend()`-equivalent (leave the alternate screen, restore
  the cursor, release stdin) → call `attachOpenCodeSession({ auth, projectId,
  sessionId })` from `@kortix/cli` (extracted from `runSessionsConnect`, same
  behavior, no stdout prints in library mode; status via callback) → on exit
  re-enter the TUI on the same session, toast the exit code.
- Non-running sessions restart first (the same `/start` poll the CLI uses).
- Failure modes render as a toast + banner: binary download failure (offline),
  proxy start failure, missing session. Never leave the terminal in the
  alternate screen on any path.
- This is the fallback chat surface while the native transcript (§5.3)
  matures, and the "pro" surface afterwards.

### 5.10 Help overlay (`features/help`)

- `?` renders the keymap table grouped by scope. Generated from `keymap.ts`.

## 6. Keymap (global unless scoped)

| Keys | Action |
| --- | --- |
| `Ctrl+C` ×2 / `Ctrl+Q` | quit (first press shows "press again") |
| `?` | help overlay |
| `Tab` / `Shift+Tab` | cycle focus: sidebar → transcript → composer → terminal |
| `Ctrl+P` | session/project quick switcher |
| `Ctrl+N` | new session |
| `Alt+T` | toggle terminal panel |
| `Alt+F` | files screen |
| `Alt+R` | review screen |
| `Alt+A` | apps screen |
| `Alt+C` | customize screen |
| `Ctrl+H` | host switcher |
| `a` (session row) / `Alt+O` / `/attach` | attach the session in the stock opencode TUI (§5.11) |
| `Esc` | close modal / back / clear composer / (busy) stop prompt |
| `j k ↑ ↓ g G PgUp PgDn` | list and transcript navigation |

## 7. Data layer map

| Surface | SDK |
| --- | --- |
| hosts/auth | `@kortix/cli` `src/api/config.ts` (`loadConfig`, `activeHost`, `getHost`, `upsertHost`, `setActiveHost`), `src/api/sdk.ts` (`sdkBackendUrl`) |
| client | `createKortix` |
| accounts | `kortix.accounts.list/get`, `kortix.accounts.members` |
| projects | `kortix.projects.list/listForAccount/get/createSession` |
| sessions list | `useProjectSessions` |
| session | `useSession` |
| models/agents | fields of `useSession`; `useSessionModelSelection`, `useProjectModels` |
| attach | `@kortix/cli` `attachOpenCodeSession` (extracted from `sessions-connect.ts`) |
| PTY | `useOpenCodePtyList`, `useCreatePty`, `getPtyWebSocketUrl` |
| files | `kortix.session(pid,sid).files` |
| review | `useChangeRequests` |
| apps | `useProjectApps` |
| secrets/triggers | `useProjectSecrets`, `useProjectTriggers` |
| connectors | `kortix.project(pid).connectors` |
| billing | `kortix.billing.accountState` |
| permissions | `useCan` |

Browser globals: the SDK guards `window`, `localStorage`, `indexedDB`,
`document` behind `typeof` checks. Any unguarded use found under Bun is an
SDK bug: fix it in `packages/sdk` under the `sdk` skill (failing test first),
never patch around it in the TUI.

## 8. Testing and verification standard

1. Unit (`bun test` in `apps/tui`): pure helpers in `src/lib/*` and every
   renderer/component via `createTestRenderer` from `@opentui/core/testing` +
   `@opentui/react/test-utils`. Assert captured frames (text content), not
   snapshots of ANSI.
2. Live: run against the `tui` worktree stack — API `http://localhost:17408/v1`,
   web `http://localhost:17400` — with a real user token (mint per
   `CLAUDE.md` "Authenticating to the live API"; store it in
   `KORTIX_API_KEY` for the run, never in a file). A session is a real cloud
   sandbox: send a prompt, watch it stream, run a PTY command.
3. Driving the TUI headlessly: prefer the test renderer with mocked keys
   (`@opentui/core/testing` `mock-keys`). For a real terminal session use
   `pilotty` (`npm install pilotty`) or `script`/`expect`; capture the screen
   text and assert on it. Keep any recorded frames under `apps/tui/test/`.
4. Every feature PR-comment lists: command run, exact output lines proving
   the behavior, and what remains unverified.
5. Types: `pnpm --filter @kortix/tui typecheck` clean. Lint:
   `pnpm biome check apps/tui` clean.

## 9. Delivery

- Branch `tui`, worktree `../suna-tui`. Draft PR against `main` with the
  `preview` label on the first commit. Merge only on explicit approval.
- Docs: `apps/tui/README.md` and a docs page under
  `apps/web/content/docs/` (follow the timestamp-manifest rule from memory
  `new-docs-page-needs-timestamp-manifest`).
- Experimental surface: the CLI gets `kortix tui`
  (`apps/cli/src/commands/tui.ts`). `kortix --help` lists it with the same
  `Experimental:` blurb prefix `apps` uses; `kortix tui --help` prints the
  usage, the key summary, the docs URL, the separate install and
  `KORTIX_TUI_BIN`; and one stderr line names it experimental before the
  renderer takes the screen, so it survives in scrollback after the alternate
  screen exits. No env gate. README and `/docs/tui` lead with `kortix tui`,
  then the repo `dev` command.
- **The TUI is NOT in the `kortix` binary.** `@opentui/core` dlopen's an ~19 MB
  native library per platform and pulls React in with it — 14–21 MB of every
  `kortix` download for a command most people never run. `apps/tui/bundle/`
  (mirroring `apps/cli/bundle/`) compiles `src/index.tsx` into
  `kortix-tui-{darwin-arm64,darwin-x64,linux-x64,linux-arm64}`, and the same
  `build-cli` job in `deploy-dev.yml` / `deploy-prod.yml` publishes them, plus
  a `.sha256` per asset, to the same release as the `kortix` binaries.
  `@kortix/tui` is no longer a dependency of `@kortix/cli`.
- `kortix tui` is a launcher (`apps/cli/src/tui-bin.ts`, modeled on
  `src/opencode-bin.ts`). Resolution: `KORTIX_TUI_BIN` →
  `~/.kortix/tui/<version>/kortix-tui` → download
  `<release base>/<tag>/kortix-tui-<os>-<arch>` for exactly this CLI's version
  (`v<version>`, or `dev-latest` for a `-dev.<sha>` build), checksum-verify it
  against the `.sha256` asset, `chmod 755`, then `spawn(bin, [], { stdio:
  'inherit' })` and exit with the child's code. `--host` / `--project` /
  `--session` reach the child as `KORTIX_TUI_HOST` / `KORTIX_PROJECT_ID` /
  `KORTIX_SESSION_ID`. The first run on a tty asks; off a tty it exits `2`
  with `kortix tui --install`. `--install` installs without asking,
  `--uninstall` removes `~/.kortix/tui`, and `kortix uninstall` takes it with
  the rest of `~/.kortix`. A `dev` build has no release to match and exits `1`
  naming `pnpm --filter @kortix/tui bundle`; a binary copied to
  `~/.kortix/tui/dev/kortix-tui` is found with no env var.

## 10. Waves (orchestration plan)

Agents work in ONE shared worktree (`../suna-tui`). Hard rules for every
agent: own only the paths assigned; never `git add -A`; never `git
checkout/restore/reset/clean/stash/rm`; commit early with
`git add <own paths>`; never touch `main`; never merge.

- **Wave 0 — foundation (blocking).** Scaffold `apps/tui`, dependency install,
  boot, login/hosts, theme, keymap, layout frame, ui primitives, and the
  feasibility proof: `useProjectSessions` + `useSession` render under Bun +
  OpenTUI against the live API, one prompt streams end-to-end. Produce
  `docs/opentui-notes.md` (API cheat sheet from the installed package's
  `.d.ts`).
- **Wave 1 — core product (parallel).** sidebar · session transcript+prompts ·
  composer+pickers · terminal panel.
- **Wave 2 — secondary surfaces (parallel).** files · review · apps ·
  customize · account · help overlay.
- **Wave 3 — integration + proof.** Wire routes and keymap, README + docs
  page, full test run, live e2e recording, PR body with evidence.

## 11. Definition of done

- `pnpm --filter @kortix/tui dev` boots on a fresh clone with `kortix login`
  done, lists real sessions, streams a real turn, runs a real PTY command.
- Unit tests, typecheck, biome: green; recorded in the PR.
- README explains run, keys, env override, troubleshooting (native lib load,
  terminal size, Ctrl+C).
- Every unverified surface is named in the PR body.
