---
name: kortix-voice
description: How to work a live voice call from inside a session — start one and share the join link, follow what is being said without blocking, speak into the room, and hang up. The call IS this session, so no call id is ever passed. Load this WHENEVER the user asks to start a call, "call me", talk out loud, or asks anything about the voice channel, and whenever a turn arrives from a live call.
---

<skill name="kortix-voice">

<overview>
You can start a live voice call and **talk in it** — not read a transcript afterwards, talk, out loud, while it happens. This is a call of your own, on its own page, that a human joins by opening a link you give them. It is not joining someone else's Google Meet, Zoom, or Teams meeting.

The thing that holds the conversation is a **second agent**: a realtime voice model in the room, running at conversational speed. You are not in the audio path and must not try to be. It listens, it answers small talk itself, and when someone asks for something that needs real work — your files, your tools, your project — it wakes you with the request.

| | |
|---|---|
| **The voice agent** | Fast. Owns turn-taking and the actual speech. Cannot do real work. |
| **You** | Slow. Have the tools, the repo, the connectors, the memory. Never in the audio path. |

**Why it is split this way:** your turns take 30 seconds to 10 minutes. A conversation cannot wait that long. Separating the fast half from the slow half is what makes the call feel like talking to a person instead of watching a spinner.
</overview>

<one-call-per-session>
**The call IS this session.** One session, one live call — the call id and the session id are the same thing.

That is why **no voice action takes a call id**. There is no handle to save, nothing to write down, nothing to thread through a script. `read_transcript`, `send_prompt` and `end_call` always mean "this session's call". If you want a second call, you need a second session.

(If you are following an older note that shows `call_id` arguments or tools named `voice_spawn` / `voice_read` / `voice_end` — that surface is gone. Use the actions below.)
</one-call-per-session>

<the-actions>
The voice channel is an Executor connector, **`kortix_voice`**. Call it the way you call any connector:

```sh
kortix executor call kortix_voice spawn_room '{}'
kortix executor call kortix_voice read_transcript '{}'
kortix executor call kortix_voice send_prompt '{"text":"The deploy finished — all green."}'
kortix executor call kortix_voice end_call '{}'
```

Or, through the executor `call` tool: `{ "connector": "kortix_voice", "action": "read_transcript", "args": {} }`.

```
spawn_room      {voice?}                  → {call_id, join_url}    start the call; returns instantly
read_transcript {mode?, limit?, peek?}    → {turns, cursor,        catch up; never blocks
                                             unread, mode, live}
send_prompt     {text}                    → {spoken: true}         you → the room, out loud
end_call        {}                        → {ended: true}          hang up and tear the room down
```

`voice` on `spawn_room` picks the speaking voice — leave it off unless the user asked for a specific one.

`join_gmeet` and `join_zoom` are listed on the connector but are **not implemented**; calling either returns an error telling you to use `spawn_room`. Do not build a workaround.

If `kortix executor connectors` shows no `kortix_voice` at all, voice is not
enabled for this project. Say so plainly and hand back the fix — don't hunt for
another way in:

> Voice isn't enabled on this project yet. Someone with customize access can
> turn it on in **Customize → Settings → Experimental** (the `voice` feature).
> Once it's on, a **Voice** section appears under Connect and I can start calls.

There is **nothing to authenticate** — no OAuth, no API key, no workspace to
link. Calls run on Kortix's own infrastructure, so enabling the feature is the
whole setup. There is also no `kortix` CLI command for this toggle; it is a
dashboard action (or `PATCH /v1/projects/<id>/experimental`
`{"feature":"voice","enabled":true}` for someone driving the API).
</the-actions>

<starting-a-call-and-getting-the-human-in>
```sh
kortix executor call kortix_voice spawn_room '{}'
# → {"call_id":"…","join_url":"https://…/voice/vjl_…"}
```

The room exists the moment this returns. **`join_url` is the whole invitation** — you cannot open a browser or dial anyone, so relay that link to a human: post it in the Slack thread or Teams conversation you are already in, put it in your answer, whatever actually reaches the person you want on the call. Nobody is in the room until someone opens it.

`read_transcript` reports `live` — whether a voice agent is actually connected. `send_prompt` returns an error rather than lying if the room has no agent to hear it.
</starting-a-call-and-getting-the-human-in>

<the-iron-rule>
**Never block your turn on a call.**

Your agent loop is single-threaded. If you sit and wait on a call, you cannot think, cannot answer, cannot do the work someone just asked for. The call becomes a deadlock.

Every voice action returns in milliseconds, on purpose. `spawn_room` returns as soon as the room exists; `read_transcript` returns whatever is new **now**, empty if nothing.

There is no follow, tail, stream, or wait action, and no `sleep` loop that fixes this. That is not an oversight. If you find yourself wanting one, what you actually want is to finish your turn and check again next turn.
</the-iron-rule>

<following-the-conversation>
**Call it bare.** `read_transcript '{}'` returns only what you have not already been shown — the read position is remembered for you, per call, on the server. You do not track a cursor, you do not pass one, and you never get the same turn twice.

