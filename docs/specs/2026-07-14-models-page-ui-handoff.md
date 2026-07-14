# Handoff: Models page

Status: implementation-ready proposal, pending product approval
Date: 2026-07-14
Branch: `acp-harness-runtime-v2`
PR: #4510, keep open and unmerged
Parent specification: `docs/specs/2026-07-14-provider-auth-model-management.md`

## 1. Outcome

Replace the current provider modal and its `Connected / Add provider / Models`
tabs with one calm, self-explanatory **Models** page.

The page answers two questions without exposing internal routing terminology:

1. What does Claude Code, Codex, OpenCode, or Pi currently use?
2. What model services are connected to this project?

Users change a runtime's connection directly in that runtime's row. There is no
`Advanced routing`, routing matrix, hidden route editor, or separate model
visibility screen.

### Core UI change

| Before                                                                    | After                                                                      |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `Connected / Add provider / Models` tabs                                  | One **Models** page with every effective runtime connection visible        |
| Separate `Active harness routes` matrix                                   | `Change` selector directly in each Claude Code, Codex, OpenCode, or Pi row |
| Provider connection and model visibility presented as equivalent settings | Runtime choices first; maintainable connections immediately below          |
| Subscription cards showing `0 models`                                     | `Models managed by Claude Code` or `Models managed by Codex`               |
| Empty catalog blocks session creation                                     | Harness default starts without an explicit catalog model                   |
| Singleton custom-provider secrets                                         | Multiple named custom connections with multiple models                     |

## 2. Locked product language

Use these labels consistently:

| Internal concept            | User-facing language                        |
| --------------------------- | ------------------------------------------- |
| provider/auth route         | connection                                  |
| harness                     | agent runtime, or the concrete product name |
| managed gateway             | Kortix — subtitle "Included — no setup needed" (row metadata: "Included with Kortix · N models") |
| `claude_subscription`       | Claude subscription                         |
| `codex_subscription`        | ChatGPT subscription                        |
| harness-owned model default | Harness default                             |
| gateway `auto`              | Automatic                                   |
| custom provider             | Custom endpoint                             |
| active route                | Uses                                        |

Do not show `managed_gateway`, `native_config`, `harness_auth_routes`, protocol
IDs, secret names, or connection-kind IDs in normal UI. Also never render the
strings "Kortix managed" or "managed gateway" — the connection is just
"Kortix" (2026-07-14 UX pass, see `2026-07-14-ux-ui-completion-plan.md`).

## 3. Page anatomy

Use `CustomizeSectionWrapper`.

```text
Models                                                   [Connect]
Connect model services and choose what each agent runtime uses.

Agent runtimes
┌──────────────────────────────────────────────────────────────────┐
│ Claude Code                                Connected             │
│ Claude subscription · Harness default                [Change ▾] │
└──────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────┐
│ Codex                                      Connected             │
│ ChatGPT subscription · Harness default               [Change ▾] │
└──────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────┐
│ OpenCode                                   Connected             │
│ Kortix · Automatic                                   [Change ▾] │
└──────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────┐
│ Pi                                         Needs connection      │
│ Choose how Pi accesses models                          [Connect] │
└──────────────────────────────────────────────────────────────────┘

Connections
┌──────────────────────────────────────────────────────────────────┐
│ Claude subscription                         Connected  [Manage] │
│ Used by Claude Code · Models managed by Claude Code             │
└──────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────┐
│ ChatGPT subscription                        Connected  [Manage] │
│ Used by Codex · Models managed by Codex                         │
└──────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────┐
│ Kortix                                      Connected  [Manage] │
│ Included with Kortix · 12 models available                     │
└──────────────────────────────────────────────────────────────────┘
```

The two sections are intentionally on the same page:

- **Agent runtimes** is task-oriented: what will run.
- **Connections** is resource-oriented: what is connected and maintainable.

This slight repetition is useful. It removes the need for users to mentally join
a provider list to a separate route matrix.

## 4. Agent runtime rows

Render only runtime profiles actually referenced by enabled project agents.
Deduplicate profiles with the same harness when they share one project harness
route. If future profiles support different connection bindings, render the
runtime profile name as secondary metadata and keep each distinct row.

Each row contains:

