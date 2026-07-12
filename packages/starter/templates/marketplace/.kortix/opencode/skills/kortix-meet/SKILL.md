---
name: kortix-meet
description: How to send a notetaker bot into a video meeting (Google Meet / Zoom / Teams) and work with what it captures — join a call, confirm it got admitted, monitor its lifecycle, pull the speaker-attributed transcript, and produce a recap with decisions + action items, then remove it. Drives the `meet` CLI, which runs through the Kortix Executor (the meeting-bot provider key is resolved server-side; nothing in the sandbox). Load this WHENEVER the user asks to join / attend / record / transcribe / take notes on a meeting, "send a notetaker", "summarize that call", drops a Meet/Zoom/Teams link, or asks how to do anything with a meeting bot.
---

<skill name="meet">

<overview>
You can send a notetaker bot into a live video meeting. It joins as a **visible, named participant** ("Kortix Notetaker" by default), records the call, and transcribes it with **speaker attribution**. You drive the whole thing with the `meet` CLI, which is already on `$PATH`.

Three things to internalize before you touch a command:

1. **It runs through the Kortix Executor.** Every `meet` call goes to the gateway, which resolves the meeting-bot provider's API key **server-side** and makes the real call. There is **no key in your sandbox**, nothing to configure, and no `$RECALL_*`/`$MEET_*` env var to hunt for. Do **not** reach for an MCP server, a raw `curl`, or an HTTP workaround — the `meet` CLI is the complete, supported interface. If you find yourself looking for an API key, stop: you're on the wrong path.

2. **It is bot-id-centric.** `meet join <url>` returns a **`bot_id`**. *Every* subsequent command — `status`, `transcript`, `leave` — takes that `bot_id` as its argument. The `bot_id` is the **only handle** to the meeting. **Save it the instant you get it** (see "Persisting the bot_id across turns") — without it you cannot check status, fetch the transcript, or remove the bot.

3. **A meeting outlives a single turn.** Calls run for minutes to hours. You do **not** sit in a loop blocking your turn for the whole meeting. The work naturally spreads across turns: join now, confirm it's in, then come back later — when the call ends or the user asks — to pull the transcript and write the recap.

Every command prints **JSON to stdout**. Parse it; don't eyeball it.
</overview>

<the-lifecycle>
A meeting bot moves through a fixed lifecycle. Knowing it tells you what to do at each point.

```
meet join ─▶ joining_call ─▶ in_waiting_room ─▶ in_call_not_recording ─▶ in_call_recording ─▶ call_ended ─▶ done
                                  │                                              │
                          (host must admit)                          (capturing audio + captions)
```

Your job maps onto it:

1. **Join** (`meet join <url>`) → capture `bot_id`, tell the user it's on the way + **they may need to admit it**.
2. **Confirm** (`meet status <bot_id>`) → last code `in_call_recording` means success. `in_waiting_room` means it's stuck waiting for the host to let it in.
3. **Recap** (`meet transcript <bot_id>`, when the call ends or on request) → turn segments into a TL;DR + decisions + action items.
4. **Leave** (`meet leave <bot_id>`) → remove it when done; it bills per minute (it also auto-leaves when everyone else does).
</the-lifecycle>

<commands>
### `meet join <meeting-url>` — send the bot in

```sh
meet join "https://meet.google.com/abc-defg-hij"
```

Pass the **full meeting URL** — Google Meet, Zoom, or Teams. The platform is detected from the URL; you don't specify it. Transcription (via the meeting platform's own live captions) is **enabled by default**, so `meet transcript` will work later with no extra setup.

By default the bot joins under the **name the project set** (Customize → Meetings → Bot name; default "Kortix Notetaker") — you don't need to pass it. People also **address it by that name** in the call (the wake word is its first name).

Options:
- `--bot-name "Acme Notetaker"` — override the display name for this one call. Keep it honest and recording-disclosing; this is what participants see in the roster, and the first word becomes the wake word.
- `--recording-config '<json>'` — advanced override of the recording/transcription config (rarely needed; the default already enables captions-based transcription). Example to use a higher-quality async provider instead of live captions: `--recording-config '{"transcript":{"provider":{"assembly_ai_streaming":{}}}}'`.

**Output** (abridged):
```json
{
  "ok": true,
  "bot_id": "89532474-1e78-4c4e-b6bb-534d6534b2b2",
  "bot": {
    "id": "89532474-1e78-4c4e-b6bb-534d6534b2b2",
    "meeting_url": { "meeting_id": "abc-defg-hij", "platform": "google_meet" },
    "bot_name": "Kortix Notetaker",
    "status_changes": [],
    "recordings": []
  }
}
```
→ **Save `bot_id` (`89532474-…`).** Then tell the user the bot is joining and to **admit it from the waiting room** if prompted.

