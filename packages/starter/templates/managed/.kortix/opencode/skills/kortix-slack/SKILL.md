---
name: kortix-slack
description: How to CONNECT Slack (one command — `kortix channels connect`, prints a one-click install link) and how to answer in Slack as a teammate. Covers the live plan-block stream (`slack step` with --detail/--output, `slack send` to finalize the answer), file uploads, posting to other channels/threads, reactions, search, message editing/deletion, and the tone the bot should use. Load this when the user asks to connect/set up Slack, when the turn is triggered from Slack (the prompt mentions a Slack workspace/channel/thread, or `$SLACK_CHANNEL_ID` is set in the env), or when the user asks how to do anything in Slack.
---

<skill name="slack">

<overview>
Your sandbox is wired into Slack. When a teammate `@`-mentions the bot or replies in a thread the bot owns, the platform spins up this session and hands you the message; your turn IS the Slack reply.

The `slack` CLI is on `$PATH` and **just works** — every call runs through the Kortix connector gateway, which resolves the Slack bot token **server-side**. There is no token in your sandbox and nothing to configure: don't look for `$SLACK_BOT_TOKEN`, don't reach for an MCP/HTTP workaround, just run the commands below. They are the full, supported surface (posting, **file upload**, history, reactions, search, edit/delete — all of it). Two patterns matter most:

- **`slack step "..."`** — narrate progress. Updates the live plan block in the Slack thread *as you go*.
- **`slack send "..."`** — finalize the turn with your answer. This closes the plan block and posts the reply.

Everything else (`slack history`, `slack react`, `slack send --file`, `slack search`, …) is for when the task explicitly asks for it.
</overview>

<connecting>
### "Connect my Slack" = ONE command. Nothing else.

If the project isn't wired to Slack yet (or the user asks to connect/set up
Slack), run:

```sh
kortix channels connect
```

On Kortix Cloud this prints a **one-click "Add to Slack" install link**. Your
entire job is: surface that URL to the user and tell them to open it, pick
their workspace, and click Allow. That's the whole setup — the platform's
shared Slack app handles the webhook, tokens, and connector materialization
automatically. Verify afterwards with `kortix channels status` (or run
`kortix channels connect --wait` to block until the install lands).

Do **NOT**:
- walk the user through creating a Slack app at api.slack.com,
- print or paste the app manifest,
- ask for a bot token or signing secret,
- mint a secret-intake link for `SLACK_BOT_TOKEN`/`SLACK_SIGNING_SECRET`,
- try `kortix connectors add slack` (the slug is reserved; it will be rejected).

The manual path exists ONLY for self-hosted servers without the shared Slack
app — and `kortix channels connect` detects that case itself and prints the
manual instructions (`kortix channels manifest` + `--manual`). Trust its
output; don't pre-empt it.
</connecting>

<live-stream>
The Slack message you're replying to has a live "plan block" attached. Each `slack step` you emit appears as a new checkpoint in that block in real time. Users can see what you're doing without waiting for the final answer.

### `slack step "<title>"` — emit a checkpoint

Call this **before each major step** of your work. Keep titles short, human, and present-tense. A few per task — not one per shell command.

```sh
slack step "Reading the incident logs"
slack step "Cross-referencing with the deploy timeline"
slack step "Drafting the post-mortem"
```

### `--detail "<subtitle>"` — short context line under the title

Use `--detail` to add a one-line subtitle that explains *what specifically* you're doing in this step. Shown while the step is in_progress.

```sh
slack step "Reading the incident logs" --detail "Last 24h, severity >= warn"
```

### `--output "<result>"` — concrete result attached to the PREVIOUS step

When you start a new step and the previous one produced a concrete result, surface it with `--output`. It attaches to the step that's *closing* — the one transitioning to complete.

```sh
slack step "Cross-referencing with the deploy timeline" \
  --output "Found 47 ERROR lines clustered around 14:32 UTC"

slack step "Drafting the post-mortem" \
  --output "3 candidate deploys in the window; api@a3f1 looks suspicious"
```

### Inline links inside `--detail` / `--output`

Use Slack mrkdwn link syntax `<https://… |label>` (NOT Markdown `[label](url)`). Slack server-parses these into proper rich-text link elements rendered inside the task card:

```sh
slack step "Reading the incident logs" \
  --detail "Pulling from <https://datadog.example.com/dash/api-errors|Datadog API errors>"

slack step "Cross-referencing the timeline" \
  --output "Tied to <https://github.com/acme/api/commit/a3f1|api@a3f1> — auth middleware"
```