- harness icon tile;
- product name: `Claude Code`, `Codex`, `OpenCode`, or `Pi`;
- status `Badge`;
- one summary line: `<connection> · <model policy>`;
- one trailing control: `Change` or `Connect`.

### Ready examples

```text
Claude subscription · Harness default
ChatGPT subscription · Harness default
Kortix · Automatic
Anthropic production · claude-sonnet-4-6
Local vLLM · qwen3-coder
```

### Status and action matrix

| Runtime state                        | Badge                         | Summary                                | Action                           |
| ------------------------------------ | ----------------------------- | -------------------------------------- | -------------------------------- |
| Ready                                | `Connected` success           | effective connection and model policy  | `Change`                         |
| Checking                             | `Checking` neutral            | `Checking <connection>...`             | disabled `Change` with `Loading` |
| No compatible connection             | `Needs connection` warning    | `Choose how <runtime> accesses models` | `Connect`                        |
| Multiple migrated routes, no default | `Choose connection` warning   | `Select one of N connected options`    | `Choose`                         |
| Credential invalid/expired           | `Needs attention` destructive | `<connection> needs to be reconnected` | `Fix`                            |
| Endpoint unavailable                 | `Unavailable` destructive     | `<connection> could not be reached`    | `Retry` or `Manage`              |

### Change control

`Change` opens the existing `Select` popover directly from the row. It lists
only ready connections compatible with that harness:

```text
✓ Claude subscription            Harness default
  Anthropic production           8 models
  Kortix                         Automatic
──────────────────────────────────────────────
  Connect another service
```

Selection saves immediately. Use `successToast('<Runtime> now uses <Connection>')`.
The former value remains selected if the mutation fails. Do not add a separate
Save button for the page.

`Connect another service` opens the Connect modal already filtered to methods
compatible with that runtime. On successful connection, return to the page and
select the new connection only if the user confirmed `Use with <runtime>` in the
connect flow.

## 5. Connections list

Connections are compact entity rows, not cards, tabs, or disclosures. Sort:

1. needs-attention connections;
2. connections currently used by one or more runtimes;
3. unused ready connections;
4. newest first inside each group.

Each row contains:

- provider/service icon tile;
- user-defined or standard connection name;
- status `Badge`;
- one metadata line;
- `Manage` action.

Metadata examples:

```text
Used by Claude Code · Models managed by Claude Code
Used by Codex · Models managed by Codex
Used by OpenCode and Pi · 12 models available
Not currently used · 4 models available
Needs attention · Token expired 2 hours ago
```

Never render `0 models` for a subscription or for a runtime that owns its own
default. Use `Models managed by Claude Code`, `Models managed by Codex`, or
`Model catalog not exposed`.

When there are no connections, keep the Agent runtime rows visible in their
missing state and show an `EmptyState` under Connections with one `Connect`
action. Do not replace the whole page with an empty state.

## 6. Connect modal

Use the repository `Modal`, not a page tab or raw dialog. Title: **Connect a
model service**. Description: **Use a subscription, API key, or compatible
endpoint.**

The first screen is a short categorized list:

### Subscriptions

- Claude Code
- ChatGPT / Codex

### API keys

- Anthropic
- OpenAI
- other supported providers from the SDK catalog

### Custom

- OpenAI-compatible endpoint
- Anthropic-compatible endpoint

Do not show a provider search field until the known-provider list exceeds eight
items. If search is needed, it belongs inside this modal and uses
`InputGroupSearch`.

Selecting a method replaces the modal body with its form and a visible Back
control. The user never moves to a new top-level tab.

### Subscription form

- concise setup instructions;
- write-only token/auth input or supported browser/device flow;
- `Connect` button;
- verification in the same mutation;
- final `Use with Claude Code/Codex` checkbox, checked when this is the first
  compatible connection and otherwise unchecked.

### API-key form

- optional user-facing name, prefilled;
- write-only key input;
- test before persisting as ready;
- compatible runtime summary;
- optional `Use with ...` choices.

### Custom endpoint form

- name;
- protocol;
- base URL;
- auth mode and optional credential;
- `Test connection`;
- discovered models or manual model IDs;
- required default model only when the endpoint cannot choose one itself;
- compatible runtime choices returned by the API.

Do not expose environment-variable names. Multiple custom connections and
multiple models per custom connection must work.

