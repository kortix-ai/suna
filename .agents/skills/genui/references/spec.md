# Spec: Generative UI (OpenUI) for Kortix web, mobile, and SDK hosts

| | |
|---|---|
| Status | **Draft for review.** No code is written. No plan is written. No Linear issues. |
| Author | Agent, for Jay Suthar |
| Date | 2026-10-09 |
| Surfaces | `@kortix/sdk` (new subpaths), `apps/web`, `apps/mobile`, `apps/api` (flag), `apps/kortix-sandbox-agent-server` (prompt), outbound channels (Slack, push, CLI) |
| Location | `.agents/skills/genui/references/spec.md` on branch `genui` (worktree `../suna-genui`) |

---

## 1. Problem statement

The agent answers every request as markdown prose. Structured requests ("pick the best hotel", "compare these three plans", "show revenue by month") come back as long paragraphs, markdown tables, or mermaid diagrams. The user must read the whole answer to find the one number or the one recommendation they asked for. Charts written as markdown do not look like charts.

Kortix serves about 500k users on web and mobile, and third parties build their own apps on `@kortix/sdk`. Each host would have to build its own rich answer rendering. Today none of them do.

**Evidence level:** founder observation of real sessions. There is no quantitative baseline yet (for example, the share of turns that contain a table, or a comparison). Phase 0 (§11) measures one.

## 2. Goals

| # | Goal | Measure | Target |
|---|---|---|---|
| G1 | Structured answers are faster to read | Median time from turn end to the user's next action on turns with UI, compared with prose turns of the same type (A/B) | −30% |
| G2 | UI is reliable | Blocks that render with no parse error ÷ all blocks | ≥ 99% |
| G3 | UI appears only where it helps | Turns with ≥ 1 UI block ÷ turns, on projects with the flag on | 10–25% (a band, not a minimum) |
| G4 | No streaming regression | Commit count, time to first paint, and dropped frames on the fixed 2,000-token replay (§8.4) | Within 5% of `dev` on web and mobile |
| G5 | One integration for every host | A third-party React app renders UI with `@kortix/sdk` only | ≤ 20 lines of host code (proved by `apps/whitelabel-demo`) |

## 3. Non-goals

| Non-goal | Why |
|---|---|
| UI on every reply | Cards around simple answers repeat the long-paragraph problem in a new form. The model decides per turn (§7). |
| OpenUI's default component library (`@openuidev/react-ui`) | About 30 dependencies, an off-brand look, and no mobile version. We use only the framework-free core. |
| The OpenUI Gateway or OpenUI Cloud | Kortix has its own LLM gateway. Model output does not leave our infrastructure. |
| Arbitrary HTML, CSS, or JS from the model | The `show` tool already serves sandboxed HTML. Generative UI stays a closed set of typed components. |
| Interactivity in Phases 1–3 | Forms, inputs, buttons, Query, and Mutation are Phase 4 only, with the guards in §9. |
| A new transcript part type | UI travels inside the existing `text` part (§5.2). `kortix.transcript.v1` does not change. |

## 4. User stories

**End user (web or mobile)**
1. As a user asking for a recommendation, I want the ranked options as cards with the key facts, so I can choose without reading paragraphs.
2. As a user asking about numbers, I want a real chart with its data source shown, so I can see the trend and know where the data came from.
3. As a user asking about places, I want the places on a map, so I can judge distance and area.
4. As a user who prefers text, I want to turn generative UI off for myself, so every answer is prose.
5. As a user, I want to say "show this as a chart" or "plain text only" for one reply, so I control the format.
6. As a user on a slow network or an old app build, I want a readable answer even when the UI cannot render.
7. As a screen-reader user, I want every chart and map to have a text equivalent, so I get the same information.

**Project owner**

8. As a project owner, I want one setting that turns generative UI on or off for the project, so I control how the agent answers for my team.

**Developer building on `@kortix/sdk`**

9. As a developer, I want to render Kortix generative UI in my own React or React Native app with my own styles, so I do not rebuild the components.
10. As a developer whose app does not render UI, I want one function that turns a reply into plain markdown, so my channel (email, chat bot) stays readable.

**Edge cases**

11. As a user, when the model writes a broken block, I see the valid parts and a readable fallback, never a crash or raw syntax.
12. As a user in Slack, in a push notification, or in the CLI, I see markdown, never OpenUI syntax.
13. As a member of a shared session whose project has the flag off, I see past UI blocks still rendered. The flag stops new UI only.

