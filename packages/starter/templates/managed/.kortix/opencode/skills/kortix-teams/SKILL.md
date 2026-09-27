---
name: kortix-teams
description: How to CONNECT Microsoft Teams (`kortix channels connect --platform teams`, prints a tenant-admin consent URL) and how to answer in Teams as a teammate. Covers the live Adaptive Card stream (`teams step` with --detail/--output/--source, `teams send` to finalize the answer), sending and downloading files (the consent-card upload flow + `teams download`), reading teams/channels/members through connector calls, asking the user, and the tone the bot should use. Load this when the turn is triggered from Teams (the prompt mentions a Teams tenant/conversation, or `$MS_TEAMS_CONVERSATION_ID` is set in the env), or when the user asks how to do anything in Teams.
---

<skill name="teams">

<connecting>
**Everything below assumes Teams is already connected.** If the user is ASKING to
connect it — or a `teams` command fails with no installation — that is one
command, not a project:

```sh
kortix channels status --platform teams     # is this project connected?
kortix channels connect --platform teams    # prints the Microsoft admin-consent URL
```

`connect` prints an **admin-consent URL**. The user opens it and grants
tenant-wide consent; the app is then published to their Teams catalog
automatically. There is no app to create by hand and no token to paste — a
Microsoft **tenant admin** has to be the one who approves it, so if the user
isn't an admin, they need to forward that link to someone who is.

`kortix channels disconnect --platform teams` removes an installation;
`kortix channels manifest --platform teams` prints the app manifest and is
**only** for manual/self-host setup (the consent flow never needs it).

**Channels vs personal chats.** In a personal chat every message reaches you.
In a team channel or group chat, Teams only delivers a message when the bot is
`@`-mentioned — UNLESS the tenant admin has consented to the "receive all
channel messages" permission, after which a reply in a thread the bot already
owns continues the session without a mention. Either way, a new channel post
needs the mention.
</connecting>

<overview>
Once connected, your sandbox is wired into Microsoft Teams. When a teammate `@`-mentions the bot or replies in a conversation the bot owns, the platform spins up this session and hands you the message; your turn IS the Teams reply.

The `teams` CLI is on `$PATH` and **just works** — there is no token in your sandbox and nothing to configure. Turn replies are owned and rendered by the Kortix server; vendor reads run through the Kortix connector gateway, which resolves the Microsoft Graph credential **server-side**. Don't look for an app password, don't reach for an MCP/HTTP workaround — just run the commands below. Two patterns matter most:

- **`teams step "..."`** — narrate progress. Repaints the live Adaptive Card in the Teams conversation *as you go*.
- **`teams send "..."`** — finalize the turn with your answer. This closes the live card and renders the reply. Markdown (headings, `code`, ```fenced blocks```, tables, lists) is converted to card elements, so write normally.
- **`teams send --card-file <path>`** — deliver a full Adaptive Card JSON as the reply instead of text, for rich layouts. The JSON's top-level `type` must be `"AdaptiveCard"`.

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
- **Don't `teams step` after `teams send`.** The card is closed once the answer ships; a later step from the same run is dropped.
</live-stream>

<keeping-it-lively>
Unlike Slack's streaming (which hard-fails after ~5 minutes of silence), the Teams live card is a posted message the server **edits in place**. It stays open as long as your run is alive, so a long, silent step (a build, a test suite) won't paint a false "error". That's the good news.

The flip side: Teams **rate-limits** how fast a message can be edited, so the server coalesces rapid updates. Two practical consequences:

- **Don't spam steps.** Firing ten `teams step`s in two seconds is pointless — intermediate edits get dropped by the throttle and only the latest survives. Space them at real phase boundaries.
- **Still don't go dark for ages.** A live run has no timeout to trip, but a wall of nothing for ten minutes is bad UX. Post a step before anything slow (`git clone`, `pnpm install`, a test suite, a build, deep research, a big LLM call) so the conversation always shows fresh, honest progress.

The rule of thumb: **one checkpoint per meaningful phase** — enough that a teammate watching always knows what's happening, not so many that you're fighting the throttle.
</keeping-it-lively>

<final-answer>
### `teams send "<text>"` — deliver the answer

```sh
teams send "Reverted api@a3f1 — the new auth middleware dropped the trace header on retries. Errors are back to baseline."
```

