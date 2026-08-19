# Plan — session bug fixes (follow-up to 27279d2232)

Branch `message-input`. Base commit for this plan: `27279d2232`.

## Global Constraints

- **Do NOT commit, push, branch, stash, or run `git add -A`.** The controller
  commits. Leave your work in the working tree. `git stash` in particular
  silently discards the index — it has already cost this repo an incident.
- **Do not touch files outside your task's file list.** Other agents are
  working in this same checkout on disjoint files at the same time.
- Every behaviour change ships with a test that you have **watched fail**
  before the fix (RED → GREEN). A test you never saw fail proves nothing.
  Say explicitly in your report that you watched it fail, and paste the
  failing output.
- `apps/web` has **no DOM harness**. Component tests use
  `renderToStaticMarkup` from `react-dom/server` (see
  `src/features/session/turn/user-message.test.tsx`). Pure logic goes in a
  plain `.ts` module with a `.test.ts` beside it. Do NOT use `test.each` —
  this repo's `@types/bun` has no `each` and it breaks `tsc`.
- Run and paste real output for: the test file(s) you touched, plus
  `npx tsc --noEmit` filtered to your files, plus `npx eslint <your files>`.
- Known-good baselines: web `bun test src/` = 5915 pass / 6 fail; SDK
  `pnpm --filter @kortix/sdk test` = 1856 pass / 0 fail. The 6 web failures
  are Tasks 1 and 5c below. Do not "fix" a failure by weakening an assertion.
- `packages/sdk` is a **published npm package**. Read `packages/sdk/CLAUDE.md`
  before editing it. Renaming an exported name (including a type) is a
  breaking change; adding is free.

---

## Task 1 — `markdown-code` tests select by a styling class

**Files:** `apps/web/src/components/markdown/code/markdown-code.test.tsx`

Three tests fail. The helper at line ~16 finds the language label by matching
the CSS class that styles it:

```js
html.match(/<span class="[^"]*uppercase[^"]*">([^<]*)<\/span>/)?.[1] ?? '';
```

A design change in `code-block.tsx` (already committed) made that span
`lowercase`, so the regex misses and `labelOf` returns `''`. The component
renders correctly — only the test's selector is stale.

**Do:** make the tests select the label by something that is not a styling
class, so the next visual tweak cannot break them again. A `data-testid` (or
another stable hook) on the label span in
`apps/web/src/components/markdown/code/code-block.tsx` is acceptable and
preferred over matching class names; you may edit that file for this purpose
only. Keep the existing assertions' meaning intact.

**Done when:** `bun test src/components/markdown` is fully green and the
helper no longer references `uppercase`/`lowercase`.

---

## Task 2 — an identical prompt sent twice within 60s is silently dropped

**Files:** `packages/sdk/src/react/use-opencode-sessions/messages.ts`,
`packages/sdk/src/react/use-opencode-sessions/messages.test.ts`, and
`packages/sdk/src/react/use-session.ts` if threading requires it.

The Kortix sandbox proxy dedupes prompt deliveries by
`Idempotency-Key` header, or — when absent — by a **sha256 of the request
body** (`apps/api/src/sandbox-proxy/prompt-dedupe.ts`, 60s TTL). On a repeat
it answers `200 {"status":"duplicate","deduplicated":true}` and never
forwards.

`promptOpenCodeMessage` (messages.ts) builds its payload by mapping parts to
`{type:'text', text}` — **dropping the client-generated part ids** — and only
includes `messageID` when the caller passed one. `use-session.ts`'s
`sendParts` does not pass one. So sending the same text twice within 60s
produces byte-identical bodies and **the second message is silently lost**:
no error, no turn, nothing on screen.

**Do:** give each prompt submission a client-generated `messageID` so two
separate submissions are never byte-identical, while a genuine retry of the
*same* submission keeps its id (so real dedupe still works). The opencode
`session.prompt`/`command` endpoints already accept `messageID`. Prefer
generating it at the call site that represents one user action, not inside the
retry loop. Look at how `session-chat.tsx` already mints ids (`ascendingId`)
before inventing a new scheme — but do NOT import from `apps/web` into the SDK.

**Constraints:** `promptOpenCodeMessage` has an internal boot-window retry
loop — the id must be stable *across* those attempts, or you reintroduce the
duplicate. Do not change any exported name.

**Done when:** a test proves two separate `sendParts`/prompt submissions
produce different `messageID`s, and that the internal retry loop reuses one id
across attempts. `pnpm --filter @kortix/sdk test` and
`pnpm --filter @kortix/sdk typecheck` both green.

---

## Task 3 — a slash command silently discards attached files

**Files:** `apps/web/src/features/session/composer/composer.tsx`,
`apps/web/src/features/session/session-chat.tsx`, and a new/updated pure
module + test under `apps/web/src/features/session/`.

In `composer.tsx`'s `handleSubmit`, the `plan.kind === 'command'` branch
ignores `attachedFiles` entirely, then `clearOnSend` clears them and revokes
their object URLs. Attach a file, use a slash command, and the file is gone
with no warning.

Two acceptable outcomes — pick one and justify it in your report:

1. **Carry the files.** `client.session.command()` accepts a `parts` array of
   file parts (see `packages/sdk/node_modules/@opencode-ai/sdk/dist/v2/gen/sdk.gen.d.ts`,
   `command<...>(parameters: { …, parts?: Array<{type:"file", mime, url, …}> })`).
   This is the better product outcome if it is genuinely wired end to end.