### `meet status <bot_id>` — where is the bot

```sh
meet status "89532474-1e78-4c4e-b6bb-534d6534b2b2"
```

Returns the bot object, including the ordered `status_changes` list. **Read the LAST entry's `code`.**

**Output** (abridged):
```json
{
  "ok": true,
  "id": "89532474-1e78-4c4e-b6bb-534d6534b2b2",
  "status_changes": [
    { "code": "joining_call",          "created_at": "2026-06-28T16:00:59Z" },
    { "code": "in_waiting_room",       "created_at": "2026-06-28T16:01:03Z" },
    { "code": "in_call_not_recording", "created_at": "2026-06-28T16:01:09Z" },
    { "code": "in_call_recording",     "created_at": "2026-06-28T16:01:10Z" }
  ],
  "recordings": [ { "id": "…", "status": { "code": "recording" } } ]
}
```
Last code `in_call_recording` → **it's in and capturing.** See "Status codes" below for what each one means and what to do.

### `meet transcript <bot_id>` — speaker-attributed transcript

```sh
meet transcript "89532474-1e78-4c4e-b6bb-534d6534b2b2"
```

**Two possible outputs.**

Not ready yet (normal early in a call, or before anyone has spoken):
```json
{ "ok": true, "bot_id": "89532474-…", "status": "processing",
  "note": "Transcript not ready yet (still processing or no speech captured). Try again shortly." }
```

Ready:
```json
{
  "ok": true,
  "bot_id": "89532474-…",
  "segments": [
    { "participant": { "id": 1, "name": "Priya Shah" },
      "words": [ { "text": "Okay" }, { "text": "let's" }, { "text": "ship" }, { "text": "the" }, { "text": "migration" }, { "text": "first." } ] },
    { "participant": { "id": 2, "name": "Marco Diaz" },
      "words": [ { "text": "Agreed," }, { "text": "I'll" }, { "text": "own" }, { "text": "the" }, { "text": "rollback" }, { "text": "plan." } ] }
  ]
}
```
The transcript is an array of **segments**; each has a `participant` (with `name` — the speaker) and `words` (an array of `{ text }`). To get a readable line per speaker, **join the `words` of a segment with spaces** (see "Reading the transcript").

### `meet chat <bot_id> "<message>"` — talk back in the meeting

```sh
meet chat "89532474-1e78-4c4e-b6bb-534d6534b2b2" "On it — sharing the migration doc now."
```
Posts a message to the **meeting chat** as the bot, so the agent can *participate* — answer a question, drop a link, confirm an action. Keep it short; it's a live call. Returns `{ "ok": true, "bot_id": "…", "sent": "…" }`.

### `meet speak <bot_id> "<message>"` — say it out loud (voice)

```sh
meet speak "89532474-1e78-4c4e-b6bb-534d6534b2b2" "Sure — Q3 revenue is up twelve percent."
```
Speaks the message **aloud in the call** using the project's selected voice (ElevenLabs TTS, generated server-side). Optional `--voice <id>` overrides the voice for one line. Keep spoken replies short and conversational — plain spoken language, no markdown or URLs (those go in `meet chat`).

### `meet leave <bot_id>` — remove the bot

```sh
meet leave "89532474-1e78-4c4e-b6bb-534d6534b2b2"
```
Removes the bot from the call. **This is irreversible.** Do it when the user says they're done, or right after you've pulled the final transcript — it stops the recording from billing per minute.

Full help: `meet help`.
</commands>

<live-mode>
While the bot is in a call, the meeting streams to you in **real time** — you can attend *live*, not just recap afterward.