### `--source URL|TITLE` — citation footer (repeatable)

Attach structured citations to the *closing* task. Slack renders them as a sources strip under that task's card. Pass multiple `--source` lines separated by newlines (use shell heredoc or repeat the flag in a wrapper).

```sh
slack step "Drafting the post-mortem" \
  --output "3 candidate deploys" \
  --source $'https://github.com/acme/api/commit/a3f1|api@a3f1
https://datadog.example.com/dash/api-errors|Datadog dashboard'
```

Up to 8 sources per task, titles auto-trim at 80 chars.

So the natural pattern, end-to-end, looks like:

```sh
slack step "Reading the incident logs" --detail "Last 24h, severity >= warn"
# ... do the work ...
slack step "Cross-referencing the deploy timeline" \
  --output "47 ERROR lines around 14:32 UTC" \
  --detail "Walking back from the first error"
# ... do the work ...
slack step "Drafting the post-mortem" \
  --output "Pinned to api@a3f1 — auth middleware change" \
  --detail "Writing root cause + remediation"
# ... do the work ...
slack send "It was api@a3f1 — the new auth middleware drops the trace header on retries. Reverting now."
```

### Rules

- **Use `slack step` to mark phase transitions, not every shell call.** ~3–6 per turn is right for most tasks; one per `bash` is noise.
- **Set `--detail` and `--output` once per step.** Re-sending them for the same step appends rather than replaces — surprising and ugly.
- **Keep them short.** `--detail` and `--output` get truncated at 500 chars upstream; aim for one tight sentence.
- **Don't `slack step` after you've called `slack send`.** The plan is closed. A later step exits non-zero with `reason: turn_finalized`.
- **A step that did not reach the thread FAILS — it never answers `ok: true`.** `slack step` exits 1 with `{"ok": false, "code": "STEP_NOT_RELAYED", "reason": "<why>", "error": "…<what to do>"}`. Read `reason`, then act:
  - `no_open_turn` — this run was not started from Slack (a web prompt on a Slack-born session), or the turn was already closed. Keep working; if the user is waiting in a thread, post there with `slack send --channel <id> --thread <ts>`.
  - `turn_finalized` — you already answered this turn. One `slack send` per turn.
  - `relay_request_failed` — the Kortix API refused the relay (auth, 5xx, timeout). That is a platform problem, not a missing turn: retry once, then report it in the thread with `--channel/--thread`.
  - `stream_open_failed` / `post_failed` — Slack rejected the message. Continue; deliver the answer with `slack send` at the end.
  Never assume a step was seen when the command failed.
</live-stream>

<keeping-the-stream-alive>
### A live run has no idle timeout — silence only hurts the user

The plan block is a posted message the server **edits in place**. It is not an open stream, so Slack cannot auto-fail it. A long, silent step (a build, a test suite, a `task`/subagent) does not paint an error and does not end your run. The server closes a thread on its own only when your run has **ended** and no `slack send` reached the thread within 30 minutes. That thread then shows "This run ended without a reply."

**Do not run heartbeat loops** (`while sleep …; do slack step …; done`). They buy nothing, and a loop left running after `slack send` is a leak.

A wall of nothing for ten minutes is still bad UX:

- **Post a step before anything slow** — `git clone`, `pnpm install`, a test suite, a build, `pnpm preview`, deep research, a big LLM call, a `task`/subagent — so the thread shows what you are waiting on.
- **Narrate long work in phases.** `slack step "Installing deps"` → `slack step "Running typecheck"` → `slack step "Running tests"` reads better than one silent 12-minute block.
- **Space steps at real phase boundaries.** Ten steps in two seconds add noise, not information.
</keeping-the-stream-alive>

<final-answer>
### `slack send "<text>"` — plain-text answer

For a one-liner, post directly:

```sh
slack send "Reverted api@a3f1. Errors are back to baseline — auth header is now preserved on retry."
```

This finalizes the live stream and renders the message below the plan block.

### `slack send --blocks-file <path>` — Block Kit answer (preferred for structure)

When the response has real structure — sections, headers, lists, links, citations — ship it as Block Kit. Slack accepts a closing `blocks` chunk on `chat.stopStream`, so the rich layout renders inline below the plan block. Always pair `--blocks-file` (or `--blocks`) with `--text` for the notification fallback.

Write the JSON to a temp file, then send:

```sh
cat > /tmp/answer.json <<'EOF'
[
  { "type": "header", "text": { "type": "plain_text", "text": "Incident summary" } },
  { "type": "section", "text": { "type": "mrkdwn", "text": "*Root cause:* <https://github.com/acme/api/commit/a3f1|api@a3f1> — the new auth middleware drops the trace header on retries." } },
  { "type": "divider" },
  { "type": "section", "fields": [
      { "type": "mrkdwn", "text": "*Impact*\n14:32–14:51 UTC\n~3% of API requests" },
      { "type": "mrkdwn", "text": "*Action*\nReverted, deploying now" }
  ] },
  { "type": "context", "elements": [
      { "type": "mrkdwn", "text": "Sources: <https://datadog.example.com/dash/api-errors|Datadog>  ·  <https://github.com/acme/api/pull/8421|Revert PR>" }
  ] }
]
EOF

slack send --text "Reverted api@a3f1 — root cause was the auth middleware" --blocks-file /tmp/answer.json
```

Use Block Kit when ANY of these apply:
- The answer has 2+ distinct sections (root cause + impact + action, or summary + details + sources).
- You're presenting comparisons, tables, or lists of items.
- The answer should cite multiple sources prominently.
- The response benefits from a clear title (use a `header` block).

Use plain `slack send "..."` when the answer is short prose with no structure.

### Block Kit cheat sheet

Common block types the agent uses most:

| Block | Use for |
| --- | --- |
| `header` (plain_text) | Title of the answer |
| `section` (mrkdwn) | Most prose, including `<url|label>` links |
| `section` with `fields` | 2-column key/value layout (max 10 fields) |
| `divider` | Visual break between sections |
| `context` (mrkdwn) | Small footer text, sources, timestamps |
| `image` (image_url + alt_text) | Charts, screenshots — needs a public URL |
| `actions` (buttons / select menu) | Inline interactivity for follow-ups |
| `carousel` (of `card` elements) | Side-scrollable gallery — see below |

### Carousel of cards — for presenting a list of choices/items

When the answer is a *list of things the user might pick between or browse* (deploy candidates, repo search hits, scheduled meetings, design variants), a carousel of cards reads way better than a markdown list. Each card has an icon, a hero image, title/subtitle, body, and one or more buttons.

**Important constraints (Slack rules, not ours):**
- Cards live ONLY inside a `carousel` block.
- Cards support `body` (mrkdwn) and `actions` (buttons / select menus) — they do **NOT** support `input` / `radio_buttons` / `checkboxes`. To ask the user to choose, use the `question` tool instead.
- Each card's button click fires a `block_actions` interaction; the platform routes it back as a follow-up Slack message (`Picked: <button label>`) into the same thread, the agent's next turn starts from that.
- 2–10 cards per carousel.

Example — presenting 3 deploy candidates:

```jsonc
[
  { "type": "section", "text": { "type": "mrkdwn", "text": "*Three deploy candidates* — pick one to ship:" } },
  {
    "type": "carousel",
    "elements": [
      {
        "type": "card",
        "block_id": "deploy_a3f1",
        "icon": { "type": "image", "image_url": "https://github.com/acme.png?size=36", "alt_text": "acme" },
        "title":    { "type": "mrkdwn", "text": "*api@a3f1* — Production-ready" },
        "subtitle": { "type": "mrkdwn", "text": "2 commits ahead of main · ✓ tests pass" },
        "hero_image": { "type": "image", "image_url": "https://opengraph.githubassets.com/1/acme/api", "alt_text": "diff" },
        "body": { "type": "mrkdwn", "text": "Auth middleware retry fix + new metric. Safe to ship — small surface area, full coverage." },
        "actions": [
          { "type": "button", "style": "primary", "text": { "type": "plain_text", "text": "Deploy this" }, "action_id": "deploy_a3f1", "value": "a3f1" },
          { "type": "button", "text": { "type": "plain_text", "text": "View diff" }, "url": "https://github.com/acme/api/compare/main...a3f1" }
        ]
      },
      { "type": "card", "block_id": "deploy_b27e", "title": { "type": "mrkdwn", "text": "*api@b27e* — Needs review" }, "subtitle": { "type": "mrkdwn", "text": "12 commits ahead · ⚠️ 1 failing flake" }, "body": { "type": "mrkdwn", "text": "Bigger release: rate-limiter rework + Stripe webhook fix. Flake is in webhook tests." }, "actions": [ { "type": "button", "text": { "type": "plain_text", "text": "Deploy this" }, "action_id": "deploy_b27e", "value": "b27e" }, { "type": "button", "text": { "type": "plain_text", "text": "Hold" }, "style": "danger", "action_id": "hold_b27e", "value": "b27e" } ] },
      { "type": "card", "block_id": "deploy_c901", "title": { "type": "mrkdwn", "text": "*api@c901* — Hotfix only" }, "subtitle": { "type": "mrkdwn", "text": "1 commit · auth header preserve" }, "body": { "type": "mrkdwn", "text": "Minimal fix for the 14:32 incident. Lowest risk." }, "actions": [ { "type": "button", "style": "primary", "text": { "type": "plain_text", "text": "Deploy this" }, "action_id": "deploy_c901", "value": "c901" } ] }
    ]
  }
]
```

