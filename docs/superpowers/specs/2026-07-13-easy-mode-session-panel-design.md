# Easy Mode / Advanced Mode — Session Action Panel

**Date:** 2026-07-13
**Status:** Approved design, pending implementation plan
**Area:** `apps/web/src/features/session/action-panel/`

## Problem

The session panel today is built for engineers. It is a one-tool-at-a-time stepper
(`action-panel/session-actions-panel.tsx`): prev/next chevrons, a slider scrubber,
and a raw tool view for whichever of the 104 registered tools is selected. A
non-technical user opening it sees `grep`, `pty_spawn`, and JSON arguments.

Kortix's primary audience is non-technical. The panel should, by default, tell that
user what the agent is *doing* — in their language — while keeping every bit of
engineer detail one tap away for the people who want it.

## Solution

Two modes for the panel, selected by a persisted user preference:

- **Easy** (default, everyone): a card home — `Progress`, `Outputs`, `Context` —
  modelled on Claude.ai's task panel. Plain-language narration, no tool names, no tabs.
- **Advanced**: today's stepper, unchanged.

Easy mode is a *lens over the same data*, not a separate data path. It reads the same
`ToolPart[]` stream the stepper reads. Tapping any Progress row reveals the real tool
view underneath it, so the simplification is never a wall.

## Architecture

`features/session/action-panel/` splits three ways:

```
action-panel/
  index.tsx                  # reads panelMode, renders easy or advanced
  advanced/
    advanced-panel.tsx       # today's session-actions-panel.tsx, moved verbatim
  easy/
    easy-panel.tsx           # the card home
    progress-card.tsx        # collapsed card (drill-in, chevron right)
    progress-view.tsx        # the drilled-in step list
    step-row.tsx             # one narrated step; expands to the real tool view
    outputs-card.tsx         # expander (chevron down)
    context-card.tsx         # expander (chevron down)
    empty-illustration.tsx   # the soft empty-state art
  shared/
    collect-tool-parts.ts    # existing; lifted out of the stepper, both modes use it
    narration.ts             # tool name -> family + sentence template
    group-steps.ts           # collapse consecutive same-family calls into one step
    derive-outputs.ts        # ToolPart[] -> artifacts the agent produced
    derive-context.ts        # ToolPart[] -> files read, web sources, tools used
```

The four new `shared/` modules are pure functions over `ToolPart[]` with no React.
Narration correctness is the feature, so it must be unit-testable in isolation.

The 104 tool views and `tool/shared/registry.ts` are **not touched**. Easy mode renders
them through the existing `ToolPartRenderer` with `ToolSurfaceContext = 'panel'`.

## Tool families

104 canonical tools (97 registered by literal name across `tool/tools/*`, plus 7
registered dynamically by `removed-integration-tool.tsx`). The registry holds ~200 keys
because each tool registers snake_case, kebab-case, and an `oc-` prefixed alias;
`narration.ts` normalizes (`strip ^oc-`, `-` → `_`) before lookup, mirroring the fuzzy
matching `ToolRegistry.get()` already does.

| Family | Progress line | Tools |
|---|---|---|
| `explore` | "Looked through your files" / "Read 6 files" | `read` `glob` `grep` `list` |
| `edit` | "Wrote report.md" / "Updated 3 files" | `write` `edit` `morph_edit` `apply_patch` |
| `run` | "Ran a command" | `bash` `pty_spawn` `pty_read` `pty_write` `pty_input` `pty_kill` |
| `web` | "Searched the web · 3 queries" / "Read 2 pages" | `web_search` `websearch` `web_fetch` `webfetch` `scrape_webpage` `scrapewebpage` `image_search` |
| `create` | "Made an image" / "Built a presentation" | `image_gen` `video_gen` `presentation_gen` `show` `show_user` |
| `plan` | "Planned the work · 5 steps" | `todo_write` `todowrite` `task` `task_create` `task_get` `task_list` `task_update` `task_done` `task_delete` `task_start` `task_message` `task_approve` `task_cancel` |
| `delegate` | "Asked a helper agent to…" | `agent_spawn` `agent_message` `agent_status` `agent_stop` `agent_task` `agent_task_create` `agent_task_get` `agent_task_list` `agent_task_update` `agent_task_start` `agent_task_message` `agent_task_approve` `agent_task_cancel` |
| `sessions` | "Checked earlier work" | `session_get` `session_read` `session_search` `session_message` `session_spawn` `session_lineage` `session_stats` `session_list` `session_list_background` `session_list_spawned` `session_start_background` |
| `memory` | "Recalled what you told it before" | `memory` `memory_search` `mem_search` `ltm_search` `get_mem` |
| `apps` | "Connected to Gmail" | `connector_get` `connector_list` `connector_setup` `kortix_executor_call` `kortix_executor_connectors` `kortix_executor_describe` `kortix_executor_discover` |
| `automations` | "Set up an automation" | `triggers` `trigger_create` `trigger_delete` `trigger_get` `trigger_list` `trigger_pause` `trigger_resume` `trigger_test` `trigger_update` |
| `projects` | "Opened your project" | `project_create` `project_delete` `project_get` `project_list` `project_select` `project_update` |
| `skills` | "Used a skill" | `skill` |
| `ask` | "Asked you a question" | `question` `ask` |
| `retired` | "This integration was removed" | the 7 `integration-*` names |
| `hidden` | *not rendered in Easy mode* | `prune` `distill` `compress` `context_info` |

