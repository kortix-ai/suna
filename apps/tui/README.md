# `@kortix/tui` — Kortix in the terminal (experimental)

A full terminal client for Kortix. It renders with
[OpenTUI](https://github.com/anomalyco/opentui) on Bun and reads every byte of
Kortix data through `@kortix/sdk`. `apps/tui/SPEC.md` is the plan; this file is
how to run it.

**Status: experimental.** `kortix tui` installs it on first run and keys,
screens and flags can change without a deprecation. The public page is
[`/docs/tui`](https://kortix.com/docs/tui) (`apps/web/content/docs/tui.mdx`);
this file is the longer operator's guide.

## Run

```bash
kortix login            # writes ~/.config/kortix/config.json
kortix tui              # first run: "Install now? [Y/n]" — experimental
```

`kortix tui` is a **launcher**, not the app. The `kortix` binary does not carry
the TUI: `@opentui/core` dlopen's an ~19 MB native library per platform and
pulls React in with it, which is 14–21 MB of every `kortix` download for a
command most people never run. So the TUI ships as its own release asset,
`kortix-tui`, built by the same job.

On the first run the launcher asks, downloads the `kortix-tui` matching this
CLI's version from the same GitHub release, verifies it against the release's
`.sha256`, writes it to `~/.kortix/tui/<version>/kortix-tui`, and execs it with
`stdio: 'inherit'` so the child owns the real tty. Later runs exec the cached
copy directly. `apps/cli/src/tui-bin.ts` holds the resolution; it is the same
managed-binary shape as `src/opencode-bin.ts`.

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
| 80 × 24 minimum | Below 100 columns the terminal panel replaces the split instead of sharing it; below 60 columns the sidebar is hidden and `Ctrl+P` is the way around. |
| Kitty keyboard protocol for `Shift+Enter` | A legacy terminal sends a bare `\r` for both `Enter` and `Shift+Enter` and cannot tell them apart. `Ctrl+J` is the portable newline and always works. |
| `Alt` = `Option` on macOS | Terminal.app and iTerm2 send `Alt+T` as the two bytes `ESC t`, which arrive as `meta`, not `option`. The keymap matches either, so `Alt+T`, `Alt+F`, `Alt+O` work in both. In Terminal.app, turn on *Use Option as Meta key*. |
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

## Screens

| Screen | Key | What it is |
| --- | --- | --- |
| Session | default | The transcript, the prompts, and the composer. The terminal panel opens beside it. |
| Files | `Alt+F` | The session sandbox's workspace tree and a syntax-highlighted viewer. |
| Review | `Alt+R` | Open change requests and their diffs. |
| Apps | `Alt+A` | The project's deployed apps, their status and URLs. |
| Customize | `Alt+C` | Agents · Skills · Secrets · Triggers · Connectors. |
| Account | `Alt+U` | Members, invites, roles, and the billing readout. |
| Help | `?` | Every binding below, generated from the keymap. |
| Switcher | `Ctrl+P` | Filter over every session and project. |

## Keys

The `?` overlay prints this table live: it is generated from `src/keymap.ts`
plus every feature's `keys.ts`, so a binding that is not here does not exist.
Regenerate this section with `pnpm --filter @kortix/tui keymap`.

### Anywhere

| Keys | Action |
| --- | --- |
| `Ctrl+c / Ctrl+q` | Quit. Ctrl+C asks once, then quits on the second press. Inside the terminal panel Ctrl+C belongs to the shell and only Ctrl+Q quits. |
| `?` | Show this help. Not while a text input or the terminal has focus. |
| `Tab` | Focus the next region: sidebar → transcript → composer → terminal. |
| `Shift+Tab` | Focus the previous region. |
| `Ctrl+p` | Open the session switcher. |
| `Ctrl+n` | Create a session in this project and open it. |
| `Alt+t` | Toggle the terminal panel. |
| `Alt+f` | Open the files screen. |
| `Alt+r` | Open the review screen. |
| `Alt+a` | Open the apps screen. |
| `Alt+c` | Open the customize screen. |
| `Alt+u` | Open the account screen: members, invites, billing. |
| `Alt+o` | Hand this session to the stock opencode TUI. Returning repaints the app. |
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
| `a` | Attach the selected session in the stock opencode TUI. |
| `n` | Create a session in this project. |
| `y / Enter` | Confirm the delete. |
| `n` | Decline the delete. |
| `Esc` | Cancel the input, the confirm, or the filter. |

### Transcript

| Keys | Action |
| --- | --- |
| `j / ↓` | Scroll down one line. |
| `k / ↑` | Scroll up one line. |
| `PgDn` | Scroll down one screen. |
| `PgUp` | Scroll up one screen. At the top, load older turns. |
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
| `Esc` | Clear the draft, or (empty and busy) stop the agent on a second press. |
| `/` | Open the command picker. Only at column 0. |
| `Alt+m` | Pick the model. |
| `Alt+e` | Pick the thinking effort. |
| `Alt+g` | Pick the agent. |

### Terminal panel

| Keys | Action |
| --- | --- |
| `Alt+y` | Copy `kortix sessions connect <id>` to the clipboard. |
| `Alt+x` | Close the terminal panel. |
| `Alt+Enter` | Reconnect the terminal now. |
| `any other key` | Every other key goes to the remote shell, Ctrl+C included. Quit the TUI with Ctrl+Q; Tab and Alt+T still move focus and toggle the panel. |

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

_143 bindings._

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
config.ts` and `src/api/sdk.ts` for hosts and tokens, `src/web-url.ts` for the
web links the account screen prints, and `src/attach-opencode.ts` +
`src/api/auth.ts` for `Alt+O`.

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

- **`@path` attachments are parsed but not sent.** The composer counts
  mentions and shows `@n`, and the SDK's attachment surface is browser-`File`
  shaped, so a path is not uploaded yet.
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
  `Ctrl+Q`, or `Alt+X` to close the panel first. `Tab`, `Shift+Tab`, `Alt+T` and
  `Ctrl+Q` are the only four chords the app keeps while the shell has focus.
- **A session sits on `provisioning` for minutes.** A cold sandbox boot is
  minutes, not seconds. The header prints the live `/start` stage; the terminal
  panel and the files screen wait for `ready` rather than failing.
- **The first attach is slow.** `Alt+O` downloads the exact `opencode` build the
  sandbox runs into `~/.kortix/opencode/<version>/` once, then reuses it. While
  opencode has the terminal the TUI is suspended and paints nothing; on exit it
  repaints on the same session.
- **Leaving opencode is `Ctrl+C` twice WITHIN one second.** The interval is the
  whole trick: measured, two presses 0.3 s apart exit it and the Kortix TUI
  repaints, while the same two spaced three seconds apart are two separate
  interrupts and opencode stays. `Esc` does not leave it either.
- **The terminal is left in a broken state.** Every exit path calls
  `renderer.destroy()`, and attach resumes in a `finally`. If a crash ever
  escapes it, `reset` restores the shell; report the stack trace, because that
  path is a bug.
- **Nothing renders, or the frame is blank.** The screen needs at least 80×24.
- **`No Kortix host is configured.`** Only when the login screen itself cannot
  start. Run `kortix login`, or set `KORTIX_API_URL` and `KORTIX_API_KEY`.