This finalizes the live card: the plan flips to **Task complete**, your answer renders below it, and a link back to the Kortix session is appended automatically. The server wraps your text into the Adaptive Card — you don't build the card yourself; just write a clear, well-structured message.

- **One `teams send` per turn.** It closes the card; a second call from the same run is dropped. If you have multiple things to say, fold them into one message.
- **Send the answer LAST.** A `teams step` after it is dropped.
</final-answer>

<asking-the-user>
**Need to ask the user something with choices? Call the built-in `question` tool, then END your turn.**

It renders a real card, the same shape as asking in the Kortix app:

- **one question, up to 6 options, one answer** → a button per option, one tap;
- **several questions, a multi-select, or more than 6 options** → a form: each
  question with its options listed, a box for an answer of their own, and one
  Submit;
- **a question with no options** → a text box.

Put the detail in each option's `description` — the card shows it. The user
can always reply in the chat instead of using the card, so a closed list never
traps them. The tool returns **at once** with a note telling you to end your
turn — it does not block. The user's answer arrives as your NEXT turn, with
full context. Don't sit waiting for it inside a turn.

A numbered list of choices written into `teams send` is the wrong shape: the
user cannot tap it. Use `teams send` for a question only when it is genuinely
open-ended prose with nothing to pick.

```jsonc
{
  "questions": [
    {
      "question": "Which environment should I deploy to?",
      "header": "Environment",          // shown above the question (max 30 chars)
      "options": [
        { "label": "Production", "description": "Live traffic; needs a rollback plan" },
        { "label": "Staging",    "description": "Mirrors prod data; safe to break" }
      ]
      // "multiple": true lets the user pick several
    }
  ]
}
```

The answer comes back labelled with its question, one line per question.

### `teams ask --form-file <path>` — a form the `question` tool cannot express

When you need an input the `question` tool has no shape for — a date, a time,
a number, a toggle — write the form yourself. Teams renders it as a card with
real text boxes, dropdowns, toggles and one Submit button. Write a small JSON
spec; the server builds the card.

```sh
cat > /tmp/form.json <<'JSON'
{
  "title": "Deploy details",
  "subtitle": "Two things before I start",
  "submitLabel": "Deploy",
  "fields": [
    { "id": "env", "label": "Environment", "type": "choice",
      "choices": ["prod", "staging"], "required": true },
    { "id": "notes", "label": "Anything I should know?", "type": "textarea" },
    { "id": "dry", "label": "Dry run first", "type": "toggle" }
  ]
}
JSON
teams ask --form-file /tmp/form.json --text "Before I deploy:"
```

Field `type`: `text`, `textarea`, `number`, `date`, `time`, `choice`,
`multichoice`, `toggle`. Add `placeholder`, `value` (prefill) and
`required`. Up to 12 fields, 24 choices each.

`ask` **finalizes the turn**, exactly like `send`. The user's Submit arrives as
your NEXT turn with their answers, so post the form and then END your turn.

| When you want to… | Use |
| --- | --- |
| Ask anything with choices — one question or several | the `question` tool |
| Ask for a date, time, number, or toggle | `teams ask --form-file` |
| Ask something genuinely open-ended | `teams send` with the question |
| Deliver the final answer | `teams send` |
| Show progress along the way | `teams step` |
| Send a file | `teams send --file` |

Whichever you use, the reply arrives as your NEXT turn. Ask, then END the turn.
</asking-the-user>

<files-and-artifacts>
### Sending a file: `teams send --file <path>`

When the work produces an artifact (a PDF, CSV, report, diff, screenshot), offer it with `--file`. The server picks the delivery from the env — you always just run `teams send --file`:

- **An image** (PNG, JPEG, GIF, WebP) → shown **inline** in the conversation, in every scope: personal chat, group chat, channel.
- **Any other file, personal chat** → a **file consent card**: you offer the file, the user clicks Accept, and only then does Teams upload it. Two-step and asynchronous.
- **Any other file, channel** → uploaded to the team's SharePoint drive and shared as a link card (needs the bot app's `Files.ReadWrite.All` permission — if it is missing, the command returns a clear error you can relay).
- **Any other file, group chat** → not possible: Teams gives a bot no way to send a file into a group chat. Share a link in `teams send` instead.

