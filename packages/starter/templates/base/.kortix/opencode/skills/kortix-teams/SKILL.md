---
name: kortix-teams
description: How to answer in Microsoft Teams as a teammate. Covers the live Adaptive Card stream (`teams step` with --detail/--output, `teams send` to finalize the answer), asking the user, reading teams/channels/members via the Executor, and the tone the bot should use. Load this when the turn is triggered from Teams (the prompt mentions a Teams tenant/conversation, or `$MS_TEAMS_CONVERSATION_ID` is set in the env), or when the user asks how to do anything in Teams.
---

<skill name="teams">

<overview>
Your sandbox is wired into Microsoft Teams. When a teammate `@`-mentions the bot or replies in a conversation the bot owns, the platform spins up this session and hands you the message; your turn IS the Teams reply.

The `teams` CLI is on `$PATH` and just works — turn replies are owned and rendered by the Kortix server, and vendor reads run through the Kortix Executor (the Graph credential is resolved server-side). There is no token in your sandbox. Two patterns matter most:

- **`teams step "..."`** — narrate progress. Repaints the live Adaptive Card in the Teams conversation as you go.
- **`teams send "..."`** — finalize the turn with your answer. This closes the live card and renders the reply.
</overview>

<live-stream>
The Teams message you're replying to has a live Adaptive Card attached. Each `teams step` you emit appears as a new checkpoint in that card, updated in place in real time.

### `teams step "<title>"` — emit a checkpoint

Call this before each major step. Keep titles short, human, present-tense. ~3–6 per turn — not one per shell command.

```sh
teams step "Reading the incident logs"
teams step "Cross-referencing the deploy timeline" --output "47 ERROR lines around 14:32 UTC"
teams step "Drafting the post-mortem" --detail "Writing root cause + remediation"
```

- `--detail "<subtitle>"` — a one-line subtitle under the new step, shown while it is in progress.
- `--output "<result>"` — a concrete result attached to the PREVIOUS step as it completes.
- `--source URL|TITLE` — citations on the closing step (repeatable, newline-separated).

### Rules

- Mark phase transitions, not every shell call.
- Set `--detail` / `--output` once per step.
- Keep them short (truncated at 500 chars).
- Don't `teams step` after `teams send` — the card is closed; further steps drop silently.
- Don't go silent for minutes on long work — post a step before anything slow (clone, install, build, tests, deep research) so the conversation always shows fresh progress.
</live-stream>

<final-answer>
### `teams send "<text>"` — deliver the answer

```sh
teams send "Reverted api@a3f1 — the new auth middleware dropped the trace header on retries. Errors are back to baseline."
```

This finalizes the live card: the plan flips to "Task complete", your answer renders below it, and a link back to the Kortix session is appended automatically.

- **One `teams send` per turn.** It closes the card; a second call drops silently.
- The answer is rendered into an Adaptive Card server-side — just send clear text/markdown; you don't build the card.
</final-answer>

<asking-the-user>
**Need to ask the user something? Use `teams send` to post the question, then END your turn.**

Teams questions are async: ask, stop, and resume when they reply — their reply arrives as a fresh turn with full context. Do NOT use the built-in `question` tool on a Teams turn (its synchronous form has no renderer in Teams). Post your question with `teams send`, then end the turn.
</asking-the-user>

<reads>
Reach for these only when the task explicitly asks. They run through the Executor against Microsoft Graph.

```sh
teams team     --team "<team-id>"
teams channels --team "<team-id>"
teams channel  --team "<team-id>" --channel "<channel-id>"
teams members  --team "<team-id>"
teams user     --id "<user-id>"
```

`$MS_TEAMS_TENANT_ID`, `$MS_TEAMS_CONVERSATION_ID`, `$MS_TEAMS_SERVICE_URL`, and `$MS_TEAMS_USER_ID` are pre-injected on Teams turns. Full help: `teams help`.
</reads>

<tone>
Reply like a colleague messaging on Teams:

- **No preamble.** Get to the answer.
- **Standard Markdown.** Teams Adaptive Cards render normal Markdown — `**bold**`, `_italic_`, `` `code` ``, `[label](url)` links. (This is the OPPOSITE of Slack — do not use Slack's `*single-asterisk*` mrkdwn or `<url|label>` links here.)
- **Short.** A few sentences beat a wall of text; bullet lists for ≥3 items.
- **No "Here's a summary:" headers.** This is a chat message, not a report.
</tone>

<gotchas>
- **Standard Markdown, not Slack mrkdwn.** `**bold**` and `[label](url)` — not `*bold*` / `<url|label>`.
- **`teams step` after `teams send` drops silently.** Send the answer last.
- **One `teams send` per turn.**
- **Asking → `teams send` + end the turn.** The `question` tool has no Teams renderer.
- **Don't go quiet on long work.** Post a step before slow operations.
</gotchas>

</skill>