2. **Refuse clearly.** If (1) cannot be done safely within this task, then the
   composer must tell the user *before* sending — disable submit, or surface a
   visible message — and must NOT clear/revoke the files. Silent loss is the
   one unacceptable outcome.

**Done when:** a test covers the chosen behaviour, and no path clears attached
files without either sending or reporting them.

---

## Task 4 — `/command` skips the project env sync

**Files:** `apps/api/src/sandbox-proxy/routes/preview.ts` (+ its tests).

`shouldSyncProjectEnvBeforeProxy(port, method, path)` matches only
`/session/:id/(prompt_async|message)`. `POST /session/:id/command` runs a full
agent turn but skips the pre-prompt env sync, so a command can run against
stale secrets / an unsynced env.

This is now visibly asymmetric: commit `27279d2232` made `/command` count as a
non-idempotent prompt delivery (`isNonIdempotentSessionWrite`) for retry
purposes, but it still gets no env sync.

**Do:** decide whether `/command` should get the env sync, and implement it.
Read the block guarded by `shouldSyncProjectEnvBeforeProxy` carefully first —
it also does agent-lock handling, `bodyWithoutPromptAgent`, session-title
generation from the first prompt, and `remintGrantForAgentSwitch`. A command
body is `{command, arguments, agent, model, variant}`, **not** `{parts}`, so
verify each of those still behaves sensibly for that shape (e.g.
`extractPromptInfo` will find no text — confirm the title generation is
correctly skipped rather than crashing). If any sub-step is wrong for a
command, scope the sync so only the correct parts run.

**Done when:** unit tests cover the predicate for `/command`, and you have
stated in your report exactly which sub-steps now run for a command and why
each is safe.

---

## Task 5 — three small correctness/quality fixes

**Files:** `apps/web/src/lib/delivered-but-disconnected.ts` (+ test),
`apps/web/src/features/session/mention-chip.tsx`,
`apps/web/src/features/session/turn/user-message.tsx`,
`apps/web/src/features/session/composer/attachment-tiles.test.tsx`,
`apps/web/src/features/session/optimistic-turn.test.tsx`.

**5a.** `DELIVERED_BUT_DISCONNECTED` includes `'sandbox port unreachable'`.
That string is the *browser-navigation* response for a dead preview port
(`portUnreachableResponse` with `reason: 'sandbox port unreachable'`), not a
prompt delivery. Treating it as "delivered" could swallow a genuine failure
toast for a mutation against a dead port. Remove it, or narrow it, and cover
the decision with a test.

**5b.** `MentionChip` renders a `<button>`. In `user-message.tsx` those chips
sit inside a bubble that itself becomes `role="button"` + `tabIndex={0}` when
the message is clamped (`canExpand`). Nested interactive controls are invalid
and make the bubble a keyboard trap around the chips. Fix the nesting so the
expand affordance and the chips can both be operated by keyboard. Do not
regress the existing `stopPropagation` behaviour — a chip click must not also
toggle the bubble.

**5c.** `attachment-tiles.test.tsx` and `optimistic-turn.test.tsx` assert
`h-20` and `rounded-md border`, but `attachment-tile.tsx` ships `size-20 w-30`
and `rounded-sm border`. 3 failing tests. The **shipped component is the newer
intent** — the tests were not updated. Update the assertions to match the
component. Do NOT change `attachment-tile.tsx`.

**Done when:** `bun test src/features/session/ src/lib/` is green apart from
failures owned by other tasks.

---

## Task 6 — Undo of a removed queued message drops its command and files

**Files:** `apps/web/src/features/session/session-chat.tsx`,
`apps/web/src/stores/message-queue-store.ts` (+ its test), and/or a new pure
module + test under `apps/web/src/features/session/`.

Found while reviewing Task 3. This is a regression introduced by commit
`27279d2232`, which added a `command` field to queued messages but did not
audit the other `enqueue` call sites.

`handleRemoveQueuedMessage`'s Undo button (around `session-chat.tsx:2270`)
re-enqueues with only `text`, `mentions`, `agent`, `model`, `variant`. It drops
**`command`** and **`files`**. So:

- Remove a queued `/webapp` entry, press Undo → it returns as a plain text
  message, not a command. The slash command is silently lost.
- If that command had no arguments its `text` is `''`, so the restored entry
  dispatches `handleSend('')` — an empty message on the wire.
- Any attachments on a removed entry are dropped by the same omission.

**Do:** make Undo restore the entry faithfully. Note `removed.files` is
`QueuedAttachment[]` (which may contain `{ kind: 'lost' }` placeholders) while
`EnqueueInput.files` is `AttachedFile[]` — either filter the lost ones or widen
`EnqueueInput`, and say which you chose and why.

**Also:** audit every other caller of `enqueue(` in `apps/web` for the same
omission and report what you found, fixing any you find.

**Guard against recurrence:** the root cause is that `EnqueueInput` lets a
caller silently drop fields. Consider a test that fails when a round-trip
(enqueue → remove → undo) loses any field. A test that only checks `command`
will not catch the next field someone adds.

**Done when:** a test proves the round trip preserves the command, the files,
and every other captured field, and you have watched it fail first.
