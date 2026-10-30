# `@kortix/tui` — Kortix in the terminal (experimental)

A full terminal client for Kortix. It renders with
[OpenTUI](https://github.com/anomalyco/opentui) on Bun and reads every byte of
Kortix data through `@kortix/sdk`. `apps/tui/SPEC.md` is the plan; this file is
how to run it.

**Status: experimental.** `kortix tui` installs it on first run and keys,
screens and flags can change without a deprecation. The public mention is the
"The terminal" section of the guide (`apps/web/content/docs/guide.mdx`); this
file is the operator's guide.

**Session-first.** One session fills the screen, and every action is a slash
command typed into its input: `/sessions` picks another session, `/new`
starts one, `/drive` opens Drive, `/help` lists everything. With no session
open, the first prompt you type creates one. The sidebar is optional: it
starts hidden, `/sidebar` (or `Alt+B`) shows it, and the choice is saved in
`tui.json` beside the CLI's `config.json`. The chords are accelerators for the
same commands.

## Run

```bash
kortix login            # writes ~/.config/kortix/config.json
kortix tui              # first run: "Install now? [Y/n]" — experimental
kortix t                # same thing, short
kortixt                 # one word — installed beside `kortix`; bind it to a key

# A cloud engineering desk in one keystroke: a fresh session in one project,
# the project's agent (or --agent <name>), the sandbox shell open and focused.
kortixt --project <project-id> --new --terminal
```

`kortix tui` is a **launcher**, not the app. The `kortix` binary does not carry
the TUI: `@opentui/core` dlopen's an ~19 MB native library per platform and
pulls React in with it, which is 14–21 MB of every `kortix` download for a
command most people never run. So the TUI ships as its own release asset,
`kortix-tui`, built by the same job.

After a CLI update the launcher updates the TUI on its own: no prompt, one
line on stderr, and the old version directories are removed. When the release
did not change the binary (the published `.sha256` matches an installed copy)
nothing is downloaded — the copy is reused in place.

On the first run the launcher asks, downloads the `kortix-tui` matching this
CLI's version from the same GitHub release, verifies it against the release's
`.sha256`, writes it to `~/.kortix/tui/<version>/kortix-tui`, and execs it with
`stdio: 'inherit'` so the child owns the real tty. Later runs exec the cached
copy directly. `apps/cli/src/tui-bin.ts` holds the resolution.

Resolution order, highest first:

1. `KORTIX_TUI_BIN` — an explicit path, used as-is. Nothing is downloaded.
2. `~/.kortix/tui/<version>/kortix-tui` — the managed cache for this CLI's
   version. A source build reports version `dev` and reads
   `~/.kortix/tui/dev/kortix-tui`, so a locally built binary dropped there
   works with no environment variable.
3. Download `kortix-tui-<os>-<arch>` +  its `.sha256` from
   `https://github.com/kortix-ai/suna/releases/download/<tag>/`, where `<tag>`
   is `v<version>` for a release and `dev-latest` for a `-dev.<sha>` build.

| Flag | Effect |
| --- | --- |
| `--host <name>` | Open this configured host. Reaches the child as `KORTIX_TUI_HOST`, which outranks a stale `KORTIX_TOKEN`. |
| `--project <id>` | Reaches the child as `KORTIX_PROJECT_ID`. |
| `--session <id>` | Reaches the child as `KORTIX_SESSION_ID`. |
| `--sidebar` / `--no-sidebar` | Show or hide the sidebar for this run (`KORTIX_TUI_SIDEBAR=1` / `0`). Without either, the saved `/sidebar` choice. |
| `--install` | Install and exit. No prompt — the form for a script or CI. |
| `--uninstall` | `rm -rf ~/.kortix/tui` and exit. |

Off a terminal the launcher never starts an 80 MB download by itself: it exits
`2` and prints `kortix tui --install`. A `dev` build with no cached binary
exits `1` and prints the `pnpm --filter @kortix/tui bundle` remedy. With no
host logged in the TUI opens its login screen rather than failing.

### Building the binary

```bash
pnpm --filter @kortix/tui bundle       # host target → apps/tui/bundle/kortix-tui
pnpm --filter @kortix/tui bundle:all   # all four release targets
KORTIX_TUI_BIN=$PWD/apps/tui/bundle/kortix-tui kortix tui
```

`apps/tui/bundle/` mirrors `apps/cli/bundle/`. Each build bakes
`process.env.OPENTUI_LIBC="glibc"` so a Linux target embeds one libc variant
instead of both (−6.3 MB on `linux-x64`); an Alpine/musl user builds their own
with `OPENTUI_LIBC=musl` and points `KORTIX_TUI_BIN` at it.

From a clone of the repo, which is what you want while changing the TUI:

```bash
# from the repo root, once
pnpm install

pnpm --filter @kortix/tui dev
```

Authentication comes from the CLI's own host config, so `kortix login` is the
setup step — the TUI only reads that file. For a script, a test, or a second
host, the environment beats the config and touches no file on disk:

```bash
KORTIX_API_URL=http://localhost:8008 KORTIX_API_KEY="$JWT" \
  pnpm --filter @kortix/tui dev
```

With no usable host the app opens its login screen: pick a configured host, or
press `n` to add one (URL + personal access token, validated before it is
saved). `Ctrl+H` reopens it later to switch hosts.

## Terminal requirements

| Requirement | Why |
| --- | --- |
| Bun ≥ 1.3 | `@opentui/core` ships a Bun-FFI native renderer. |
| 80 × 24 minimum | Below 100 columns the terminal panel replaces the split instead of sharing it; below 60 columns the sidebar never draws. Below 49 columns of session width the splash prints `kortix` instead of the block wordmark. |
| Kitty keyboard protocol for `Shift+Enter` | A legacy terminal sends a bare `\r` for both `Enter` and `Shift+Enter` and cannot tell them apart. `Ctrl+J` is the portable newline and always works. |
| `Alt` = `Option` on macOS | Terminal.app and iTerm2 send `Alt+T` as the two bytes `ESC t`, which arrive as `meta`, not `option`. The keymap matches either, so `Alt+T` and `Alt+F` work in both. In Terminal.app, turn on *Use Option as Meta key*. |
| A real tty | `script` on macOS gives the child no controlling tty; use a pty (see [Driving it headlessly](#driving-it-headlessly)). |

## Environment variables

These drive `pnpm --filter @kortix/tui dev`. Under `kortix tui` the CLI owns
host resolution and `--host` / `--project` / `--session` are the equivalents —
except `KORTIX_TOKEN`, which the CLI reads too (see Troubleshooting).

| Variable | Effect |
| --- | --- |
| `KORTIX_API_KEY` | Bearer token. With it, the CLI config is not read at all. |
| `KORTIX_TOKEN` | Same as `KORTIX_API_KEY` (the name the CLI uses inside a sandbox). |
| `KORTIX_API_URL` | Backend origin, with or without `/v1`. Defaults to `https://api.kortix.com`. |
| `KORTIX_PROJECT_ID` | The project whose sessions are listed. Defaults to the host's default project, else the first project. |
| `KORTIX_SESSION_ID` | Open this session at boot. |
| `KORTIX_CONFIG_FILE` | Read hosts from this file instead of `~/.config/kortix/config.json`. |
| `KORTIX_TUI_THEME` | `dark` or `light`. Otherwise `COLORFGBG` decides, defaulting to dark. |
| `KORTIX_TUI_SIDEBAR` | `1` shows the sidebar, `0` hides it, for this run. Unset: the saved `/sidebar` choice (hidden the first time). |
| `KORTIX_TUI_VERSION` | Printed on the boot screen. `kortix tui` sets it to the CLI's version; a source run prints `dev`. |
| `KORTIX_TUI_AUTO_FORWARD` | `0` disables auto-forwarding a sandbox port the moment it's noticed (see [Ports](#ports)). Default: on. |

## Screens

Every screen opens from the input with its slash command, and from the
sidebar row of the same name. `Esc` returns to the session. A screen whose
project flag is off is listed dimmed in the `/` menu with the reason, and it
is left out of the sidebar.

| Command | Screen | Needs |
| --- | --- | --- |
| (none) | The session: the transcript, the prompts, the input. With no session open, the KORTIX splash and the input; the first prompt creates the session. | a project |
| `/files` | The session sandbox's workspace tree and viewer. Drive mounts under `/drives` read through Drive. | a session |
| `/drive` | Drive: My files, Shared with me, Team folders, All files (managers), This session. New folder, move, delete, upload, conflicts. | flag `drives` |
| `/repo` | The project repository: branches, folders, a file viewer, commit history. | a project |
| `/artifacts` | Docs and pages the agents published: read, rename, pin, stop sharing. | flag `artifacts` |
| `/inbox` | Notifications, newest first: open, mark read, mark all read. | `notification_center`, or `artifacts` + `artifact_comments` |
| `/approvals` | Approvals, outputs and decisions waiting on a person: approve, reject, ask for changes, answer. | a project |
| `/goals` | Goals and their progress: start one, answer its question, stop it. | flag `goals` |
| `/memory` | Company memory pages: read and search. | flag `project_channels` |
| `/spaces` | Channels and DMs and their threads; a thread opens as the session. | flag `project_channels` |
| `/rooms` | Rooms where agents and people talk (read-only). | flag `agent_rooms` |
| `/loops` | This session's loops: prompts on a schedule. New, pause, run now, delete. | a session, flag `reminders` |
| `/audit` | This session's audit events and the approvals waiting. History needs the Enterprise audit entitlement. | a session |
| `/review` | Open change requests and their diffs. | a project |
| `/apps` | The project's deployed apps, their status and URLs. | — |
| `/customize` | Agents · Skills · Secrets · Triggers · Connectors. | — |
| `/account` | Members, invites, roles, and the billing readout. | an account |
| `/help` | Every command and binding, generated from the command table and the keymap. | — |
| `/ports` | Sandbox ports noticed in the transcript/terminal, and every local forward. See [Ports](#ports). | a session |
| `/links` | Every URL in the transcript or on the terminal screen, wrapped ones rejoined. See [Links](#links). | a session |

## Ports

VS Code-style local port forwarding: a sandbox port a session's agent
mentions (`http://localhost:3000`, a bare `127.0.0.1:5173`, a `0.0.0.0:PORT`
banner) is auto-forwarded to the same local port — or the next free one — the
moment it's noticed in the transcript or the terminal panel's output. A toast
confirms it: `Forwarded localhost:3000 → sandbox:3000`. Set
`KORTIX_TUI_AUTO_FORWARD=0` to turn this off and forward only by hand.

Detection ignores ports 1-1023 except 80 and 443 (a sandboxed dev server
essentially never binds a privileged port; treating a `host:port`-shaped match
there as a false positive is safer than flooding the panel with noise) and the
sandbox's own SSH (22) and kortixd service (8000) ports.

`Alt+P` opens the panel — one row per port, its state (forwarding / stopped /
error), and its local URL when forwarding:

| Key | Action |
| --- | --- |
| `j`/`k`, `g`/`G` | Move the selection. |
| `Enter` | Forward the selected port, or stop forwarding it. |
| `o` | Open `http://localhost:<port>` in the browser. |
| `y` | Copy the local forwarded URL to the clipboard. |
| `a` | Add a sandbox port to forward, by number — regardless of auto-forward. |
| `Esc` | Close the panel. Open forwards keep running. |

The status bar shows `⇄ 3000, 5173` while any port is forwarding. Forwards are
per session: they close when the session view unmounts or the session changes,
same as the CLI's `kortix sessions forward <session-id> --port <sandbox>[:<local>]`
(see `apps/cli/README.md`) — the panel reuses that exact engine
(`@kortix/cli/src/port-forward.ts`) rather than a second implementation.

## Links

The terminal panel is a VT emulator drawn into cells, so the host terminal
cannot click inside it: a URL longer than the panel wraps across rows, and
Ghostty or iTerm2 sees several unrelated rows, never one link. An OAuth
sign-in URL a CLI prints (`codex login`, `gh auth login`) is the common case.

`Alt+L` opens the Links panel — every `http(s)://` URL in the transcript
(assistant text and tool output) and on the terminal screen right now,
wrapped rows rejoined, newest first:

| Key | Action |
| --- | --- |
| `j`/`k`, `g`/`G` | Move the selection. |
| `Enter` / `o` | Open the selected URL in the browser (`open` / `xdg-open`). |
| `y` | Copy the selected URL to the clipboard. |
| `Esc` | Close the panel. |

`Alt+L` works while the terminal panel is focused, so the URL a CLI just
printed is one chord away. Only `http:` and `https:` URLs are opened.

## Mouse, selection and copying

The TUI does not take the mouse. Your terminal's own text selection,
copy-on-select and `Cmd`/`Ctrl`+click on a URL therefore keep working inside
it, exactly as in a plain shell; in Ghostty that means drag to select and the
selection is on the clipboard. Nothing in the app needs a click. `kortix tui
--mouse` (`KORTIX_TUI_MOUSE=1`) gives the mouse to the app instead, and
then Shift+drag is the way to select natively in most terminals.

### Layout: `/ui`

Every region around the chat is a module, off until you turn it on:

| Module | Command | Sides | What it shows |
| --- | --- | --- | --- |
| Header | `/header` | — | The session title and its state, above the transcript. |
| Session tabs | `/tabs` | top, bottom | The sessions opened in this run. `Alt+[` / `Alt+]` switch, `/close` closes. |
| Sidebar | `/sidebar`, `Alt+B` | left, right | Projects, every screen, the session list. |
| Info panel | `/info`, `Alt+I` | right, left | Title, state, context tokens and % used, model, session, forwarded ports. |
| Tray | `/tray` | — | One row under the input: host · project, model · agent. On by default. |
| Terminal title | `/title` | — | The terminal window's title follows the open session. On by default. |

`/ui` opens the picker above the input: three presets (Minimal, Focused,
Full) and every module with its side. `Enter` toggles, `←`/`→` moves a module
to its other side, and the screen behind the picker is the preview. The first
start opens it as the welcome step; `Esc` there keeps Minimal. The choice is
saved in `tui.json` (`{ "ui": …, "onboarded": true }`); the old
`{ "sidebar": true }` file still reads.

The sidebar is optional and starts hidden. `/sidebar` or `Alt+B` toggles it
and saves the choice in `tui.json` (beside `config.json`), so the next run
opens the same way. `kortix tui --sidebar` / `--no-sidebar`
(`KORTIX_TUI_SIDEBAR=1` / `0`) override it for one run. Without the sidebar,
`/sessions` (`Ctrl+P`) and `/projects` do everything it does.

## Commands and keys

Type `/` at the start of the input to list every command; keep typing to
filter (`/se` finds `/sessions`, `/switch` is an alias), `↑`/`↓` move, `Tab`
completes, `Enter` runs. `/name args` runs with arguments (`/rename Fix the
login bug`, `/sessions fix`). A command that cannot run here is listed dimmed
with the reason, and Enter on it says why. An unknown `/word` is refused and
kept; a path such as `/etc/hosts is broken` is sent as a prompt. `Esc` three
times within 4 s stops a running turn, the same rule as the web chat. With the
sidebar hidden, `Tab` never leaves the input (an open terminal is the one
exception); `PgUp`/`PgDn` scroll the transcript from it.

The `?` overlay (`/help`) prints these tables live: they are generated from
`src/commands/registry.ts`, `src/keymap.ts` and every feature's `keys.ts`, so a
command or binding that is not here does not exist. Regenerate this section
with `pnpm --filter @kortix/tui keymap`.

The names follow Claude Code where the action is the same: `/resume` and
`/continue` are `/sessions`, `/clear` is `/new`, `/exit` is `/quit`, `/copy`
copies the last reply, `/export` saves the conversation, `/config` and `/mcp`
open Customize, `/permissions` opens Approvals, `/doctor` is `/status`, `/bug`
is `/feedback`.

### Commands

| Command | Also | Action |
| --- | --- | --- |
| `/new [prompt]` | `/clear` `Ctrl+n` | Session: Start a new session. A prompt after the name is its first message. |
| `/sessions [filter]` | `/resume` `/continue` `/switch` `Ctrl+p` | Session: Pick a session of this project and open it. |
| `/rename <title>` |  | Session: Rename this session. |
| `/stop` |  | Session: Stop the running turn. |
| `/compact` |  | Session: Summarize the conversation to free context. |
| `/restart` |  | Session: Restart this session's sandbox. The conversation is kept. |
| `/close` |  | Session: Close this session tab; the neighbour opens. |
| `/fork [prompt]` |  | Session: Copy this conversation into a new session and open it. |
| `/pin` |  | Session: Pin or unpin this session at the top of the list. |
| `/archive` |  | Session: Archive this session, or bring it back. |
| `/share <team\|private>` |  | Session: Let the whole project open this session, or only you. |
| `/reload` |  | Session: Reload kortix.yaml, agents and skills into this session. |
| `/copy` |  | Session: Copy the last reply to the clipboard. |
| `/link` | `/id` | Session: Copy the session id and its web link. |
| `/export [file]` |  | Session: Save the conversation as Markdown in the current folder. |
| `/delete` |  | Session: Delete this session. Asks first. |
| `/projects [filter]` | `/project` | Switch: Pick another project. |
| `/accounts [filter]` | `/org` | Switch: Pick another account. |
| `/hosts` | `/host` `/login` `Alt+h / Ctrl+h` | Switch: Switch host or log in to another one. |
| `/logout` |  | Switch: Remove this host's token, then show the login screen. |
| `/model` | `/models` `Alt+m` | Model and agent: Pick the model. |
| `/effort` | `/thinking` `Alt+e` | Model and agent: Pick the thinking effort. |
| `/agent` | `/agents` `Alt+g` | Model and agent: Pick the agent. |
| `/ui` | `/layout` `/tui` | Panels: Pick the layout: presets, and every panel on or off, left or right. |
| `/sidebar` | `Alt+b` | Panels: Show or hide the sidebar. The choice is remembered. |
| `/info` | `/panel` `Alt+i` | Panels: Show or hide the info panel: title, context, model, ports. |
| `/tabs` |  | Panels: Show or hide the session tabs. |
| `/header` | `/titlebar` | Panels: Show or hide the title row above the transcript. |
| `/tray` | `/statusline` | Panels: Show or hide the row under the input. |
| `/title` |  | Panels: Let the terminal window's title follow the session, or not. |
| `/terminal` | `/shell` `Alt+t` | Panels: Open or close a shell in this session's sandbox. |
| `/ports` | `Alt+p` | Panels: Forward sandbox ports to this machine. |
| `/links` | `Alt+l` | Panels: Open a URL from the transcript or the terminal. |
| `/files` | `Alt+f` | Screens: Browse this session's files. |
| `/drive` | `/volumes` | Screens: Project files on Drive: yours, shared, team folders. |
| `/repo` | `/git` `/code` | Screens: Browse the project's repository: files, branches, history. |
| `/artifacts` | `/docs` | Screens: Docs and pages the agents published. |
| `/inbox` | `/notifications` | Screens: Notifications: what needs you, newest first. |
| `/approvals` | `/permissions` `/decisions` `/outputs` | Screens: Approvals, outputs and decisions waiting on a person. |
| `/goals` |  | Screens: Outcomes the agents work toward, and their progress. |
| `/memory` | `/knowledge` | Screens: Read and search company memory pages. |
| `/spaces` | `/channels` `/dm` | Screens: Channels and DMs, and the threads in them. |
| `/rooms` |  | Screens: Rooms where agents and people talk. |
| `/loops` | `/reminders` `/schedule` | Screens: This session's loops: prompts that run on a schedule. |
| `/audit` | `/activity` | Screens: What happened in this session, and approvals waiting. |
| `/review` | `/changes` `/pr-comments` `Alt+r` | Screens: Review change requests. |
| `/apps` | `Alt+a` | Screens: List and deploy Apps. |
| `/customize` | `/settings` `/config` `/mcp` `/connectors` `Alt+c` | Screens: Agents, skills, secrets, triggers, connectors. |
| `/account` | `/members` `/billing` `/usage` `Alt+u` | Screens: Members, invites, roles, credits. |
| `/status` | `/doctor` `/whoami` | App: Host, account, project, session, runtime and version. |
| `/feedback` | `/bug` | App: Report a bug or an idea on GitHub. |
| `/help` | `/keys` `/?` `?` | App: Show every command and key. |
| `/quit` | `/exit` `/q` `Ctrl+c / Ctrl+q` | App: Leave the TUI. |

_53 commands._

### Anywhere

| Keys | Action |
| --- | --- |
| `Ctrl+c / Ctrl+q` | Quit. Ctrl+C asks once, then quits on the second press. Inside the terminal panel Ctrl+C belongs to the shell and only Ctrl+Q quits. |
| `?` | Show this help. Not while a text input or the terminal has focus. |
| `Tab` | Focus the next region: sidebar → transcript → composer → terminal. With the sidebar hidden, Tab stays in the input (or moves to an open terminal). |
| `Shift+Tab` | Focus the previous region. |
| `Ctrl+p` | Pick a session above the input. Same as /sessions. |
| `Ctrl+n` | Start a new session. Same as /new. |
| `Alt+t` | Toggle the terminal panel. |
| `Alt+b` | Show or hide the sidebar. Same as /sidebar; the choice is remembered. |
| `Alt+i` | Show or hide the info panel. Same as /info. |
| `Alt+[` | Open the previous session tab. |
| `Alt+]` | Open the next session tab. |
| `Alt+l` | Open the Links panel: every URL in the transcript and on the terminal screen, wrapped ones rejoined. Enter opens one in the browser. |
| `Alt+p` | Open the Ports panel: sandbox ports detected in output, and every local forward. |
| `Alt+f` | Open the files screen. |
| `Alt+r` | Open the review screen. |
| `Alt+a` | Open the apps screen. |
| `Alt+c` | Open the customize screen. |
| `Alt+u` | Open the account screen: members, invites, billing. |
| `Alt+h / Ctrl+h` | Switch host. Ctrl+H needs the kitty keyboard protocol: the byte it sends is Backspace. |
| `Esc` | Close the overlay, leave the screen, or move focus back to the composer. |

### Sidebar

| Keys | Action |
| --- | --- |
| `j / ↓` | Move down. |
| `k / ↑` | Move up. |
| `g` | Go to the first row. |
| `G` | Go to the last row. |
| `Enter` | Open the row: the session, the picker, or the screen. |
| `/` | Filter the session list. Esc clears it. |
| `r` | Rename the selected session. |
| `d` | Delete the selected session (asks first). |
| `n` | Create a session in this project. |
| `y / Enter` | Confirm the delete. |
| `n` | Decline the delete. |
| `Esc` | Cancel the input, the confirm, or the filter. |

### Transcript

| Keys | Action |
| --- | --- |
| `j / ↓` | Scroll down one line. |
| `k / ↑` | Scroll up one line. |
| `PgDn` | Scroll down one screen. Works from the input too. |
| `PgUp` | Scroll up one screen. At the top, load older turns. Works from the input too. |
| `g` | Jump to the oldest turn. |
| `G` | Jump to the newest turn and re-lock autoscroll. |
| `J` | Move the cursor to the next collapsible row. |
| `K` | Move the cursor to the previous collapsible row. |
| `Enter / Space` | Expand or collapse the row under the cursor. |

### Composer

| Keys | Action |
| --- | --- |
| `Enter` | Send the draft. While the agent works, queue it instead. |
| `Ctrl+j / Alt+Enter / Shift+Enter` | Insert a newline. Shift+Enter needs the kitty keyboard protocol. |
| `Esc` | Clear the draft, or close the command menu. Empty and busy: press it 3 times within 4 s to stop the turn. |
| `/` | Type / at the start of the input to list every command. Keep typing to filter; /name args runs one. |
| `↑ / ↓ / Ctrl+p / Ctrl+n` | Move the selection in the command menu. |
| `Tab` | Complete the selected command in the menu. |
| `Alt+m` | Pick the model. |
| `Alt+e` | Pick the thinking effort. |
| `Alt+g` | Pick the agent. |

### Terminal panel

| Keys | Action |
| --- | --- |
| `Alt+y` | Copy `kortix sessions shell <id>` to the clipboard. |
| `Alt+x` | Close the terminal panel. |
| `Alt+Enter` | Reconnect the terminal now. |
| `any other key` | Every other key goes to the remote shell, Ctrl+C included. Quit the TUI with Ctrl+Q; Tab, Alt+T, Alt+P and Alt+L still move focus, toggle the panel, and open the Ports and Links panels. |

### Files

| Keys | Action |
| --- | --- |
| `j / ↓` | Move down the tree. |
| `k / ↑` | Move up the tree. |
| `g` | Go to the first row. |
| `G` | Go to the last row. |
| `Enter` | Open the file, or expand/collapse the directory. |
| `h / ←` | Collapse the directory, or jump to its parent. |
| `l / →` | Expand the directory. |
| `/` | Filter the loaded rows by name. Esc clears it. |
| `.` | Show or hide dot-prefixed entries (.kortix and .opencode always show). |
| `r` | Re-read every open directory from the sandbox. |
| `y` | Copy the selected row's path to the clipboard. |
| `J / PgDn` | Scroll the viewer down. |
| `K / PgUp` | Scroll the viewer up. |
| `Esc` | Clear the filter, or leave the Files screen. |

### Drive

| Keys | Action |
| --- | --- |
| `j / ↓` | Move down. |
| `k / ↑` | Move up. |
| `g` | Go to the first row. |
| `G` | Go to the last row. |
| `Enter` | Open the place or folder, or preview the file. |
| `backspace / h / ←` | Go up one folder. At the top of a place, go back to Places. |
| `/` | Filter the rows by name. Esc clears it. |
| `n` | Make a folder here. |
| `m` | Move or rename the selected row. |
| `d` | Delete the selected row (asks first). |
| `u` | Upload a file from this computer into this folder. |
| `o` | Open this folder in the web app. |
| `y` | Copy the selected row's Drive path. |
| `r` | Reload the folder. |
| `c` | Show the conflict copies nobody resolved yet. |
| `x` | Dismiss the selected conflict notice. The copy stays. |
| `J / PgDn` | Scroll the preview down. |
| `K / PgUp` | Scroll the preview up. |
| `y` | Confirm. |
| `n / Enter` | Decline. Decline is the default. |
| `Esc` | Close the input, the preview or the list, or leave the screen. |

### Repository

| Keys | Action |
| --- | --- |
| `j / ↓` | Move down. |
| `k / ↑` | Move up. |
| `g` | Go to the first row. |
| `G` | Go to the last row. |
| `Enter` | Open the file, or expand/collapse the directory. |
| `l / →` | Expand the directory. |
| `←` | Collapse the directory, or jump to its parent. |
| `h` | Show or hide the commits of the repository or the selected file. |
| `b` | Pick the branch to read. |
| `/` | Filter the loaded rows by name. Esc clears it. |
| `.` | Show or hide dot-prefixed entries (.kortix always shows). |
| `r` | Re-read the open directories and the history. |
| `o` | Open the repository in the web app. |
| `y` | Copy the selected path, or the selected commit hash in history. |
| `J / PgDn` | Scroll the file down. |
| `K / PgUp` | Scroll the file up. |
| `↓` | Move down in the branch picker. |
| `↑` | Move up in the branch picker. |
| `Esc` | Close the picker, the history or the filter, then leave the screen. |

### Artifacts

| Keys | Action |
| --- | --- |
| `j / ↓` | Move down. |
| `k / ↑` | Move up. |
| `g` | Go to the first artifact. |
| `G` | Go to the last artifact. |
| `Enter` | Show the selected artifact. |
| `o` | Open the artifact in the web app. |
| `y` | Copy the artifact's web link. |
| `/` | Filter the list by title, path or author. Esc clears it. |
| `r` | Reload the artifact list. |
| `s` | Open the session that published the artifact. |
| `e` | Rename the selected artifact. |
| `p` | Pin or unpin the selected artifact. |
| `d` | Stop sharing the selected artifact (asks first). |
| `y` | Confirm. |
| `n` | Decline. |
| `J / PgDn` | Scroll the document down. |
| `K / PgUp` | Scroll the document up. |
| `Enter` | Save the new title. |
| `Esc` | Close the prompt, the details or the filter, then leave the screen. |

### Inbox

| Keys | Action |
| --- | --- |
| `j / ↓` | Move down. |
| `k / ↑` | Move up. |
| `g` | Go to the newest. |
| `G` | Go to the oldest. |
| `Enter` | Mark read and open it: the session, or the web page. |
| `m` | Mark the selected notification read. |
| `a` | Mark every notification read. |
| `f` | Cycle the filter: all, unread, needs you. |
| `o` | Open the notification in the browser. |
| `r` | Reload the inbox. |
| `Esc` | Leave the inbox. |

### Approvals

| Keys | Action |
| --- | --- |
| `j / ↓` | Move down (in the detail: scroll). |
| `k / ↑` | Move up (in the detail: scroll). |
| `g` | Go to the top. |
| `G` | Go to the bottom. |
| `l / → / Tab` | Next list: Needs you, Waiting, Done. |
| `h / ←` | Previous list. |
| `Enter` | Open the item. |
| `a` | Approve (a change request: merge it). Asks first. |
| `x` | Reject (a change request: close it). Reason optional. |
| `c` | Ask for changes. A note is required. |
| `d` | Dismiss the item. Asks first. |
| `w` | Answer a decision in your own words. |
| `1 / 2 / 3 / 4 / 5 / 6 / 7 / 8 / 9` | Answer a decision with option 1 to 9. Asks first. |
| `s` | Open the session that raised the item. |
| `o` | Open the item in the browser. |
| `r` | Reload the list. |
| `y / Enter` | Confirm. |
| `n` | Decline. |
| `Esc` | Leave the detail, the input, or the screen. |

### Goals

| Keys | Action |
| --- | --- |
| `j / ↓` | Move down. |
| `k / ↑` | Move up. |
| `g` | Go to the top. |
| `G` | Go to the bottom. |
| `Enter` | Open the goal, or the linked session under the cursor. |
| `n` | Start a goal: describe the outcome, a new session writes it. |
| `a` | Answer the goal's question (wakes its owner session). |
| `s` | Stop the goal (asks first). |
| `o` | Open the goal in the browser. |
| `r` | Reload the goals. |
| `y / Enter` | Confirm. |
| `n` | Decline. |
| `Esc` | Leave the detail, the input, or the screen. |

### Company memory

| Keys | Action |
| --- | --- |
| `j / ↓` | Move down. In a page: scroll down. |
| `k / ↑` | Move up. In a page: scroll up. |
| `g` | Go to the first page. |
| `G` | Go to the last page. |
| `PgDn / Space` | Scroll a page down. |
| `PgUp` | Scroll a page up. |
| `Enter` | Read the selected page. |
| `/` | Search all pages the project lets you read. |
| `t` | Cycle the page-type filter. |
| `o` | Open Memory in the browser. |
| `r` | Reload the page list. |
| `Esc` | Close the page, clear the search, or leave the screen. |

### Channels and DMs

| Keys | Action |
| --- | --- |
| `j / ↓` | Move down. |
| `k / ↑` | Move up. |
| `g` | Go to the first row. |
| `G` | Go to the last row. |
| `Enter` | Open the space, or open the thread as a session. |
| `n` | Start a new thread in the open space. |
| `o` | Open the space in the browser. |
| `r` | Reload the list. |
| `Esc` | Leave the threads, or leave the screen. |

### Rooms

| Keys | Action |
| --- | --- |
| `j / ↓` | Move down. In a conversation: scroll down. |
| `k / ↑` | Move up. In a conversation: scroll up. |
| `g` | Go to the first row, or the oldest message. |
| `G` | Go to the last row, or the newest message. |
| `PgDn / Space` | Scroll a page down. |
| `PgUp` | Scroll a page up. |
| `Enter` | Read the conversation, or open the member as a session. |
| `m` | List the members of the open conversation. |
| `o` | Open the conversation in the browser. |
| `r` | Reload the list or the messages. |
| `Esc` | Close the members, close the conversation, or leave the screen. |

### Loops

| Keys | Action |
| --- | --- |
| `j / ↓` | Move down. |
| `k / ↑` | Move up. |
| `g` | Go to the first loop. |
| `G` | Go to the last loop. |
| `Enter` | Show the full prompt and the last run of the loop. |
| `n` | Create a loop in this session. |
| `Space` | Pause or resume the selected loop. |
| `x` | Run the selected loop now. The schedule does not move. |
| `d` | Delete the selected loop (asks first). |
| `r` | Reload the loops. |
| `y` | Confirm the delete. |
| `n` | Decline the delete. |
| `Tab` | In the create form: switch between prompt and schedule. |
| `Esc` | Close the form or details, or leave the screen. |

### Session audit

| Keys | Action |
| --- | --- |
| `j / ↓` | Move down. |
| `k / ↑` | Move up. |
| `g` | Go to the newest event. |
| `G` | Go to the oldest loaded event. |
| `Enter` | Show the detail of the selected event. |
| `f` | Cycle the filter: all, approvals, agent, person, failed. |
| `a` | Approve the selected pending action (asks first). |
| `x` | Deny the selected pending action (asks first). |
| `m` | Load older events. |
| `r` | Reload the audit trail. |
| `y` | Confirm the decision. |
| `n` | Decline the decision. |
| `Esc` | Close the detail or the confirm, or leave the screen. |

### Review

| Keys | Action |
| --- | --- |
| `j / ↓` | Move down the list. |
| `k / ↑` | Move up the list. |
| `g` | Go to the first change request. |
| `G` | Go to the last change request. |
| `Enter` | Open the diff. |
| `s` | Switch the diff between unified and split. |
| `n` | Next file in the diff. |
| `p` | Previous file in the diff. |
| `J / PgDn` | Scroll the diff down. |
| `K / PgUp` | Scroll the diff up. |
| `a` | Approve. Not a separate Kortix action — approving a change request is merging it. |
| `m` | Merge the change request into its base (asks first). |
| `x` | Close the change request without merging (asks first). |
| `o` | Open the session this change request came from. |
| `r` | Re-read the change requests. |
| `y` | Confirm the merge or the close. |
| `Esc` | Cancel the confirm, close the diff, or leave the Review screen. |

### Apps

| Keys | Action |
| --- | --- |
| `j / ↓` | Move down. |
| `k / ↑` | Move up. |
| `g` | Go to the first App. |
| `G` | Go to the last App. |
| `Enter` | Show the deploy details of the selected App. |
| `o` | Open the App's URL in the browser. |
| `y` | Copy the App's URL. |
| `r` | Reload the App list. |
| `d` | Start or stop the selected App (asks first). |
| `v` | Change who may open the selected App. |
| `y / Enter` | Confirm. |
| `n` | Decline. |
| `Esc` | Leave the details, the picker, or the screen. |

### Customize

| Keys | Action |
| --- | --- |
| `1 / 2 / 3 / 4 / 5` | Jump to the Nth tab. |
| `]` | Next tab. |
| `[` | Previous tab. |
| `j / ↓` | Move down. |
| `k / ↑` | Move up. |
| `g` | Go to the first row. |
| `G` | Go to the last row. |
| `Enter` | Show the details of the selected row. |
| `n` | Add a secret (Secrets tab). |
| `d` | Delete the selected secret (asks first). |
| `Space /   / t` | Pause or resume the selected trigger. |
| `r` | Reload the active tab. |
| `y` | Confirm. |
| `n` | Decline. |
| `Enter` | Submit the input. |
| `Esc` | Close the input, the details, or the screen. |

### Account

| Keys | Action |
| --- | --- |
| `l / →` | Next tab. |
| `h / ←` | Previous tab. |
| `1` | Go to Members. |
| `2` | Go to Invites. |
| `3` | Go to Roles. |
| `4` | Go to Billing. |
| `j / ↓` | Move down the rows. |
| `k / ↑` | Move up the rows. |
| `i` | Invite a member by email (Invites tab). |
| `x` | Cancel the selected invite (asks first). |
| `r` | Cycle the role on the invite form: member → admin → owner. |
| `u` | Print the web billing URL. The TUI never runs checkout. |
| `R` | Re-read every tab from the API. |
| `y` | Confirm the cancellation. |
| `n` | Decline the cancellation. |
| `Esc` | Close the form, the confirm, or the screen. |

### Login

| Keys | Action |
| --- | --- |
| `j / ↓` | Move down the host list. |
| `k / ↑` | Move up the host list. |
| `Enter` | Use the selected host. A host with no token opens the token form. |
| `n` | Add a host: name, API URL, and a token. |
| `e` | Replace the selected host's token. |
| `d` | Remove the selected host (asks first). |
| `y` | Confirm the removal. |
| `n` | Decline the removal. |
| `Tab` | Next form field. |
| `Shift+Tab` | Previous form field. |
| `Enter` | Submit the form. |
| `Esc` | Leave the form, the confirm, or the screen. |
| `Ctrl+c / Ctrl+q` | Quit from the login screen at once. There is no app behind it to arm. |

### Ports panel

| Keys | Action |
| --- | --- |
| `Enter` | Forward the selected port, or stop forwarding it. |
| `o` | Open `http://localhost:<port>` in the browser. |
| `y` | Copy the local forwarded URL to the clipboard. |
| `a` | Add a sandbox port to forward, by number. |
| `Esc` | Close the Ports panel. Open forwards keep running. |

### Links panel

| Keys | Action |
| --- | --- |
| `Enter / o` | Open the selected URL in the browser. |
| `y` | Copy the selected URL to the clipboard. |
| `Esc` | Close the Links panel. |

### Lists, pickers and dialogs

| Keys | Action |
| --- | --- |
| `j / ↓` | Move down. |
| `k / ↑` | Move up. |
| `g` | Go to the first row. |
| `G` | Go to the last row. |
| `PgDn` | Page down. |
| `PgUp` | Page up. |
| `Enter` | Open the row. |

_319 bindings._

## Tests

```bash
pnpm --filter @kortix/tui test        # bun test
pnpm --filter @kortix/tui typecheck   # tsc --noEmit
npx biome check apps/tui

# the `kortix tui` launcher lives in the CLI's suite
pnpm --filter @kortix/cli test        # src/commands/tui.test.ts + src/tui-bin.test.ts
```

### What it depends on

Every byte of Kortix data comes through `@kortix/sdk`. The one other workspace
dependency is `@kortix/cli`, which publishes no barrel, so the TUI deep-imports
five of its modules and nothing else (`SPEC.md` §2 has the table): `src/api/
config.ts` for hosts and tokens, `src/web-url.ts` for the web links the account
screen prints, and `src/port-forward.ts`, `src/session-runtime.ts` and
`src/api/auth.ts` for the Ports panel.

`@kortix/cli` does NOT depend on `@kortix/tui` — that edge was removed when the
TUI became its own binary, so the dependency runs one way only. The six
`@opentui/core-<platform>` packages are still direct dependencies of this
package: `@opentui/core` declares them as `os`/`cpu`-gated
`optionalDependencies`, so pnpm would install only this machine's, and
`bun build --compile --target=bun-linux-x64` would then die on
`Could not resolve: "@opentui/core-linux-x64"`. `SPEC.md` §2 has the full note.

Tests sit next to the file they cover (`src/**/*.test.ts[x]`) — the repo
`.gitignore` ignores every `test/` directory, so the layout in `SPEC.md` §3
would not be tracked. Component tests render through OpenTUI's headless test
renderer and assert on captured frame text, never on ANSI.
`docs/opentui-notes.md` has the API cheat sheet and the traps, including why
key presses must be wrapped in React's `act` and why `<markdown>` needs a
settle before its text can be read back.

### Live proof

`scripts/live-app.tsx` mounts the whole app against a real API, a real project
and a real cloud sandbox, and exits non-zero unless every route answers:

```bash
cd apps/tui
KORTIX_API_URL=http://localhost:8008 KORTIX_API_KEY="$JWT" \
KORTIX_PROJECT_ID="$PID" KORTIX_SESSION_ID="$SID" \
  bun run scripts/live-app.tsx
```

It asserts, in order: the sidebar lists real sessions grouped by day; the
session reaches `ready` on the real runtime; a typed prompt streams a reply
back; `Ctrl+P` opens the switcher and its filter finds the project rows; `?`
opens the help overlay; `Alt+F` routes to files; `Alt+R` lists the project's
change requests and `Enter` opens a real diff; `Alt+A` lists its Apps; `Alt+C`
walks all five Customize tabs by their number keys; `Alt+U` opens Members;
`Alt+H` asks the host to switch; and `Ctrl+N` creates a REAL session that the
sidebar's `d` then deletes — with the session id set asserted identical before
and after, so a delete that took the wrong row fails the run.

It is not part of `bun test`: it needs credentials. It DOES provision one real
sandbox (the `Ctrl+N` step) and deletes it again in the same run. Point it at a
warm session and it finishes in about two minutes.

`LIVE_SKIP_STREAM=1` drops the three runtime steps for a project whose sessions
are all stopped — mounting `useSession` on one would boot a cold sandbox this
run has no use for. The skip is printed, never silent, and `KORTIX_SESSION_ID`
becomes optional:

```bash
KORTIX_API_URL=http://localhost:8008 KORTIX_API_KEY="$JWT" \
KORTIX_PROJECT_ID="$PID" LIVE_SKIP_STREAM=1 \
  bun run scripts/live-app.tsx
```

### Driving it headlessly

The test renderer proves component behavior. To prove the real process boots,
paints, answers keys and restores the terminal, run it under a pseudo-terminal
— macOS `script` cannot stand in, because it gives the child no controlling
tty on stdin:

```python
import fcntl, os, pty, select, struct, subprocess, sys, termios, time
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
proc = subprocess.Popen(['bun', 'run', 'src/index.tsx'], stdin=slave,  # or: [kortix, 'tui']
                        stdout=slave, stderr=slave, close_fds=True,
                        preexec_fn=os.setsid,
                        env={**os.environ, 'TERM': 'xterm-256color'})
os.close(slave)
# drain `master` into a buffer; write keys into it (Alt+T is b'\x1bt');
# a clean exit ends the stream with ESC[?1049l.
```

## Known gaps

- **`@path` attachments are not sent.** The SDK's attachment surface is
  browser-`File` shaped, so a path in a prompt is plain text.
- **The draft has no model or agent picker.** `/model`, `/effort` and `/agent`
  read the open session's hook, so a new session starts on the project's
  defaults; pick another model after its first prompt.
- **Capabilities load a moment after a session opens.** Until
  `/kortix/health` answers, every command is offered; a command the runtime
  lacks (`/fork` on pi) is then refused with the reason.
- **Effort options depend on the model's catalog variants.** A model with no
  variants shows `Auto` alone; that is the catalog's answer, not a bug.
- **A session has no name until the server gives it one.** `useSession`
  exposes no name field, so the header and the sidebar read the session list
  instead, and a session created seconds ago is `Untitled` until the first turn
  names it.
- **The account and customize screens are read-mostly.** They expose the small
  writes the web app exposes and print the web URL for anything else.
- **No OAuth from the terminal.** Connectors print the page to open.

## Troubleshooting

### "Token rejected … KORTIX_TOKEN is set in this shell"

A sandbox session exports `KORTIX_TOKEN=kortix_sb_…` for the CLI inside the
sandbox. When that variable is still exported in a developer shell it outranks
`kortix login` for the CLI **and** the TUI (`kortix whoami` prints `host
sandbox … Token rejected` in the same shell). The TUI validates the token at
boot and drops to the login screen with this line; the fix is
`unset KORTIX_TOKEN` (or a fresh terminal), or pick a stored host with
`Enter`. `KORTIX_API_KEY` is the explicit override and wins over both.


- **`ERR_PNPM_UNSUPPORTED_ENGINE` on install.** `@opentui/core` declares
  `engines.node: >=26.4.0`. The repo `.npmrc` documents why `engine-strict` is
  off; re-enabling it breaks this app's install.
- **The native library fails to load.** `@opentui/core-<platform>` is an
  optional dependency resolved per platform and has no build step. If it is
  missing, `pnpm install --force` inside `apps/tui` re-resolves it; a mismatched
  `arm64`/`x64` Bun is the usual cause.
- **`Ctrl+C` does nothing inside the terminal panel.** That is deliberate: the
  shell owns `Ctrl+C`, and a shell without it is not a shell. Leave the TUI with
  `Ctrl+Q`, or `Alt+X` to close the panel first. `Tab`, `Shift+Tab`, `Alt+T`,
  `Alt+P` and `Ctrl+Q` are the only five chords the app keeps while the shell
  has focus.
- **A session sits on `provisioning` for minutes.** A cold sandbox boot is
  minutes, not seconds. The header prints the live `/start` stage; the terminal
  panel and the files screen wait for `ready` rather than failing.
- **A session lists no project commands.** The TUI reads the session runtime's
  `/kortix/health` capabilities once the runtime is up. A runtime without
  `session.commands` lists no project commands in the `/` palette.
- **The terminal is left in a broken state.** Every exit path calls
  `renderer.destroy()`. If a crash ever
  escapes it, `reset` restores the shell; report the stack trace, because that
  path is a bug.
- **Nothing renders, or the frame is blank.** The screen needs at least 80×24.
- **`No Kortix host is configured.`** Only when the login screen itself cannot
  start. Run `kortix login`, or set `KORTIX_API_URL` and `KORTIX_API_KEY`.