## 7. Manage connection modal

`Manage` opens one modal with the connection summary and only relevant fields:

1. status and last successful check;
2. used-by runtime names;
3. `Test connection`;
4. `Reconnect` or `Replace key`;
5. models section only for managed/API/custom connections;
6. endpoint details only for custom connections;
7. `Disconnect` through `ConfirmDialog`.

Subscription detail copy:

```text
Models are selected by Claude Code. Kortix uses the harness default unless you
choose a supported override when starting a session.
```

Disconnect confirmation must state which runtimes are affected and what each
will use afterward. If no fallback exists, require the user to choose a
replacement before disconnecting.

## 8. Composer integration

The composer is not another provider manager.

- Agent selector shows logical agent plus harness badge.
- Model selector shows `Harness default`, `Automatic`, or connection-qualified
  models valid for that agent's effective connection.
- Secondary text may say `via Claude subscription`.
- One small `Manage models` link opens this Models page, not the old tabbed modal.
- Missing auth shows `Connect Claude Code`, `Connect Codex`, and similar direct
  actions.
- A valid harness default enables Send even when `choices.length === 0`.
- Changing the selected agent clears incompatible remembered model state.
- Existing sessions keep agent/harness immutable; unsupported model changes
  offer `Start a new session`.

Delete the universal condition that equates an empty catalog with an unusable
session.

## 9. Visual implementation rules

Follow `.claude/skills/kortix-design-system/SKILL.md` and its companion
`make-interfaces-feel-better` guidance.

Required composition:

- `CustomizeSectionWrapper` with title, description, and header `Connect` action;
- `Label` for `Agent runtimes` and `Connections`;
- `<ul className="space-y-2">` entity rows;
- `bg-popover rounded-md border px-4 py-3` rows;
- `Badge` for statuses;
- `Select` with `variant="popover"` for connection changes;
- `Modal` for connect/manage flows;
- `ConfirmDialog` for disconnect;
- `Loading`, `Skeleton`, `EmptyState`, `ErrorState`, and named toast helpers;
- semantic and `kortix-*` tokens only;
- minimum 40px interactive hit areas;
- `active:scale-[0.96] transition-transform` on appropriate buttons;
- exact-property transitions, never `transition-all`.

Do not use:

- tabs;
- `Disclosure` for routing;
- `SectionCard`, `List`, or `ListRow`;
- raw `Dialog`, raw `Tooltip`, raw Sonner, or icon spinners;
- decorative gradients, glows, large rounded containers, or provider brand
  colors as page chrome;
- nested cards inside cards.

## 10. Responsive behavior

Desktop and mobile retain the same information order.

- Page header stacks; `Connect` remains full-label, not icon-only.
- Runtime and connection rows stack their action below metadata when space is
  insufficient.
- Status never pushes the title into truncation; metadata may wrap to two lines.
- Select popovers fit the viewport and keep connection name plus one metadata
  line.
- Modals use the existing mobile full-width behavior and scroll only their body.
- No horizontal table is used for the primary page.

Test at 1440px, 1024px, 768px, 390px, and 320px widths in both light and dark
themes.

## 11. SDK/API inputs required by the page

The host consumes one SDK-owned query:

```ts
type ModelsPageState = {
  runtimes: Array<{
    id: string;
    harness: Harness;
    label: string;
    status:
      | "ready"
      | "checking"
      | "missing"
      | "ambiguous"
      | "needs-attention"
      | "unavailable";
    selectedConnectionId: string | null;
    modelSummary: string | null;
    compatibleConnectionIds: string[];
    blocker: { code: string; message: string; action: string | null } | null;
  }>;
  connections: Array<{
    id: string;
    name: string;
    kind: string;
    status: "ready" | "checking" | "needs-attention" | "unavailable";
    usedBy: Harness[];
    catalogState: "available" | "not-exposed" | "loading" | "error";
    modelCount: number | null;
    statusReason: string | null;
  }>;
  canWrite: boolean;
};
```

Required mutations:

```ts
useModelsPage(projectId);
useSetHarnessConnection(projectId);
useConnectModelConnection(projectId);
useTestModelConnection(projectId);
useUpdateModelConnection(projectId);
useDisconnectModelConnection(projectId);
```

