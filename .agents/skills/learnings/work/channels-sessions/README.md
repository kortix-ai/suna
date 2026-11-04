---
title: Channels v2 — a conversation with agents, sessions stay first-class
status: plan, awaiting decisions (branch `channels-sessions`, worktree ../suna-channels-sessions)
owner: Jay (build), Marko (product decisions D1–D4)
updated: 2026-11-04
---

# Channels v2

## 1. The problem

Channels (flag `project_channels`, PR #10893) moved session UI into a
channel frame. It did not change how a person talks to agents. Review on
2026-10-26 named the defects. A code survey of `dev` at `e275c0595b`
confirms each one:

| # | Problem | Evidence |
|---|---|---|
| P1 | A channel shows execution, not conversation. One message = one session, and the side panel mounts the full transcript with tool blocks. No agent ever posts back into the channel. | `space-view.tsx:821-916`, `transcript.tsx:2486-2560`; no publish path in `apps/api/src/projects/lib/project-spaces.ts` |
| P2 | The flag removes the session list and "New session". People lose their primary navigation. | `project-sidebar.tsx:288, 320-325`, `project-shell.tsx:211-220` |
| P3 | Three models for one idea ("a topic"): Channels (DB `project_spaces`), Spaces (`kortix.yaml` `spaces:`), Rooms (`rooms` tables, flag `agent_rooms`). Channels and Spaces share one flag and nothing joins them. | `space-scope.ts:20`, `space-room.tsx:13-39`, `rooms/service.ts:1-20` |
| P4 | Seven channel tabs copy project pages: Files→`/drive`, Memory→`/memory`, Apps→`/apps`, Triggers→Customize, Threads→`/sessions`. | `space-timeline.ts:198-200`, `space-view.tsx:442` |
| P5 | A new term: "thread" appears 80 times in `packages/ui/src/i18n/en.ts`. The product word is "session". | `en.ts:8717+` |
| P6 | Two composers on screen at `xl`. No "Open session". Browser and Terminal only as a modal. | `space-view.tsx:320-378, 693`, `panel-fallback.tsx:4-15` |
| P7 | Turning the flag on files every session into `#general`. Sessions from Slack, Teams, Discord, Telegram and email always land in `#general`. | `project-spaces.ts:135, 597`, `session-create.ts:1868-1869` |
| P8 | Backend cost and debt: `reply_count` decompresses every message of every listed session; `KORTIX_SPACE_*` env vars have no consumer; dead memory branch in `SpaceFolderView`; spec drift on the Company layer. | `session-reply-counts.ts:14-18`, `session-channel-env.ts:39-45` |

**Root cause of P1.** The channel agent runs in the same mode as a session
agent: it does all work in its own transcript. A chat feels like a chat
when one front agent talks to you, hands the heavy work to other sessions,
and returns only answers. My Kortix already works this way on `dev`
(#11240): `agent` hand-offs run in the background at depth 0, a finished
child reports once into its parent (`subagent-notice.ts`), and #11581
renders child sessions as compact agent rows. Channels does not use any of it.

## 2. Target model

1. **Two interfaces.** *Talk to an agent* (a DM) and *talk in a channel*
   (a topic with an audience: purpose, members, memory, pinned resources).
   Both use one conversation component.
2. **Session stays the unit of work.** A top-level message starts one root
   session (the *front session*). A reply continues it. Every session keeps
   its URL, its full page, its transcript, Browser and Terminal. The word in
   the product is "session", never "thread".
3. **The front agent coordinates.** A channel's agent (`project_spaces.agents[0]`)
   runs in coordinator mode: it answers short questions directly, and it
   hands work longer than one step to a background child session (`agent`
   tool, `run_in_background`, child inherits `space_id`). It reports the
   child's result in plain language when the notice arrives.
4. **The feed shows answers.** A feed row = the person's message, the front
   session's answer text, and one agent row per child session (state,
   progress, "Open session"). Tool calls and reasoning live only on the
   session page. Data comes from the session list item
   (`board_state`, `result_excerpt`, children), not from a mounted transcript.
5. **Channels are optional organization.** The session list stays. A
   session belongs to zero or one channel. Moving a session to a channel is
   an explicit action and does not change who can open it.
6. **Context carries across sessions through the channel.** The first turn
   of a front session receives a bounded channel brief: purpose, memory index
   (exists today, `memory/turn-context.ts:157`) and the last 10 root sessions
   in the channel (title + `result_excerpt`), capped at 4k characters.

## 3. Remove, keep, add

**Remove**
- "Thread" in every string, route param label and doc. `?thread=` stays as a read alias of `?session=`.
- The sidebar swap. Restore `ProjectSessionList` and "New session"; Channels and DMs become a section above it.
- Tabs Files, Memory, Apps, Links, Triggers. Their content moves into channel Details (Memory, Pinned links, "Open folder in Drive"). Triggers keep the "Post to" field in the trigger form only.
- The second composer. One composer; "Reply" retargets it ("Replying in <session title> · Cancel").
- The side panel that mounts `SessionThread`. "Open session" goes to the full session page with a "Back to #channel" link.
- Auto-filing on flag-on (`assignUnassignedSessions`). Unfiled sessions stay unfiled. Existing assignments stay.
- `ChannelsIntro` modal and `ChannelSetup` checklist. An empty channel shows one empty state with a prompt.
- Dead code: `KORTIX_SPACE_*` (or give it a consumer in the channel brief), `SpaceFolderView` memory branch, `SpaceFolder.tab: 'memory'`, generic disabled empty state, stale comment `space-timeline.ts:151`.

**Keep**
- `project_spaces`, `project_space_members`, `project_space_links`, `project_sessions.space_id`, private channels, archive, DMs, memory on Drive volumes, the trigger `space_id` route. No table rename.
- Routes `/c/[slug]` and `/dm/[agent]`, and the `spaces.*` SDK surface (public contract).
- Sessions tab in a channel, rendered by the real session list component with a `space_id` filter.

**Add**
- Coordinator mode for channel and DM front agents (prompt + async hand-off defaults reused from My Kortix).
- Feed rows from `result_excerpt` / `board_state` plus child agent rows (#11581 grammar).
- "Move to channel…" in the session header menu and the session list row menu.
- Channel brief at the first turn (bounded, see 2.6).
- Unread per channel and notifications for answers in sessions you started or replied to (reuse the `last_read_seq` model from Rooms).
- Later: external chat bindings map to a channel (`chat_channel_bindings.space_id`), triggers post their outcome into their channel, `kortix channels` in the CLI, mobile.

## 4. Web layout

```
┌ Sidebar ───────────┐┌ #engineering  ·  Purpose  ·  ◉◉◉ 4  ·  Agent: kortix  ·  ⋯ Details ┐
│ + New session      ││ [ Conversation ]  [ Sessions 23 ]                                │
│ Search             ││                                                                  │
│ ▾ Channels         ││  Jay  10:42                                                      │
│   # general        ││  Find why login fails on mobile                                  │
│   # engineering •2 ││  ◆ kortix  Started a session to reproduce it on iOS.             │
│ ▾ Direct messages  ││     ▸ Reproduce login failure · Running · 3 of 5 · Open session  │
│   ◆ kortix         ││  ◆ kortix  Root cause: token refresh races the redirect. Fix    │
│ ▾ Sessions         ││     is in PR #… · Reply · Open session                           │
│   Fix login …      ││                                                                  │
│   Draft invoice …  ││ ┌──────────────────────────────────────────────────────────────┐ │
│                    ││ │ Ask kortix in #engineering                              ↑    │ │
└────────────────────┘│ └──────────────────────────────────────────────────────────────┘ │
                      └──────────────────────────────────────────────────────────────────┘
```

- Header: name, purpose, member faces, front agent, Details (About, Members, Memory, Pinned, Folder, Archive).
- Two tabs: Conversation and Sessions.
- One composer. Reply puts a chip above it; Esc cancels.
- Full work: the session page. Browser and Terminal live there, unchanged.
- Width below `lg`: same feed, no split panes.

## 5. Backend and data

- **No migration in Phase 1.** Phase 2 needs none if D1 = "agent-first" (feed = root sessions). D1 = "people chat too" adds `project_space_messages` (`space_id`, `seq`, `author_user_id`, `session_id` nullable, `text`, `created_at`; unique `(space_id, seq)`), added with a concurrent index, no backfill.
- **Feed endpoint:** reuse `GET /sessions?space_id=&parent=root`; add `children` summary (id, title, `board_state`) per row, one batched query. Replace `reply_count` decompression with a counter read from the session list item; drop it from the feed.
- **Coordinator mode:** a server-side prompt section added for sessions with `space_id` whose agent is the space's front agent (`apps/api/src/projects/lib/my-kortix-prompt.ts` pattern). It does not turn on My Kortix for the project.
- **Notice durability:** close the documented crash window in `subagent-notice.ts:36` (enqueue the notice in the turn-end transaction, or add a reconcile sweep in `worker/jobs/`) before the feed depends on it.
- **Move session:** `PATCH /projects/:id/sessions/:sid { space_id }`, permission `session` write on the session plus membership of a private target; refuses a move into a private channel when the session has members outside it.
- **SDK:** additive only. `useSpaceFeed(projectId, spaceId)` and `moveSessionToSpace()`; existing `spaces.*` exports unchanged. TDD per the sdk skill.
- **Flag:** keep `project_channels` (`wip`, off by default). v2 replaces v1 behind it; no second flag.

## 6. Phases (each one ships and is verified alone)

| Phase | Scope | Proof |
|---|---|---|
| 1 · Sessions first | P2, P4, P5, P6, P7 and dead code: session list back, one composer, Open session + back link, tabs cut to two, Details holds memory/links/folder, "session" wording, no auto-filing, Move to channel. | agent-browser on the worktree stack, flag on and off; flows SPACE-* updated |
| 2 · Conversation | P1: coordinator mode, feed rows from `result_excerpt`, child agent rows, reply retarget, channel brief, notice durability. | real Platinum sessions: 1 message → answer in feed, a long task → child session → result in feed, a reply continues the same session |
| 3 · One model | P3: Channels and Spaces become one concept (D3), pinned overview blocks, unread + notifications. | |
| 4 · Entry points | external chat → channel mapping, triggers post outcomes, CLI, mobile. | |

### Phase 1 status (2026-11-04, uncommitted in the worktree)

Built:
- Sidebar: New session, Cmd+J and the session list are back; Channels and Direct messages sit above the list (`project-sidebar.tsx`, `project-spaces-nav.tsx`). Project home no longer redirects to `#general` (`home-landing.ts` deleted). Mod+T opens a new session. `/sessions` keeps its New button.
- Channel page: two tabs (Conversation, Sessions), one composer, no side panel. A row shows the prompt, the agent's latest answer (`result_excerpt`) and opens the session page. `?thread=<id>` and `?tab=threads` forward to the new places (`space-view.tsx`, `space-timeline.ts`).
- Details dialog holds Memory, Links and Files (channels) and Memory, Files (DMs, new info button). Apps and Triggers tabs removed; `space-apps-view.tsx`, `space-triggers.tsx`, `channel-setup.tsx`, `channels-onboarding.tsx`, `used-memory-chip.tsx` deleted.
- Session header: `# channel /` crumb back to the space (`session-space-crumb.tsx`) and "Move to channel" (`move-session-menu.tsx`).
- API: no auto-filing. A session without `space_id` lands in its parent's space or none; turning the flag on files nothing; `assignUnassignedSessions` and `recordChannelsReenabled` deleted. New `PUT /projects/:id/sessions/:sid/space` (`moveSessionToSpace`), audit `session.space.changed`.
- SDK (additive): `moveProjectSessionToSpace`, `ProjectSessionSpaceMove`, `useMoveProjectSessionToSpace`, facade `spaces.moveSession`.
- Copy: "thread" → "session" in every channels string (en); new keys in all 9 locales.

Follow-ups:
- Other locales still say "thread" in older channel strings (values only; keys match).
- Internal identifiers still say thread (`ThreadRow`, `useSpaceThreads`, `THREAD_*`): rename with no behaviour change.
- `TranscriptRowsContext` and `AfterFirstPromptContext` have no provider left; remove their branches in `session/thread/*`.
- "Move to channel" in the sidebar session row menu.
- SDK README has no spaces section.

## 7. Metrics and kill rule

- **Success:** share of channel root sessions where nobody opens the session page (target ≥ 60 %: the answer was enough); median time from send to the first answer text in the feed.
- **Kill:** if fewer than 3 dogfood projects keep `project_channels` on 4 weeks after Phase 2, remove Channels and keep the session list.

## 8. Decisions

Decided by Jay, 2026-11-04:

- **D1 = agent-first.** Every top-level message starts one front session. No messages table.
- **D2 = every channel and DM agent** runs in coordinator mode inside a channel.
- **D3 = deferred** to the Channels/Spaces brainstorm with Marko. Phases 1–2 touch Channels only.
- **Start = Phase 1**, local in the worktree, no PR until Jay reviews.

Open:

- **D4** May a channel feed show an answer from a session whose audience is narrower than the channel? Recommendation: no.