## 5. Architecture (decisions locked in review on 2026-10-09)

### 5.1 Package layout: subpaths of `@kortix/sdk`

| Subpath | Contents | Allowed imports |
|---|---|---|
| `@kortix/sdk/genui` | Component schemas (zod), `toMarkdown`, fence extraction, streaming parse wrapper, prompt builder, schema version, error mapping | Framework-free. Added to the tripwire list in `packages/sdk/src/index.isomorphic.test.ts`. |
| `@kortix/sdk/genui/react` | DOM renderer and default components, styled with CSS variables | React, react-dom |
| `@kortix/sdk/genui/native` | React Native renderer and default components | React, react-native, react-native-svg, react-native-webview |

- `zod`, `@openuidev/lang-core`, and the renderer libraries are **optional** `peerDependencies`. An SDK user who never imports `/genui` installs nothing new and ships 0 bytes.
- Only `@kortix/sdk/genui` imports `@openuidev/*`. One adapter module wraps it. If OpenUI breaks or dies, we replace that module, and saved transcripts stay valid.
- `@openuidev/lang-core` is pinned to an exact version. It is 0.x: 0.2.16 through 0.3.1 shipped in recent weeks, and 0.3.1 was published 2026-10-08.
- Every new export follows the **sdk** skill: test-first, three synchronized edits, and exported names (including types) treated as public API.
- `apps/web` and `apps/mobile` pass their own design-system components into the renderer. Default components exist for third-party hosts.

### 5.2 Transport: a fenced block inside the `text` part

The agent writes prose and UI blocks in the same text part:

````
Here are the three best options under your budget.

```openui
root = Stack([summary, list])
...
```

Book by Friday; prices rise at the weekend.
````

- **Language tag = schema version.** `openui` is v1. A future breaking version uses `openui-v2`. Both markdown libraries pass the language tag reliably. They do not reliably pass fence meta such as `v=1`.
- The text streams through the existing delta path (`message.part.delta` → SDK 16ms coalescing → sync-store). Nothing in the transport changes.
- Web: `closeUnterminatedCodeFence` already closes an open fence while streaming, so the block renderer receives the partial block on every update tick.
- Why not a tool call: tool input reaches clients only when the call completes, so the UI could not build up while streaming.

### 5.3 Component definition = schema + renderers + fallback

Each component is defined once in `@kortix/sdk/genui`:

| Field | Purpose |
|---|---|
| `name`, `description` | Feed `generateSystemPrompt()` |
| `props` (zod) | Constrains what the model can write, validates while streaming, and rejects out-of-limit values |
| `toMarkdown(props)` | Deterministic markdown fallback. 0 extra model tokens. Always matches the data. |
| `a11yText(props)` | Text equivalent for screen readers (charts, maps) |

The web and native renderers map each `name` to a component. An unknown component name (from a newer schema) renders its string props as a bullet list.

### 5.4 Where it plugs in

| Surface | Integration point (verified 2026-10-09) |
|---|---|
| Web markdown | `apps/web/src/components/markdown/code/markdown-code.tsx`: new branch before `isMermaidCode` (L50) |
| Mobile markdown | `apps/mobile/components/kortix/selectable-markdown.tsx`: `FencedCode` (L183) |
| Project flag | `apps/api/src/feature-flags/registry.ts`, next to `pi_harness` (L311), plus the other 5 places its header lists |
| Prompt, OpenCode | File added to OpenCode `instructions`, the same pattern as `secret-capabilities` (`harness/open-code/lifecycle.ts`) |
| Prompt, pi | Section in `systemPrompt()` (`harness/pi/runtime.ts`) |
| Web analytics | `apps/web/src/lib/track.ts` closed event set (PostHog, no PII) |

## 6. Component catalog (v1: 17 components)

General rules for every component:
- Every count has a hard limit in the schema. The model cannot write cluttered UI.
- Images and links follow the same policy as markdown images and links today (`markdown-policy.ts`). Generative UI adds no new URL capability.
- Charts and maps need a `source` string. The schema enforces that the field is present. It cannot prove the data is true (see §12, R1).
- All visuals use `kortix-brand` tokens on web and `apps/mobile/global.css` colors on mobile, in light and dark themes.