All resolution, compatibility, migration, and query invalidation live in
`@kortix/sdk`. `apps/web` must not infer compatibility from connection names,
secret existence, provider IDs, models.dev, or harness strings.

## 12. Current files to replace or simplify

Primary current implementation:

- `apps/web/src/features/workspace/customize/sections/llm-provider/llm-provider-modal.tsx`
- `apps/web/src/features/workspace/customize/sections/llm-provider/connected-tab.tsx`
- `apps/web/src/features/workspace/customize/sections/llm-provider/catalog-tab.tsx`
- `apps/web/src/features/workspace/customize/sections/llm-provider/models-tab.tsx`
- `apps/web/src/features/workspace/customize/sections/llm-provider/use-connected-providers.ts`
- `apps/web/src/features/workspace/customize/sections/llm-provider/custom-provider-form.tsx`
- `apps/web/src/stores/customize-store.ts`

Composer integration:

- `apps/web/src/features/session/model-selector.tsx`
- `apps/web/src/features/session/use-model-connection-gate.tsx`
- `apps/web/src/features/session/composer-chat-input.tsx`

The new page should be organized around a page view plus small modal/row
components, not tab components. Suggested structure:

```text
llm-provider/
  models-view.tsx
  runtime-row.tsx
  connection-row.tsx
  connection-select.tsx
  connect-model-modal.tsx
  manage-connection-modal.tsx
  forms/
    claude-subscription-form.tsx
    codex-subscription-form.tsx
    api-key-form.tsx
    custom-endpoint-form.tsx
```

Names may change to match surrounding conventions; responsibilities may not be
moved into host-local data hooks.

## 13. Implementation sequence

1. Add failing SDK tests for `ModelsPageState`, route mutation, connection CRUD,
   catalog states, cache invalidation, and public exports.
2. Implement the framework-free SDK/API state projection and mutations.
3. Add component tests for runtime-row status/copy/action combinations.
4. Build the one-page shell and runtime rows against SDK fixtures.
5. Build connection rows and Connect/Manage modals.
6. Migrate subscription, API-key, and custom-endpoint forms.
7. Replace composer connection/model gates with execution options from the SDK.
8. Remove tab state, models tab, host-local projection, and universal empty-model
   blocking.
9. Run browser E2E with real API mutations and persisted reload.
10. Run real Claude, Codex, OpenCode, and Pi session creation from the page's
    selected connection state.

## 14. Acceptance tests

### One-page behavior

- no `Tabs`, `TabsList`, `TabsTrigger`, `Advanced routing`, or route matrix is
  rendered;
- all configured agent runtimes and their effective connections are visible
  without interaction;
- each runtime connection can be changed from its own row;
- all connected services and their used-by state are visible below;
- refresh reproduces the same selections from server state;
- read-only users see the same state without mutation controls.

### First-run flows

- no connections: all relevant runtime rows show direct Connect actions;
- connect Claude subscription, select it for Claude Code, start a session with
  Harness default and no catalog;
- connect ChatGPT subscription, select it for Codex, start with Harness default;
- enable Kortix for OpenCode/Pi and start with Automatic;
- add API key and custom endpoint connections, select each compatible route,
  choose default or explicit model, and start successfully.

### Error and lifecycle flows

- invalid token/key stays in the modal with actionable copy;
- expired subscription changes the runtime row and connection row together;
- route mutation failure restores the prior selection;
- connection test/retry updates without page reload;
- disconnect previews and persists fallback behavior;
- no secret value appears in DOM, API reads, logs, transcript, share, or export;
- a subscription with no model catalog never renders `0 models` and never blocks
  a harness-default launch.

### Browser assertions

- exact outgoing connection and route mutation payloads;
- visible success/error state after each mutation;
- DOM order and labels at desktop/mobile widths;
- keyboard operation for all selects, modals, and confirmation flows;
- focus returns to the invoking row after modal close;
- light/dark screenshots as secondary evidence;
- no horizontal overflow at 320px.

## 15. Definition of done

This handoff is implemented only when a non-technical user can open one page,
see what every configured agent runtime uses, connect or repair a service, change
the runtime's connection in place, and start a real ACP session without learning
provider-routing terminology.

The page is not done if the user must visit another tab, open an advanced area,
interpret a zero-model subscription, or infer which credential a runtime will
use.
