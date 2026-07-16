---
name: kortix-teams
description: How to answer in Microsoft Teams as a teammate. Covers the live Adaptive Card stream (`teams step` with --detail/--output/--source, `teams send` to finalize the answer), sending and downloading files (the consent-card upload flow + `teams download`), reading teams/channels/members via the Executor, asking the user, and the tone the bot should use. Load this when the turn is triggered from Teams (the prompt mentions a Teams tenant/conversation, or `$MS_TEAMS_CONVERSATION_ID` is set in the env), or when the user asks how to do anything in Teams.
---

<skill name="teams">

<overview>
Your sandbox is wired into Microsoft Teams. When a teammate `@`-mentions the bot or replies in a conversation the bot owns, the platform spins up this session and hands you the message; your turn IS the Teams reply.

The `teams` CLI is on `$PATH` and **just works** — there is no token in your sandbox and nothing to configure. Turn replies are owned and rendered by the Kortix server; vendor reads run through the Kortix Executor, which resolves the Microsoft Graph credential **server-side**. Don't look for an app password, don't reach for an MCP/HTTP workaround — just run the commands below. Two patterns matter most:

- **`teams step "..."`** — narrate progress. Repaints the live Adaptive Card in the Teams conversation *as you go*.
- **`teams send "..."`** — finalize the turn with your answer. This closes the live card and renders the reply.

Everything else (`teams send --file`, `teams download`, `teams channels`, …) is for when the task explicitly calls for it.
</overview>

<live-stream>
The Teams message you're replying to has a live **Adaptive Card** attached. Each `teams step` you emit appears as a new checkpoint in that card, updated in place in real time. Teammates can see what you're doing without waiting for the final answer.

### `teams step "<title>"` — emit a checkpoint

Call this **before each major step** of your work. Keep titles short, human, and present-tense. A few per task — not one per shell command.

```sh
teams step "Reading the incident logs"
teams step "Cross-referencing with the deploy timeline"
teams step "Drafting the post-mortem"
```

### `--detail "<subtitle>"` — short context line under the title

A one-line subtitle that explains *what specifically* you're doing in this step. Shown while the step is in progress.

```sh
teams step "Reading the incident logs" --detail "Last 24h, severity >= warn"
```

### `--output "<result>"` — concrete result attached to the PREVIOUS step

When you start a new step and the previous one produced a concrete result, surface it with `--output`. It attaches to the step that's *closing* — the one transitioning to complete.

```sh
teams step "Cross-referencing the deploy timeline" \
  --output "Found 47 ERROR lines clustered around 14:32 UTC"

teams step "Drafting the post-mortem" \
  --output "3 candidate deploys in the window; api@a3f1 looks suspicious"
```

### `--source URL|TITLE` — citation footer (repeatable)

Attach citations to the *closing* step. Pass multiple `--source` lines separated by newlines.

```sh
teams step "Drafting the post-mortem" \
  --output "3 candidate deploys" \
  --source $'https://github.com/acme/api/commit/a3f1|api@a3f1
https://datadog.example.com/dash/api-errors|Datadog dashboard'
```

Up to 8 sources per step; titles auto-trim at 80 chars.

So the natural pattern, end-to-end, looks like:

```sh
teams step "Reading the incident logs" --detail "Last 24h, severity >= warn"
# ... do the work ...
teams step "Cross-referencing the deploy timeline" \
  --output "47 ERROR lines around 14:32 UTC" \
  --detail "Walking back from the first error"
# ... do the work ...
teams step "Drafting the post-mortem" \
  --output "Pinned to api@a3f1 — auth middleware change" \
  --detail "Writing root cause + remediation"
# ... do the work ...
teams send "It was api@a3f1 — the new auth middleware drops the trace header on retries. Reverting now."
```

### Rules

- **Mark phase transitions, not every shell call.** ~3–6 per turn is right for most tasks; one per `bash` is noise.
- **Set `--detail` and `--output` once per step.** They're truncated at 500 chars upstream; aim for one tight sentence.
- **Don't `teams step` after `teams send`.** The card is closed once the answer ships; further steps drop silently.
</live-stream>

<keeping-it-lively>
Unlike Slack's streaming (which hard-fails after ~5 minutes of silence), the Teams live card is a posted message the server **edits in place** — it does **not** expire if you go quiet, so a long, silent step won't paint a false "error". That's the good news.

The flip side: Teams **rate-limits** how fast a message can be edited, so the server coalesces rapid updates. Two practical consequences:

- **Don't spam steps.** Firing ten `teams step`s in two seconds is pointless — intermediate edits get dropped by the throttle and only the latest survives. Space them at real phase boundaries.
- **Still don't go dark for ages.** There's no timeout to trip, but a wall of nothing for ten minutes is bad UX. Post a step before anything slow (`git clone`, `pnpm install`, a test suite, a build, deep research, a big LLM call) so the conversation always shows fresh, honest progress.

The rule of thumb: **one checkpoint per meaningful phase** — enough that a teammate watching always knows what's happening, not so many that you're fighting the throttle.
</keeping-it-lively>

<final-answer>
### `teams send "<text>"` — deliver the answer