| # | Component | Props (summary) | Limits | `toMarkdown` |
|---|---|---|---|---|
| 1 | `Stack` | `children[]`, `direction: row\|col` | ≤ 12 children, nesting ≤ 4 levels | Children separated by blank lines |
| 2 | `Card` | `title`, `subtitle?`, `image?`, `body?`, `badges?[]`, `link?`, `children?` | body ≤ 600 chars | `### title`, subtitle, body |
| 3 | `Stat` | `label`, `value`, `delta?`, `trend?: up\|down\|flat`, `unit?` | — | `**label:** value (delta)` |
| 4 | `StatRow` | `stats: Stat[]` | 2–4 | Bullet list |
| 5 | `Table` | `columns[]`, `rows[][]`, `caption?` | ≤ 8 columns, ≤ 50 rows | GFM table |
| 6 | `Compare` | `items[{name, specs{}, pros[], cons[]}]`, `winner?` | 2–4 items | Spec table plus pros and cons bullets |
| 7 | `RankedList` | `items[{rank, title, reason, meta?, image?, link?}]` | ≤ 10 items | Numbered list with reasons |
| 8 | `BarChart` | `categories[]`, `series[{name, values[]}]`, `unit?`, `source` | ≤ 24 categories, ≤ 4 series | Value table plus `Source:` |
| 9 | `LineChart` | `x[]`, `series[{name, values[]}]`, `unit?`, `source` | ≤ 365 points, ≤ 4 series | Value table plus `Source:` |
| 10 | `PieChart` | `slices[{label, value}]`, `unit?`, `source` | ≤ 6 slices | List with percentages plus `Source:` |
| 11 | `Map` | `markers[{lat, lng, label, description?}]`, `route?[[lat,lng]]`, `center?`, `zoom?`, `source` | ≤ 25 markers, ≤ 500 route points | Marker list, each with an OpenStreetMap link |
| 12 | `Tabs` | `tabs[{label, children[]}]`, `default?` | 2–5 tabs | Each tab as a `####` heading, all expanded |
| 13 | `Accordion` | `items[{title, children[]}]`, `open?[]` | ≤ 10 items | Each item as a `####` heading, all expanded |
| 14 | `Badge` | `label`, `tone: neutral\|good\|warn\|bad` | label ≤ 24 chars | `[label]` |
| 15 | `Callout` | `tone: info\|warn\|success`, `title?`, `body` | body ≤ 400 chars | `> **title** body` |
| 16 | `Image` | `src`, `alt`, `caption?` | `alt` required | `![alt](src)` |
| 17 | `Link` | `label`, `href` | http(s) only | `[label](href)` |

### 6.1 Charts
- **Web:** `recharts`. It is already a dependency (`apps/web/package.json`) and the shadcn `components/ui/chart.tsx` wraps it. The chart code loads only when a chart block appears.
- **Mobile:** `react-native-svg` (already installed, 15.15.4) plus a small scale/path helper. No new native module, so it ships over the air.
- Every chart has a "Show data" control that renders the `toMarkdown` table. This is also the screen-reader path.

### 6.2 Map
- **Web:** mapcn (MIT, built on MapLibre GL, installed through the shadcn registry into `apps/web/src/components/ui/`). It loads only when a map block appears. maplibre-gl is large, so it never enters the main bundle.
- **Mobile:** maplibre-gl inside `react-native-webview` (13.16.1, installed), the same pattern as `MermaidBlock.tsx`. It ships over the air. A native MapLibre module would change `runtimeVersion` (`1.4.4` in `apps/mobile/app.json`) and need a store release, so it is P2.
- **Tiles: CARTO cannot be the provider.** mapcn defaults to CARTO basemaps, and their README says commercial use requires a CARTO Enterprise license. Candidates: OpenFreeMap, self-hosted Protomaps PMTiles, MapTiler, Stadia. Decision needed (Q1).
- **Privacy:** each tile request tells the tile host the viewer's IP address and the area they are looking at. Self-hosting or proxying tiles removes that (Q2).
- **Interaction:** pan and zoom only. A tap on a marker shows its label and description. No geolocation and no permission prompts.
- The map has a fixed height (web 280px, mobile 220px), so it does not cause a layout jump.

### 6.3 Tabs and Accordion
- **Web:** existing `components/ui/tabs.tsx` and `components/ui/accordion.tsx` (Radix, keyboard-accessible).
- **Mobile:** existing `components/ui/tabs.tsx`. Accordion is new, built with reanimated (4.3.1, installed) and following the **animations-dev** rules.
- **Streaming:** while the block streams, the tab or item that is being written is the one shown, so the user sees progress. After the stream, the model's `default` / `open` value applies.
- **Fallback:** every panel expanded. No content is hidden in markdown, copy, Slack, or export.