Ship it the same way as any Block Kit answer:

```sh
slack send --text "Pick a deploy candidate" --blocks-file /tmp/candidates.json
```

**When to reach for carousel:**
- 2–6 items the user is choosing between, each with non-trivial context (subtitle, body, hero image).
- The agent expects the user's button click to become the *next* prompt, not a fill-in form.

**When NOT to:**
- For plain choices with no card-worthy context (use `question` instead).
- For 1 item (just a section) or 7+ items (split, paginate, or summarize).
- For a quick yes/no (use `question`).

Full Block Kit reference: <https://docs.slack.dev/reference/block-kit/blocks/>

### Tone (applies to either mode)

Reply like a colleague messaging on Slack:

- **No preamble.** Don't open with "Sure!" / "I've taken a look and…". Get to the answer.
- **Slack mrkdwn.** `*bold*` (single asterisks), `_italic_`, `` `code` ``, ` ```code blocks``` `. Markdown-style `**bold**` renders as literal asterisks — don't use it.
- **Short.** A few sentences > a wall of text. Use bullet lists for ≥3 items.
- **Link with `<url|text>`.** Slack's syntax, not Markdown `[label](url)`.
- **No XML / no "Here's a summary:" headers.** This is a chat message, not a report.

### One `slack send` per turn

Each turn finalizes exactly one stream. Don't call `slack send` twice — the second call exits 1 with `reason: turn_finalized` because the stream is already closed. If you need to deliver multiple things, fold them into one Block Kit message or use `slack send --channel ...` for sibling posts.

### When `slack send` fails

A `slack send` with no `--channel` is the turn's answer. When it cannot be delivered into a Slack turn it exits 1 with `{"ok": false, "code": "ANSWER_NOT_RELAYED", "reason": "<why>", "error": "…<what to do>"}` — it never prints `ok: true` for an undelivered answer. `no_open_turn` means this run was not started from Slack, or the turn was closed before you answered; if the user is waiting in a thread, deliver the same answer with `slack send --channel <id> --thread <ts>` (the channel and thread are in the prompt header and in `$SLACK_CHANNEL_ID` / `$SLACK_THREAD_TS`). `relay_request_failed` is a Kortix API failure, not a missing turn: retry once, then post with `--channel/--thread`.
</final-answer>

<asking-the-user>
### Use opencode's built-in `question` tool — Slack renders the buttons

**Rule: if your reply asks the user to choose, call the `question` tool. Never put a list of choices inside `slack send`.**

`slack send` finalizes the turn and closes the live stream — once it fires, the user can only reply with free text. A list of choices written into it cannot be clicked.

When the turn is Slack-triggered, the Kortix server posts the question(s) into the thread: each question in bold, the option descriptions listed under it, and one clickable button per option. The tool returns **at once** with a note telling you to end your turn — it does not block, and it does not return the user's answer. END the turn.

The answer arrives as your NEXT turn, with full context:

- a button click → `Answering your question "<question>":` and the picked label;
- a reply typed in the thread → the message itself.

| When you want to… | Use |
| --- | --- |
| Ask the user to choose | `question` tool |
| Ask something genuinely open-ended | `slack send` with the question |
| Deliver the final answer / summary | `slack send` |
| Show progress along the way | `slack step` |
| Post a separate message to another channel | `slack send --channel ...` |

### Calling the `question` tool

Per opencode's schema, every option has a `label` (1–5 words) and a `description`:

```jsonc
{
  "questions": [
    {
      "question": "Which environment should I deploy to?",
      "header": "Environment",          // short label (max 30 chars)
      "options": [
        { "label": "Production", "description": "Live traffic; needs a rollback plan" },
        { "label": "Staging",    "description": "Mirrors prod data; safe to break" },
        { "label": "Dev",        "description": "Sandbox; no real users" }
      ]
    }
  ]
}
```