**The posture is listen-by-default.** You are **not** pinged on every sentence (that would be noise). You're woken **only when someone addresses the bot by name** — i.e. an utterance or chat message that contains the **wake word, which is the bot's first name** (the project's bot name, "Kortix" by default). A few things the relay handles for you so it feels like a real conversation:
- It **waits for the speaker to finish** (it coalesces a paused, multi-part sentence into one turn) before waking you — so you get the whole question, not a fragment.
- It plays an **instant spoken acknowledgement** ("one sec…") the moment you're addressed, so there's no dead air while you think. **Don't** open your reply with filler — just answer.
- For a short window after a reply, the same person can **keep talking to you without repeating your name** — stay engaged in the back-and-forth.

When woken, this session receives a prompt like:

```
[Live meeting] Priya Shah said: "Hey Kortix, can you drop the migration doc in the chat?"

You're attending this meeting live (bot id 89532474-…) and were just addressed.
If a reply is warranted, post it to the meeting chat — keep it brief, you're speaking in a live call:
  meet chat 89532474-… "<your reply>"
If no reply is needed, do nothing.
```

How to handle a live wake — **match the channel they used** (the wake prompt tells you which it was):
- **They SPOKE to you** → you **MUST** reply **out loud** with `meet speak <bot_id> "…"`. This is non-negotiable for a spoken turn — **never** answer a spoken question by typing in the chat, no matter how the answer is shaped (even a few points are spoken aloud as a sentence).
- **They TYPED in the meeting chat** → reply in the chat with `meet chat <bot_id> "…"`.
- **The only time chat enters a spoken turn:** the answer contains something genuinely un-speakable — a URL, a code snippet, a file. Then **still speak your answer**, and *additionally* `meet chat` the link/snippet. Speaking is never skipped; chat is only an add-on here.
- **Be brief and useful.** One or two sentences — you're interjecting in a live conversation, not writing a report. Spoken replies especially must be short, plain spoken language — no markdown, no URLs read aloud.
- **It's fine to do nothing.** If the mention wasn't really a request to you (someone just said the word "Kortix" in passing), don't reply.
- **You can act first, then answer.** If they ask for something ("share the Q3 numbers"), do the work, then `meet chat` the result or a link.

The full end-of-meeting recap still comes from `meet transcript <bot_id>` — live mode is for *in-the-moment* interaction, not for capturing the whole call.
</live-mode>

<speaking>
You can talk back **out loud** in the call, not just type. `meet speak <bot_id> "<text>"` runs the text through text-to-speech (server-side) and plays it in the meeting in the **voice the project chose** (set under Customize → Meetings; defaults to a neutral voice). This is what makes it feel like a person on the call rather than a bot dropping chat lines.

**When to speak vs. type** — the relay tells you which channel they used; match it:
- Someone **spoke** to you → **`meet speak`** (answer aloud). The default for any spoken question.
- Someone **typed** in the chat → **`meet chat`** (answer in the chat).
- A spoken turn is **always** answered by voice. If part of the answer is genuinely un-speakable (a link, a file, a code snippet), **speak the answer anyway** and *additionally* drop the un-speakable bit in chat — e.g. `meet speak <id> "Here's the summary — I've put the doc link in the chat."` then `meet chat <id> "<link>"`. A list of points is **not** un-speakable: say it aloud as a sentence.

**Write for the ear, not the eye.** A spoken reply is heard once, live:
- **Short.** One or two sentences. Long monologues are painful to sit through on a call.
- **Plain spoken language** — contractions, natural phrasing. No markdown, asterisks, bullets, headings, or emoji; they get read out as gibberish or dropped.
- **Never read out URLs, paths, IDs, or code** — nobody can act on a spoken link. Put those in `meet chat`.
- **Say it the way a person would:** "twelve percent" not "12%", "the second quarter" not "Q2", "October third" not "10/3". Expand symbols and abbreviations.
- **Lead with the answer — no filler.** The relay already played an instant acknowledgement before it woke you, so don't open with "Sure, let me check…". Just answer.

**Voice:** the project default is applied automatically — you don't choose it per call. To deviate for one line, pass `--voice <id>` (e.g. `meet speak <id> --voice george "Welcome, everyone."`); the available ids are the voices listed in Customize → Meetings.

**Latency:** generating + playing speech takes a couple of seconds — that's expected, and the acknowledgement covers the gap. Don't fire a second `meet speak` because the first seems slow, or the bot will talk over itself.

```sh
# they asked out loud: "Kortix, where did we land on the launch date?"
meet speak "89532474-…" "We landed on October third, pending one last design review."
```
</speaking>

<status-codes>
The `code` of the **last** `status_changes` entry tells you the state. What each means and what to do:

| Code | Meaning | What you do |
| --- | --- | --- |
| `joining_call` | Bot is dialing in. | Wait a few seconds, re-check. |
| `in_waiting_room` | **Bot is in the lobby — the host must admit it.** It cannot record yet. | **Tell the user to admit "Kortix Notetaker."** Re-check after they do. |
| `in_call_not_recording` | Admitted, briefly before recording starts. | Transient — it flips to `in_call_recording` in ~1s. |
| `in_call_recording` | **In the call and capturing audio + captions.** | Success. Stop polling; come back for the transcript when the call ends. |
| `call_ended` / `done` | Meeting is over (host ended / everyone left / bot left). | Pull the transcript now — it's the most complete it'll be. |
| `recording_permission_denied` | The meeting blocked recording. | Tell the user; no transcript will come. |
| `fatal` / `bot_failed` | The bot couldn't join (rejected, bad link, error). | Report the failure honestly; offer to retry with a fresh `meet join`. |

If the bot sits in `in_waiting_room` and is never admitted, it times out and leaves on its own (no transcript). That's a user action you can't perform — surface it clearly.
</status-codes>

<reading-the-transcript>
`meet transcript` gives you `segments`. Each segment is one continuous bit of speech by one person:
- `segment.participant.name` — **who** spoke (may be `null`/absent if the platform didn't expose a name; fall back to "Speaker N" or "Unknown").
- `segment.words` — an array of `{ text }`; the spoken text, tokenized. **Join with spaces** to reconstruct the sentence.

A quick way to render the whole transcript readably:
```sh
meet transcript "$BOT_ID" | python3 -c "
import sys, json
d = json.load(sys.stdin)
segs = d.get('segments')
if not segs:
    print('(', d.get('note') or 'no transcript', ')'); raise SystemExit
for s in segs:
    who = (s.get('participant') or {}).get('name') or 'Unknown'
    text = ' '.join(w.get('text','') for w in (s.get('words') or [])).strip()
    if text:
        print(f'{who}: {text}')
"
```
That yields lines like:
```
Priya Shah: Okay let's ship the migration first.
Marco Diaz: Agreed, I'll own the rollback plan.
```
Use that readable form to **summarize** — never dump the raw `segments` JSON at the user.
</reading-the-transcript>

<a-worked-example>
End-to-end: "Send a notetaker to my standup and summarize it after."

```sh
# 1) Join — capture the bot_id and stash it where a later turn can read it.
RESULT=$(meet join "https://meet.google.com/abc-defg-hij" --bot-name "Kortix Notetaker")
BOT_ID=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['bot_id'])")
echo "$BOT_ID" > /workspace/.meet-bot-id           # persist across turns
```
Tell the user: *"On it — Kortix Notetaker is joining your standup. If it lands in the waiting room, admit it."*

```sh
# 2) Confirm it got in (a check or two — not a tight loop).
meet status "$BOT_ID"   # → last code in_waiting_room?  ask them to admit.
meet status "$BOT_ID"   # → last code in_call_recording? it's capturing. Done for now.
```

…the meeting runs; this turn ends. **Later** (the user says "summarize it" or the call has ended):

```sh
# 3) Recap.
BOT_ID=$(cat /workspace/.meet-bot-id)
meet status "$BOT_ID"        # confirm call_ended / done for a complete transcript
meet transcript "$BOT_ID"    # → segments; render + summarize (see Reading the transcript)

# 4) Clean up.
meet leave "$BOT_ID"         # stop the recording clock (skip if it already auto-left)
```
Then deliver the recap (TL;DR + decisions + action items) to wherever the request came from.
</a-worked-example>

<persisting-the-bot-id>
Because the meeting spans turns, the `bot_id` **must survive** beyond the turn that joined. Options, best first:
- **Write it to a file** in the workspace: `echo "$BOT_ID" > /workspace/.meet-bot-id` — simple and durable; read it back in a later turn.
- **State it in your reply** so it's in the conversation history (e.g. "Joined — bot id `89532474-…`"). A later turn can recover it from context.
- If you're juggling **several meetings**, key them: `/workspace/.meet/<meeting-name>.bot-id`.

Losing the `bot_id` means you can't fetch the transcript or remove the bot — treat it as precious.
</persisting-the-bot-id>

<platforms>
Works across the major platforms — pass the **full URL**; the platform is detected from it. Don't pre-parse the link or extract a meeting code yourself.

- **Google Meet** — `https://meet.google.com/abc-defg-hij`
- **Zoom** — `https://zoom.us/j/1234567890?pwd=…` (include the `pwd` if the link has one)
- **Microsoft Teams** — the full `https://teams.microsoft.com/l/meetup-join/…` URL

Google Meet is the most battle-tested; Teams and Zoom work but may have platform-specific quirks (waiting-room behavior, recording-consent prompts). If a join fails on a non-Meet platform, report what `status` says rather than guessing.
</platforms>

<consent-and-disclosure>
A bot recording people is a governance matter, not a detail. Hold the line on it:

- **Disclosed, never stealthy.** The bot joins as a **visible, named participant** and everyone in the call can see it. That is by design. Never rename it to impersonate a person, never try to make it hidden or silent, and never describe it to the user as "undetectable."
- **Standing to record.** Only join meetings the user actually has standing to be in / record — their own calls, ones they host, or ones they're invited to. If you're asked to join a meeting the user doesn't appear to be part of, **surface that** instead of silently doing it.
- **Two-party consent.** Many jurisdictions require everyone to know they're being recorded. For calls with external or unknown participants, it's reasonable to note that attendees should be aware a notetaker is recording. When in doubt, err toward disclosure.
</consent-and-disclosure>

<recap-format>
**The recap is auto-triggered.** When the meeting ends (the bot leaves / everyone leaves), the platform automatically wakes this session with a "the meeting just ended — produce the meeting notes" prompt. You don't need to be asked: pull the transcript with `meet transcript <bot_id>` (retry if it's still `processing`) and produce the recap below. (You can also produce it on demand mid-call if someone asks for a summary.)

When you summarize from a transcript, **do not** paste the raw transcript. Produce a tight, skimmable recap. Structure:

- **TL;DR** — 1–2 sentences: what the meeting was about and the outcome.
- **Decisions** — bullets of what was actually decided, attributed where it matters.
- **Action items** — a checklist of `owner → task (due, if mentioned)`. Usually the highest-value part; extract it carefully and don't miss owners.
- **Open questions** — anything left unresolved or needing follow-up.

A good recap looks like:
> **TL;DR** — Sprint planning; team agreed to ship the DB migration before the billing rework.
>
> **Decisions**
> - Migration goes first (Priya); billing v2 slips to next sprint.
> - Rollback plan required before the migration merges.
>
> **Action items**
> - [ ] **Priya** → finalize the migration PR — by Thu
> - [ ] **Marco** → write the rollback runbook — before merge
> - [ ] **Sam** → spike metered-billing schema (timeboxed, 1 day)
>
> **Open questions**
> - Do we need a staging dry-run of the migration first? (unresolved)

Keep speaker attribution where it adds signal, drop it where it's noise. If the transcript is **empty or sparse** (no one spoke, or captions didn't capture), **say so plainly** — never invent meeting content to fill a recap.
</recap-format>