**Fallback is load-bearing.** MCP tools have arbitrary `server/tool` names that cannot be
enumerated, and any tool added after this ships is unknown to the map. Both render as
"Used <humanized name>" — never a raw identifier, never a crash. A unit test asserts every
name in the registry resolves to a family or the fallback, so the map cannot silently rot.

`hidden` covers context-engine bookkeeping. It means Easy mode is not a complete record of
every call — an accepted trade: these tools are meaningless to this audience, and Advanced
mode remains the complete record.

## Easy mode UI

**Progress** — a drill-in (chevron right). Collapsed it is alive: while running it shows the
current step with a shimmer ("Searching the web…"); when idle it settles to "12 steps · 1m 04s".
Tapping slides the panel to a full-height step list. Each row: status dot (done / running /
failed), the narrated sentence, duration right-aligned. Tapping a row expands the real
`ToolPartRenderer` inline beneath it.

Consecutive calls in the same family collapse into one step ("Read 6 files"), which is what
turns a 60-call run into a ~8-line story.

**Outputs** — expander. Empty: illustration + "Files created during this task will appear here."
Filled: file chips (derived from `edit`/`create` families) opening in the existing previewer.
Auto-expands when a run completes with content, so the payoff lands without a click.

**Context** — expander. Empty: illustration + "Tools and files the agent referenced will appear
here." Filled: grouped as *Files read (6)* / *Web sources (3)*, with favicons / *Tools used*.

No tab strip in Easy mode. Browser, Terminal, Explorer, and Audit are engineer surfaces and are
not reachable; `session-browser-store` keeps its view state untouched, waiting for Advanced.

## Motion

Card expand: height + opacity, 200ms ease-out, chevron rotating in step. Progress drill-in:
horizontal slide, 240ms. Step rows stagger 20ms **on first paint only** — appending a live step
must not re-animate the list. Running row shimmers. All behind `prefers-reduced-motion`.

## The toggle

`panelMode: 'easy' | 'advanced'` in `stores/user-preferences-store.ts` (persisted,
`kortix-user-preferences`). Defaults to `easy` for **all** users, existing included.

Three entry points:

1. **Settings → Appearance** — a segmented control, not a switch, with a line of explanation
   under each option. "Easy mode: off" tells a user nothing.
2. **Command palette** — one `lib/menu-registry.ts` entry (`kind: 'action'`,
   `actionId: 'togglePanelMode'`, `requiresSession: true`) plus one handler in the
   `actionHandlers` map in `features/workspace/command-palette.tsx`. Label states the
   destination: "Switch to Advanced view".
3. **Panel header** — a quiet text affordance. This is the one that gets used; a setting nobody
   can find is a setting nobody has.

A one-time dismissible hint on first render points existing users at Advanced, so nobody files a
bug about their stepper vanishing.

## Compatibility

- `session-layout.tsx` renders `PanelHeaderSwitcher` (the tab strip) only when
  `panelMode === 'advanced'`.
- Clicking a tool call in the chat (`session-chat.tsx` → `handleToolActivate` → `focusToolCall`)
  today jumps the stepper. In Easy mode it must open Progress, scrolled to that step with its tool
  view expanded. This path is easy to break silently and must be covered by a test.
- `⌘I` open/close, the mobile Drawer, and expand-to-full are mode-independent and unchanged.

## Testing

Per the repo testing skill, co-located `bun:test`:

- `narration` — every registry key resolves to a family or the fallback; alias normalization
  (`oc-`, kebab/snake); MCP `server/tool` names hit the fallback.
- `group-steps` — consecutive same-family collapse; mixed runs; empty; single call.
- `derive-outputs` / `derive-context` — correct partition of a realistic `ToolPart[]`.
- Component: Easy renders cards and no tab strip; Advanced renders the stepper unchanged;
  `focusToolCall` opens the right Progress step.
- `app/(system)/debug/tools/page.tsx` gains an Easy-panel fixture so both modes stay eyeball-checkable.

## Out of scope

- Server-side persistence of `panelMode` (no UI-preferences API exists; localStorage is the
  established pattern for every other preference).
- Any change to the 104 tool views.
- LLM-generated narration.