An image too large for Teams to show inline falls back to the same path as any other file; in a group chat the command returns an error that asks for a smaller image.

The conversation context is taken from the env, so you don't pass IDs:

```sh
teams send --file /workspace/output/chart.png --text "Sign-ups by source"
teams send --file /workspace/output/report.pdf --text "Incident report — accept to download."
```

- `--text` is the caption, or the consent-card description (what the user sees before accepting). Optional.
- `--file` posts a **separate** message — it does **not** finalize the turn. Follow it with a regular `teams send "..."` to close the live card:

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

### Images: download, then just look at them

A pasted screenshot arrives as an attachment marked `(image)` — in a personal
chat, a group chat, and a channel alike. Download it and open it with the
**`read` tool** — you can see images directly.

```sh
teams download --url "<downloadUrl from the prompt>" --out /workspace/attachment.png
# then: read /workspace/attachment.png
```

Kortix runs an image-bearing turn on a model that can see images, so this
works even when the conversation's usual model is text-only.

**Do not go looking for OCR.** ImageMagick, tesseract, PIL and an image-captioning
API are all the wrong move — if `read` shows you the image, describe what you
see. If it genuinely does not, say so in `teams send` rather than ending the
turn silently.
</files-and-artifacts>

<reading-the-conversation>
### `teams history` / `teams thread` — what was said before you were mentioned

In a **channel** the bot acts only on messages that @mention it. The
discussion you were asked about is NOT in your session. Read it:

```sh
teams thread              # the thread you were mentioned in: the root post + every reply
teams history --limit 20  # recent posts in this channel
```

Both print JSON: `messages[]` with `from`, `text` (HTML stripped), `at`, and
`id`, oldest first. Deleted and system messages are dropped. The channel,
thread, and team come from the env — pass `--team`, `--channel`, or
`--message` only to read somewhere else.

- **In a personal chat you need neither.** Every message there already
  reaches this session. Both commands return `NOT_A_CHANNEL`.
- **`NO_TEAM`**: Teams did not send the team id with this message. Pass
  `--team <team-id>` if the user gave you one; otherwise say in `teams send`
  that you cannot read the channel. Do not guess an id.
- **A `403` from Microsoft Graph** means the Kortix app is not installed in
  that team, or the tenant has not granted it permission to read messages.
  Say so in `teams send`; do not retry.
- **`teams history` prints the help instead of JSON**: this sandbox was built
  before the command existed. Say you cannot read the channel from here.
</reading-the-conversation>

<posting-somewhere-else>
### Proactive posting — `teams post`

`teams send` answers the message you are handling. To post somewhere **else**
— a nightly summary into a team channel, an alert, a hand-off note — use
`teams post`. It does not touch the current turn.

```sh
teams conversations                                    # what you may post into
teams post --conversation "19:...@thread.tacv2" "Nightly build is green."
teams post --conversation "19:..." --card-file /tmp/report.json
```

You can only post into a chat or channel the bot is **already in for this
project**. Anything else returns 403 — list the targets first rather than
guessing an id.
</posting-somewhere-else>

<other-surfaces>
Reach for these only when the task explicitly asks. They run through the connector gateway against Microsoft Graph (read-only).

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
- **Send the answer last.** A `teams step` after `teams send` is dropped.
- **One `teams send` per turn** finalizes the card; a second call from the same run is dropped. After a `question` card, do not `teams send` at all — the card is your reply.
- **Asking → the `question` tool + end the turn.** It renders a real card and returns at once; the answer is your next turn. An older copy of this skill said the tool had no Teams renderer — that is no longer true.
- **`teams send --file`: an image is shown inline in every scope.** Any other file in a personal chat is a consent card — the user must Accept, and it does NOT finalize the turn, so follow it with a `teams send "..."`. In a channel a document becomes a drive link. An image too large to show inline falls back the same way; in a group chat it comes back as an error asking for a smaller one. Limit ~4 MB.
- **Downloads come from the prompt.** Attached-file URLs are listed in your prompt; pass them to `teams download`.
- **Don't go quiet on long work, but don't spam steps either** — Teams throttles card edits. One checkpoint per real phase.
- **`$MS_TEAMS_*` env vars are pre-injected on Teams turns.** Use them; don't hard-code conversation/tenant IDs.
</gotchas>

</skill>