<billing-and-cleanup>
A live bot **costs money per minute** it's in a call (recording + transcription). So:
- **Leave when done.** Once you've pulled what you need, `meet leave <bot_id>`. Don't leave a bot parked in an ended or empty meeting.
- It **auto-leaves** when everyone else has left the call, so you won't always need to leave it manually — but don't rely on that if the user explicitly ends the task.
- Don't spin up **duplicate bots** for the same meeting (each `meet join` is a new billable bot). If you already have a `bot_id` for a meeting, reuse it.
</billing-and-cleanup>

<error-handling>
When a `meet` command comes back not-ok, read the error and act — don't retry blindly or fall back to a raw API.

- **`connector_not_found` / "meet channel isn't enabled"** — the meeting bot isn't turned on for this project. Tell the user to enable **Meetings** in the project's experimental settings; stop (don't improvise another path).
- **`needs_auth`** — the provider key isn't configured server-side (an operator setup gap). Report it; you can't fix it from the sandbox.
- **A join that lands and immediately fails / `bot_failed`** — bad or expired link, or the platform rejected the bot. Re-check the URL with the user and offer a fresh `meet join`.
- **Transcript keeps saying `processing`** — that's not an error: captions need speech + a little processing lag. Pull it again after the call ends. If it's *still* empty after the call is `done`, the call likely had no captured speech — say so.
- **Admission never happens** — you can't admit the bot yourself; it's the host's click. State clearly that the user (or host) must admit "Kortix Notetaker."
</error-handling>

<gotchas>
- **Save the `bot_id` from `join` — immediately and durably.** It's the only handle to the meeting and you need it across turns. Lose it and you can't transcribe or leave.
- **The bot waits in the lobby.** Most meetings drop it into a waiting room; it can't record until the **host admits it**. `in_waiting_room` is the user's action to resolve, not yours.
- **Transcript lags and needs speech.** `processing` / empty early on is normal — text only appears after people talk and processing catches up. Pull it **after the call ends** for a complete one; never conclude "transcription is broken" from an early read.
- **Leave when done — it bills per minute.** A bot in an empty/ended call keeps a recording open. `meet leave <bot_id>` when finished.
- **Don't block a whole turn polling.** Confirm the join, then return for the transcript later. A meeting can run an hour; your turn can't.
- **One bot per meeting.** Each `meet join` is a new billable bot — reuse an existing `bot_id`, don't re-join.
- **It's a real, disclosed participant.** People see "Kortix Notetaker" in the roster. Never hidden, never impersonating — and only in calls the user can rightfully record.
- **The CLI is the whole interface.** No API key in the sandbox, no MCP, no raw HTTP. If `meet` can't do it, it's not part of the supported surface.
</gotchas>

</skill>