### Rules

- **One question per call when the answers depend on each other.** Each click starts its own turn and carries one answer. Several questions in one call post several rows of buttons, and the user clicks them one at a time.
- **`multiple` and `custom` change nothing in Slack.** Every option is a one-click button, and a reply typed in the thread always works.
- **Put the tradeoff in `description`.** A button shows only its label; the descriptions are listed above the buttons.
- **Skip trivial yes/no when context implies the answer.** Ask only what blocks you — not "are you sure?" rituals.
</asking-the-user>

<files-and-artifacts>
### Uploading files: `slack send --file <path> --channel <id>`

**File upload is fully supported — `slack send --file` is the way.** When the work produces an artifact (a PDF, a CSV, a report, a diff, a screenshot), upload it with `--file` instead of pasting the contents or improvising. Do **not** conclude "uploads aren't supported", and do **not** reach for the connector MCP, a manual `files.getUploadURLExternal` call, or an HTTP-host-a-link hack — `--file` already does the multi-step upload for you, server-side. It requires a `--channel` and (typically) a `--thread` so it lands under the answer:

```sh
slack send \
  --channel "$SLACK_CHANNEL_ID" \
  --thread  "$SLACK_THREAD_TS" \
  --file    /workspace/output/report.md \
  --text    "Full report ↓"
```

`$SLACK_CHANNEL_ID` and `$SLACK_THREAD_TS` are pre-set on Slack-triggered turns. Use them.

**Note:** `slack send --file ...` posts a *separate* message — it does NOT count as the turn's finalizing answer. Combine it with a regular `slack send "..."` to also close the stream:

```sh
slack send --channel "$SLACK_CHANNEL_ID" --thread "$SLACK_THREAD_TS" \
  --file /workspace/output/report.md --text "Full report attached."
slack send "Pulled 12,847 sign-ups, grouped by source. CSV above."
```
</files-and-artifacts>

<other-surfaces>
Reach for these only when the task explicitly asks for them.

### Read prior thread context

```sh
slack history --channel "$SLACK_CHANNEL_ID" --thread "$SLACK_THREAD_TS"
slack thread   --channel "$SLACK_CHANNEL_ID" --ts     "$SLACK_THREAD_TS"
```

### React to a message

```sh
slack react --channel "$SLACK_CHANNEL_ID" --ts "$SLACK_TRIGGER_TS" --emoji "white_check_mark"
```

### Post to a different channel (announcements, cross-posts)

```sh
slack send --channel "C0123ABCD" --text "Heads up: rolled api@a3f1 forward."
```

### Edit / delete a message you posted earlier

```sh
slack edit   --channel "$SLACK_CHANNEL_ID" --ts "<msg_ts>" --text "Updated answer."
slack delete --channel "$SLACK_CHANNEL_ID" --ts "<msg_ts>"
```

### Search the workspace

```sh
slack search --query "deploy api@"
```

### Look up users / channels

```sh
slack users
slack user        --user "U0123ABCD"
slack channels
slack channel-info --channel "C0123ABCD"
slack me
```

### Download a file shared in the thread

```sh
slack file-info --file "F0123ABCD"
slack download  --url "<file.url_private>" --out /workspace/incoming/x.png
```

Full help: `slack help`.
</other-surfaces>

<gotchas>
- **`*bold*` not `**bold**`.** Slack uses single asterisks. Double-asterisk markdown renders as literal asterisks.
- **`--detail` and `--output` are append-not-replace per step.** Set each only once on the step that owns it. If you need to revise, advance to a new step.
- **`slack step` after `slack send` drops silently.** Plan block is closed once the answer ships. Always send the answer last.
- **`slack send --file` does NOT finalize the stream.** It posts a separate file message. Follow it with a regular `slack send "..."` to close the turn.
- **`$SLACK_CHANNEL_ID`, `$SLACK_THREAD_TS`, `$SLACK_TRIGGER_TS` are pre-injected on Slack turns.** Use them — don't hard-code IDs.
- **Stay in the thread.** Unless the task explicitly says "post in #channel-X", everything goes in the originating thread. Cross-posting to other channels needs a real reason (incident broadcast, scheduled digest).
- **The user can hit Stop.** A red Stop button sits under the plan block; the user can click it any time. If you see the turn end abruptly, that's why — don't retry automatically.
</gotchas>

</skill>
