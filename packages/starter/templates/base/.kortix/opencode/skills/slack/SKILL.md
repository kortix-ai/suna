---
name: slack
description: How to answer in Slack as a teammate. Covers the live plan-block stream (`slack step` with --detail/--output, `slack send` to finalize the answer), file uploads, posting to other channels/threads, reactions, search, message editing/deletion, and the tone the bot should use. Load this when the turn is triggered from Slack (the prompt mentions a Slack workspace/channel/thread, or when `$SLACK_BOT_TOKEN` is set in the env), or when the user asks how to do anything in Slack.
---

<skill name="slack">

<overview>
Your sandbox is wired into Slack. When a teammate `@`-mentions the bot or replies in a thread the bot owns, the platform spins up this session and hands you the message; your turn IS the Slack reply.

The `slack` CLI is on `$PATH` and authenticated with `$SLACK_BOT_TOKEN`. Two patterns matter most:

- **`slack step "..."`** — narrate progress. Updates the live plan block in the Slack thread *as you go*.
- **`slack send "..."`** — finalize the turn with your answer. This closes the plan block and posts the reply.

Everything else (`slack history`, `slack react`, `slack send --file`, `slack search`, …) is for when the task explicitly asks for it.
</overview>

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
- **Don't `slack step` after you've called `slack send`.** The plan is closed. Further steps drop silently.
</live-stream>

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
- Cards support `body` (mrkdwn) and `actions` (buttons / select menus) — they do **NOT** support `input` / `radio_buttons` / `checkboxes`. If you need form inputs, use the `question` tool instead.
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
- For mid-turn structured input (use `question` instead — carousel can't host inputs).
- For 1 item (just a section) or 7+ items (split, paginate, or summarize).
- For a quick yes/no (use `question` with single-select).

Full Block Kit reference: <https://docs.slack.dev/reference/block-kit/blocks/>

### Tone (applies to either mode)

Reply like a colleague messaging on Slack:

- **No preamble.** Don't open with "Sure!" / "I've taken a look and…". Get to the answer.
- **Slack mrkdwn.** `*bold*` (single asterisks), `_italic_`, `` `code` ``, ` ```code blocks``` `. Markdown-style `**bold**` renders as literal asterisks — don't use it.
- **Short.** A few sentences > a wall of text. Use bullet lists for ≥3 items.
- **Link with `<url|text>`.** Slack's syntax, not Markdown `[label](url)`.
- **No XML / no "Here's a summary:" headers.** This is a chat message, not a report.

### One `slack send` per turn

Each turn finalizes exactly one stream. Don't call `slack send` twice — the second call drops silently because the stream is already closed. If you need to deliver multiple things, fold them into one Block Kit message or use `slack send --channel ...` for sibling posts.
</final-answer>

<asking-the-user>
### Use opencode's built-in `question` tool — Slack renders the form

**Rule: if your reply contains a question, call the `question` tool. Never put questions inside `slack send`.**

`slack send` finalizes the turn and closes the live stream — once it fires, the user can only reply with a free-text message. If you posted multi-choice questions via `slack send`, the answers come back as unstructured prose and you have to re-parse them. Don't.

opencode ships a native `question` tool. Call it the same way you would in any other host (dashboard, TUI). When the turn is Slack-triggered, the sandbox automatically catches the `question.asked` event and renders a Block Kit form (radio buttons / checkboxes / a free-text box) in the same thread. The user submits → opencode resumes your tool call with their answers. Zero Slack-specific glue from your side.

| When you want to… | Use |
| --- | --- |
| Ask a question or set of questions | `question` tool |
| Deliver the final answer / summary | `slack send` |
| Show progress along the way | `slack step` |
| Post a separate message to another channel | `slack send --channel ...` |

### Calling the `question` tool

Per opencode's schema (`Array<QuestionInfo>`):

```jsonc
{
  "questions": [
    {
      "question": "Which environment should I deploy to?",
      "header": "Environment",          // short label (max 30 chars)
      "options": [
        { "value": "prod",    "label": "Production" },
        { "value": "staging", "label": "Staging" },
        { "value": "dev",     "label": "Dev (sandbox)" }
      ],
      "multiple": false,                 // false = radio, true = checkboxes
      "custom":   true                   // true = also show a free-text box
    }
  ]
}
```

Multiple questions in one call:

```jsonc
{
  "questions": [
    {
      "question": "Priority for next sprint",
      "header":   "Priority",
      "options": [
        { "value": "auth",    "label": "Finish the auth migration" },
        { "value": "billing", "label": "Ship metered billing v2" },
        { "value": "ingest",  "label": "Rebuild the ingest pipeline" }
      ],
      "multiple": false
    },
    {
      "question": "What risks should I flag?",
      "header":   "Risks",
      "options": [
        { "value": "rollback", "label": "Rollback complexity" },
        { "value": "perf",     "label": "Performance regressions" },
        { "value": "data",     "label": "Data migrations" }
      ],
      "multiple": true
    },
    {
      "question": "Any constraints I should know about?",
      "header":   "Constraints",
      "options":  [],
      "custom":   true
    }
  ]
}
```

### Reading the answer

The `question` tool's return value is `answers: string[][]` — one array per question, in the same order you sent them. Each inner array contains every value the user picked, plus any free-text they typed into the custom field (concatenated at the end).

```jsonc
// for the 3-question example above
[
  ["auth"],                              // single-select
  ["rollback", "data"],                  // multi-select
  ["Vendor X freeze ends Tuesday."]      // custom text only
]
```

### Rules

- **Use the `question` tool, not chat prose.** A free-text reply loses structure.
- **Keep it focused.** 1–3 questions per call. If you need more, split into multiple `question` calls across the turn (each is its own pause).
- **Form expires after 15 minutes.** If the user doesn't click Submit, the form resolves with empty arrays — opencode treats that as a reject; the tool returns and you can adapt.
- **The Stop button still works.** A user who clicks 🛑 Stop aborts the turn; the form is closed and the tool returns empty.
- **Skip trivial yes/no when context implies the answer.** Use judgment — the form is for *real* decisions, not "are you sure?" rituals.
</asking-the-user>

<files-and-artifacts>
### Uploading files: `slack send --file <path> --channel <id>`

When the work produces an artifact (a CSV, a report, a diff, a screenshot), upload it instead of pasting the contents. `--file` requires a `--channel` and (typically) a `--thread` so it lands under the answer:

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