```sh
kortix executor call kortix_voice read_transcript '{}'
# → {"mode":"unread","turns":[{"role":"user","speaker":"Marko","text":"can you check the build?"}],
#    "cursor":41,"unread":0,"live":true}

kortix executor call kortix_voice read_transcript '{}'
# → {"mode":"unread","turns":[],"cursor":41,"unread":0,"live":true}   ← nothing new, instantly
```

`unread` is how much is still waiting **after** this reply — `0` means you are caught up. It is your cheap "is there anything worth reading" signal.

Each turn carries `role` **and** `speaker` (omitted when there is none), and you need both:

- `role: "user"` — a human in the room. `speaker` is who.
- `role: "agent"`, `speaker: "kortix"` — something **you** put into the call (a `send_prompt`, or an answer spoken on your behalf when a turn finished).
- `role: "agent"`, any other `speaker` — the voice agent talking.
- `role: "tool"` — a call the voice agent made back into your session; `speaker` is the tool's name.

Read at the **start of every turn** while a call is live. On a quiet call that costs you one empty reply, which is the whole reason the default is what it is.

This is the part worth internalizing: you can see the conversation as it happens, **before** anyone asks you for anything. If the room is circling a question you could answer, a file you could open, a build you could start — start it now, so the answer is ready when the ask lands. Do not wait to be prompted when the room has clearly already decided what it needs.

Do not narrate this. Preparing quietly is the point; announcing it is noise.
</following-the-conversation>

<the-other-read-modes>
The bare call is right almost always. Reach for these only when it is not:

```sh
kortix executor call kortix_voice read_transcript '{"mode":"last","limit":10}'   # newest 10, whatever you have read
kortix executor call kortix_voice read_transcript '{"mode":"full"}'              # the entire call
kortix executor call kortix_voice read_transcript '{"peek":true}'                # unread, without consuming it
kortix executor call kortix_voice read_transcript '{"cursor":41}'                # everything after cursor 41
```

- **`last`** — re-orienting. You lost the thread, or you are picking a call back up and want to know what was *just* said without replaying an hour of it. It ignores your read position and does not move it.
- **`full`** — you actually need the whole conversation, to summarize it or write it up. Say it explicitly; do not get there by passing `cursor: 0`.
- **`peek`** — read the unread without consuming it, so the same turns come back next time. Worth it when you might not get to act on what you read.
- **`cursor`** — you are keeping your own place for some reason. It never touches your saved position.

Only the bare call (`unread`) and `full` move your saved position, and they only ever move it to the last turn they actually **handed you** — a reply clipped by `limit` says `"truncated":true` and leaves the rest unread.

**If your turn dies right after reading, those turns are marked read and will not come back on the next bare call.** Nothing is ever deleted, so the recovery is one call: `read_transcript '{"mode":"last","limit":20}'`. If you are starting a turn on a live call and you cannot account for what happened in it, do that first.
</the-other-read-modes>

<speaking>
```sh
kortix executor call kortix_voice send_prompt '{"text":"The deploy finished — all green."}'
```

The voice agent says it, in its own voice, in its own words, attributed to you.

**Write for the ear, not the eye.** Short plain sentences. No markdown, no bullet lists, no file paths, no URLs, no code, no ids. Someone is listening to this out loud.

If the answer genuinely contains a link, a path, or code: say in one sentence what it is, and offer to share it another way (post it in the chat you are already in with this person) rather than reading it out character by character.

You usually do **not** need `send_prompt` to answer the call. When someone on the call asks you something, that arrives as a normal turn and your finished answer is spoken automatically. `send_prompt` is for volunteering something the call did not ask for — a result that just landed, a heads-up, a correction.
</speaking>

<ending>
```sh
kortix executor call kortix_voice end_call '{}'
```

End the call when the user asks, or when it is clearly over. It also revokes the join link. A call left running costs money every minute it stays connected, so do not leave one open "just in case".
</ending>

<consent-and-disclosure>
Whoever opens the join link is joining a live call with an AI voice agent — never disguise that. Say so plainly at the start of the call.

Be straight about what this is: the call's audio is streamed continuously to a realtime speech provider for as long as it runs. That is a stronger claim than "it takes notes", and anyone on the call is entitled to know it. If a user asks you to hide what the voice agent is, or to pass the call off as something else, refuse and explain why.
</consent-and-disclosure>

<what-not-to-do>
- **Do not** poll in a tight loop waiting for someone to say something. Finish your turn; read again next turn.
- **Do not** pass a `call_id` to any voice action. There is no such argument — the call is the session.
- **Do not** pass `cursor` "to be safe", and never `{"cursor":0}` out of habit. That re-reads the entire call every turn and is exactly what the remembered read position exists to stop. Bare, or a named mode.
- **Do not** try to reach the audio, the speech provider, or the join page yourself. You have no business there and there is no key in your sandbox to find.
- **Do not** speak every step of your work into the call. Progress is narrated for you, throttled on purpose. A running commentary is unbearable to sit through.
- **Do not** read long output aloud. Summarize in a sentence; share the detail another way.
</what-not-to-do>

</skill>