## 7. When the agent uses UI (prompt policy)

The model decides per turn. The rules go in the generated system prompt:

| Use UI for | Stay in prose for |
|---|---|
| 2 or more options to compare | Conversation, greetings, short answers (under about 3 sentences) |
| A ranked recommendation | Explanations, reasoning, opinions |
| 3 or more numbers, a time series, a breakdown | Code (code fences stay as they are) |
| Places with coordinates from a tool or file | Step-by-step instructions |
| A status summary | Content the user asked for as plain text |

Mandatory rules:
1. Write at least one sentence of prose before the first block. Push notification previews and titles use that sentence.
2. Charts and maps use only data from tool results, files, or the user. Never invent numbers or coordinates. Always fill `source`.
3. "Show as a chart" or "as a table" forces UI. "Plain text" or "no UI" suppresses it for that reply.
4. At most 3 blocks per reply.

The Phase 0 evaluation set includes negative cases, where the correct answer is prose. G3 tracks overuse in production.

## 8. Requirements

### 8.1 P0: must have to ship

**R-SDK-1. Parse and fallback core (`@kortix/sdk/genui`)**
- [ ] `extractBlocks(text)` returns prose segments and `openui` blocks in order. Unknown fence languages pass through unchanged.
- [ ] `createBlockParser()` wraps `createStreamingParser`. `set(fullText)` parses only the new text.
- [ ] `toMarkdown(text)` turns a whole reply into markdown, block by block. Unparseable block → its valid statements as markdown, plus nothing raw.
- [ ] `buildPrompt()` returns the system prompt from the same library definitions.
- [ ] The tripwire test passes with `/genui` in the framework-free list.
- [ ] Not installing `zod` or `@openuidev/lang-core` does not break `@kortix/sdk` or `@kortix/sdk/react` (package test).

**R-FLAG-1. Toggle**
- Given project flag `genui` is off, when a session starts, then the system prompt is byte-for-byte identical to the prompt on `dev` without the feature (asserted by a snapshot test on both harnesses).
- Given the flag is on, when the session starts on OpenCode or pi, then the instructions are present (asserted on both harnesses).
- Given the flag changes, when the next session starts, then the new value applies. Running sessions keep their prompt.
- Given a user turned the personal override off, when a reply contains a block, then that user sees `toMarkdown` output. Other users still see UI.
- Given the server kill switch is on, then new sessions get no instructions, and clients render blocks as `toMarkdown`.

**R-WEB-1. Web renderer**
- [ ] Renders all 17 components through `@/components/ui/*`, in both themes. `kortix-brand/scripts/audit.sh` is clean on changed files.
- [ ] Each block has its own error boundary. A render error shows `toMarkdown` output and fires `genui_block` with `outcome=render_error`.
- [ ] Charts and the map load as separate lazy chunks.
- [ ] Copy-message copies `toMarkdown` output, not OpenUI syntax.
- [ ] The public share page and transcript export render the same way.
- [ ] Desktop parity (Electron): 720 × 480 window, both themes, browser zoom, no clipped last row.

**R-MOB-1. Mobile renderer**
- [ ] Renders all 17 components with mobile primitives (`apps/mobile/design.md`, `AGENTS.md`).
- [ ] Ships over the air on `runtimeVersion` 1.4.4 with no new native module.
- [ ] Android matches iOS.
- [ ] Builds older than the OTA show the raw fence. This is accepted, and the OTA reaches them on next launch (`checkAutomatically: ON_LOAD`).

**R-STREAM-1. Streaming contract (web and mobile)**
- [ ] Parse runs on the existing update tick (web 32ms `STREAM_COMMIT_MS`, mobile ~20Hz pacer), never per delta.
- [ ] One parser per (`partID`, block index), reused across ticks.
- [ ] Nodes are keyed by statement name. Unchanged statements do not re-render (asserted by render count in a test).
- [ ] An unfinished last statement is held back. A referenced but undefined statement shows a fixed-size placeholder.
- [ ] Each component reserves its final height, so finishing the block causes no layout jump.
- [ ] `rehypeStreamWords` word fade-in is off inside blocks.
- [ ] A stream that ends mid-block renders its valid statements and a one-line "Response was cut off" note.

**R-CHAN-1. Outbound channels never show raw syntax**
- [ ] Slack replies, email, push notification previews, session-title generation input, and the CLI transcript all pass through `toMarkdown` (or take the first prose sentence, for previews).

