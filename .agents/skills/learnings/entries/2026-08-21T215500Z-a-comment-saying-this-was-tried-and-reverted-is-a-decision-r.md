---
recorded: 2026-08-21T21:55:00Z
commit: e292cfd979
---
# A comment saying "this was tried and reverted" is a decision record — read it before you overrule it

Found 2026-08-21. PR #6692 "the inbox owns the queue" made the prompt-queue
admission gate HOLD every queued prompt for as long as the session held turn
authority, instead of forwarding it into the running turn. It shipped to dev at
03:10 UTC and was reported broken by the product owner the same day: an agent
working 9m21s sat on two prompts queued 8 minutes earlier, delivering neither.

**The change was made to fix Remove.** Forwarding into a live turn made
`DELETE .../prompts/:id` answer 409 within ~1s of a send, because OpenCode
parents each STEP on the newest user message, so the running turn adopted the
prompt almost immediately. Holding did fix that — and removed the reason the
queue exists: what you type while the agent works being WITH the agent, picked
up the moment the turn ends.

**The codebase had already said so.** `inbox-admission.ts` carried, in its file
header, *"Holding was tried and reverted: the user wants what they typed to be
WITH the agent immediately"*, and the delivery test asserted the same. The PR
noted that line and overruled it, and described the cost as losing *batch
answering* rather than as losing the queue's whole point.

**Rules.**
1. A comment that records a REVERT is prior art with an owner and an outcome.
   Overruling it needs the same evidence the original decision had — ask the
   person, or reproduce the failure it describes. A one-line acknowledgement in
   a commit body is not that.
2. State the cost in the user's terms, not the implementation's. "A batch is no
   longer folded into one model step" and "the queue no longer sends between
   turns" are the same change; only the second one is reviewable.
3. When a fix for control (Remove) costs behaviour (delivery), fix the control
   on its own terms. Here that is `reachedPlacement` calling a prompt "answered"
   as soon as any step parents on it — `cancel-forwarded.ts` can already take an
   unread prompt back out of the runtime.

**Verification that settles it, on deployed dev:** post prompt A (long task),
wait for `GET .../turn` to report a non-empty `turns` array — that array IS
`sessionHoldsTurnAuthority`, the predicate the hold read — then post prompt B and
sample `GET .../prompts`. Held looks like `{state:'waiting',
reason:'turn_active'}` for the whole turn. Correct looks like `delivering` inside
2s and gone from the inbox while `turns` is still non-empty. Measured on
`acce6fbe22`: `delivering` at t+1.8s, gone at t+9.5s, turn still open.

*Incident:* dev only, ~14h from merge to revert. Reverted by PR #6699
(`acce6fbe22`), which restores the six queue files byte-for-byte to the
pre-#6692 tree and keeps only the two changes that touch no queue behaviour —
the non-transitive `compareMessagesForDisplay` fix, and the Remove toast reading
`error.status` instead of regexing `/409/` against `error.message` (that regex
could never match, so a 409 and a 404 rendered the same dead-end string, which is
why Remove looked like it simply never worked).