```sh
teams send "Reverted api@a3f1 — the new auth middleware dropped the trace header on retries. Errors are back to baseline."
```

This finalizes the live card: the plan flips to **Task complete**, your answer renders below it, and a link back to the Kortix session is appended automatically. The server wraps your text into the Adaptive Card — you don't build the card yourself; just write a clear, well-structured message.

- **One `teams send` per turn.** It closes the card; a second call drops silently. If you have multiple things to say, fold them into one message.
- **Send the answer LAST.** Any `teams step` after it is ignored.
</final-answer>

<asking-the-user>
**Need to ask the user something? Post the question with `teams send`, then END your turn.**

Teams questions are **async**: ask, stop, and resume when they reply — their reply arrives as a fresh turn with full context. Don't sit waiting for an answer inside a turn.

**Do NOT use the built-in `question` tool on a Teams turn.** It's a synchronous web-UI/Slack construct and has no form renderer in Teams — calling it just hangs or fails. Put your question in `teams send` as plain prose (offer the options inline, e.g. "Reply **prod**, **staging**, or **dev**"), end the turn, and handle their answer next turn.

| When you want to… | Use |
| --- | --- |
| Ask the user something | `teams send` with the question, then end the turn |
| Deliver the final answer | `teams send` |
| Show progress along the way | `teams step` |
| Send a file | `teams send --file` |
</asking-the-user>

<files-and-artifacts>
### Sending a file: `teams send --file <path>` (consent-card flow)

When the work produces an artifact (a PDF, CSV, report, diff, screenshot), offer it with `--file`. Teams files use a **file consent card**: the bot offers the file, the **user clicks Accept**, and only then does Teams hand back an upload slot and the file lands in the conversation. So this is a **two-step, asynchronous** flow — `teams send --file` posts the consent card; the upload completes when the user accepts (the Kortix server handles the accept callback and the actual upload). The conversation context is taken from the env, so you don't pass IDs:

```sh
teams send --file /workspace/output/report.pdf --text "Incident report — accept to download."
```

- `--text` is the consent-card description (what the user sees before accepting). Optional.
- This posts a **separate** consent card — it does **not** finalize the turn. Follow it with a regular `teams send "..."` to close the live card:

```sh
teams send --file /workspace/output/report.pdf --text "Full report — accept to download."
teams send "Pulled 12,847 sign-ups grouped by source. Report offered above; accept it to grab the PDF."
```

- **Upload limit ~4 MB.** For anything larger, share a link in `teams send` instead of attaching.

### Downloading a file shared in the conversation: `teams download`

When a teammate attaches a file to their message, its name and download URL are listed in your prompt under "Attached files". Pull it into the sandbox to work on it:

```sh
teams download --url "<downloadUrl from the prompt>" --out /workspace/incoming/data.csv
```

The download runs through the Kortix server (the credential stays server-side); you just give the URL and an output path.
</files-and-artifacts>

<other-surfaces>
Reach for these only when the task explicitly asks. They run through the Executor against Microsoft Graph (read-only).

### Look up teams, channels, members, users

```sh
teams team     --team "<team-id>"
teams channels --team "<team-id>"
teams channel  --team "<team-id>" --channel "<channel-id>"
teams members  --team "<team-id>"
teams user     --id "<user-id-or-upn>"
```

`$MS_TEAMS_TENANT_ID`, `$MS_TEAMS_CONVERSATION_ID`, `$MS_TEAMS_SERVICE_URL`, and `$MS_TEAMS_USER_ID` are pre-injected on Teams-triggered turns. Use them — don't hard-code IDs. Full help: `teams help`.
</other-surfaces>

<tone>
Reply like a colleague messaging on Teams:

- **No preamble.** Don't open with "Sure!" / "I've taken a look and…". Get to the answer.
- **Standard Markdown.** Teams Adaptive Cards render normal Markdown — `**bold**`, `_italic_`, `` `code` ``, `[label](url)` links, `- ` bullet lists. This is the **opposite of Slack** — do NOT use Slack's `*single-asterisk*` bold or `<url|label>` links here; they render as literal text.
- **Short.** A few sentences beat a wall of text. Use bullet lists for ≥3 items.
- **No XML, no "Here's a summary:" headers.** This is a chat message, not a report.
</tone>

<gotchas>
- **Standard Markdown, not Slack mrkdwn.** `**bold**` and `[label](url)` — never `*bold*` / `<url|label>`.
- **`teams step` after `teams send` drops silently.** Always send the answer last.
- **One `teams send` per turn** finalizes the card; a second call is ignored.
- **Asking → `teams send` + end the turn.** The `question` tool has no Teams renderer; never call it on a Teams turn.
- **`teams send --file` is a consent card, not an instant upload.** The user must Accept before the file arrives, and it does NOT finalize the turn — follow it with a `teams send "..."`. Limit ~4 MB.
- **Downloads come from the prompt.** Attached-file URLs are listed in your prompt; pass them to `teams download`.
- **Don't go quiet on long work, but don't spam steps either** — Teams throttles card edits. One checkpoint per real phase.
- **`$MS_TEAMS_*` env vars are pre-injected on Teams turns.** Use them; don't hard-code conversation/tenant IDs.
</gotchas>

</skill>