**R-SEC-1. Safety (Phases 1–3)**
- [ ] No HTML, CSS, script, or event handler can come from model output. The renderer maps only known components.
- [ ] Image and link URLs follow `markdown-policy.ts`, unchanged.
- [ ] OpenUI `Query`, `Mutation`, and `$state` statements are ignored and logged in Phases 1–3.
- [ ] `@openuidev/*` runtime telemetry stays off. It is opt-in, and we never set `OPENUI_RUNTIME_TELEMETRY_ENABLED`.

**R-A11Y-1. Accessibility**
- [ ] Every chart and map has `a11yText` and a "Show data" table.
- [ ] Tabs and Accordion are fully keyboard-operable on web and screen-reader-labeled on mobile.
- [ ] `prefers-reduced-motion` turns off accordion and chart enter animations.

**R-OBS-1. Telemetry**
- [ ] Web event `genui_block` added to the closed set in `track.ts` with: `outcome` (`rendered | fallback | parse_error | render_error | cut_off`), `components` (names only), `model`, `ms_to_first_paint`. No content, no URLs, no IDs.
- [ ] The same event on mobile (Q5: mobile has no analytics module today).

### 8.2 P1: fast follow

- **R-P1-1. Server-side quality count.** On turn completion, parse each block with `@kortix/sdk/genui` and record valid / invalid per model. This gives G2 without depending on client analytics.
- **R-P1-2. Cross-device user override.** Store the personal override on the server, not only in `user-preferences-store` (web) and local storage (mobile).
- **R-P1-3. Per-model allowlist.** The flag sends instructions only to models that pass the evaluation (§11). Other models get no instructions, even when the flag is on.
- **R-P1-4. Settings copy and discovery.** Project settings row, personal toggle in Appearance, one changelog entry, and docs under `apps/web/content/docs/sdk/`.

### 8.3 P2: design for, do not build

- Native MapLibre on mobile (store release).
- Schema v2 (`openui-v2`), with v1 rendering kept forever.
- More components (calendar, timeline) if Phase 0 or production prompts show demand.
- Host-side component overrides beyond restyling (custom components registered by a third-party host).

### 8.4 Regression gate (must pass before every rollout step)

A fixed 2,000-token assistant reply, replayed through the real SDK store into each renderer, in 3 variants: prose only, prose with 1 chart block, prose with 3 mixed blocks.

| Measure | Web | Mobile |
|---|---|---|
| React commits during the stream | ≤ `dev` + 5% | ≤ `dev` + 5% |
| Time to first visible token | ≤ `dev` + 5% | ≤ `dev` + 5% |
| Dropped frames (web: long tasks > 50ms; mobile: JS FPS on a low-end Android device) | ≤ `dev` + 5% | ≤ `dev` + 5% |
| Parse time per tick for a 4 KB block | ≤ 2 ms (target, to be measured) | ≤ 4 ms (target, to be measured) |
| Main-bundle size increase | 0 bytes (all lazy) | — |

`@openuidev/lang-core` 0.3.1 measures 147.7 KB raw / 39.9 KB gzip, unminified (`dist/index.mjs`). It is loaded only when the first block appears.

## 9. Phase 4: interactivity (designed now, built after Phase 3)

Scope is exactly **Form, Input, Button** plus guarded actions. Nothing else.

| Item | Rule |
|---|---|
| `Button` action `send_message` | Sends a follow-up user message with fixed text from the block. It runs nothing a user could not type. |
| `Form` + `Input` | Submit sends one follow-up user message that contains the field values. Input types: text, number, select, date. |
| OpenUI `Mutation` | Runs **only on a click**, never on render. Each call goes through the existing session permission prompt (`permission.*` events). It runs inside the sandbox with the agent's grants, never the viewer's credentials. |
| OpenUI `Query` | Calls only tools on an allowlist of read-only tools. Rate-limited per session. The first result is saved into the transcript, so replays and other devices never re-run it. |
| Shared sessions | Only members allowed to send messages in the session can click actions. |
| Audit | Every action is recorded as a normal user message or permission event in the transcript. |

Phase 4 gets its own spec addendum and security review before any code.

## 10. Success metrics

**Leading (measured weekly from launch)**
- Parse-error rate per model (G2): ≥ 99% valid. Stretch: 99.7%.
- Turns with UI on enabled projects (G3): 10–25%.
- Personal-override opt-out rate: < 15% of exposed users.
- `ms_to_first_paint` for the first block: p75 < 300 ms after the block's first statement arrives.

**Lagging (evaluated at 4 and 12 weeks after general availability)**
- G1 time-to-next-action: −30% on UI turns (A/B against flag off).
- Thumbs-down rate on UI turns ≤ prose turns.
- Session retention on enabled projects ≥ control.

**Kill criteria:** remove or redesign if, 4 weeks after general availability, parse errors stay above 3%, or personal opt-out exceeds 30%.

## 11. Phases

| Phase | Scope | Exit criterion |
|---|---|---|
| 0. Evaluation spike (2–3 days) | ~46 prompts, including negative cases, against `deepseek/deepseek-v4-pro`, `openai/gpt-5.5`, `openai/gpt-6-sol`, `openai/gpt-6-astra` | Parse validity, tokens per block, overuse rate, visual review. Go/no-go per model. |
| 1. Core + web | R-SDK-1, R-FLAG-1, R-WEB-1, R-STREAM-1 (web), R-CHAN-1, R-SEC-1, R-A11Y-1, R-OBS-1 | Internal projects only. Regression gate green. |
| 2. Mobile | R-MOB-1, R-STREAM-1 (mobile) | OTA live. Regression gate green on a low-end Android device. |
| 3. Rollout | 1% → 10% → 50% → 100% of projects, by flag | Each step holds G2 and G4 for 3 days. The kill switch is tested before step 1. |
| 4. Interactivity | §9 | Separate addendum and security review. |

**Dependencies:** a tile provider decision (Q1) blocks the Map component only. The other 16 components do not wait.

## 12. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Invented data looks more credible in a chart or map than in prose | Prompt rule 2, a `source` field that must be present, "Show data" on every chart. The schema cannot verify truth. This stays the biggest product risk. |
| R2 | OpenUI is 0.x and changes weekly | Exact pin, one adapter module, our own schema version in the language tag |
| R3 | Weaker models write invalid OpenUI Lang | Per-model allowlist (R-P1-3), Phase 0 evaluation, fallback rendering |
| R4 | Extra prompt tokens (~1.5–3k per turn when on) | Fixed prompt text per release, so prompt caching applies. Measured in Phase 0. |
| R5 | Two renderers to maintain | Shared schemas and `toMarkdown`. Each new component needs both renderers before it enters the prompt. |
| R6 | Map tiles leak the viewer's IP and area to a third party | Q2: self-host or proxy |
| R7 | Third-party developers who install `@openuidev/lang-core` trigger its install-time PostHog telemetry | Document `OPENUI_TELEMETRY_DISABLED=1` / `DO_NOT_TRACK=1` in the SDK docs. Our repo is unaffected (`ignore-scripts=true` in `.npmrc`). |
| R8 | Old mobile builds show raw syntax until they take the OTA | Accepted. `ON_LOAD` update check. |

## 13. Open questions

| # | Question | Owner | Blocking? |
|---|---|---|---|
| Q1 | Which tile provider: OpenFreeMap, self-hosted Protomaps, MapTiler, or Stadia? CARTO is excluded for commercial use. | Jay + legal | Blocks Map only |
| Q2 | Proxy or self-host tiles for privacy (R6)? | Engineering | Blocks Map only |
| Q3 | Where do the Phase 0 evaluation prompts and script live? Proposal: `.agents/skills/genui/scripts/` (the `tests/` rules forbid ad hoc harnesses). | Engineering | Blocks Phase 0 |
| Q4 | Is the personal override per device in P0 acceptable, with server sync in P1? | Jay | No |
| Q5 | Mobile has no analytics module. Add PostHog to mobile, or rely on the server-side count (R-P1-1)? | Jay + engineering | Blocks R-OBS-1 on mobile |
| Q6 | Does Slack get `toMarkdown` output, or a "View in Kortix" link for blocks with charts or maps? | Jay | No |
| Q7 | A/B design for G1: per project or per user? | Data | Blocks the G1 measurement only |

## 14. Locked decisions (review of 2026-10-09)

1. Toggle: project default, plus a personal override.
2. Off = no UI instructions in the prompt. On = every block has a deterministic markdown fallback.
3. Components: our own Kortix components. Only the OpenUI framework-free core is used.
4. Packaging: `@kortix/sdk/genui`, `/genui/react`, `/genui/native`. No separate package.
5. The model decides per turn when to use UI.
6. Query/Mutation: Phase 4, guarded (§9). Phase 4 scope is Form, Input, Button.
7. Phase 0 models: as listed in §11.
8. Map via mapcn on web. Tabs and Accordion are in v1.
