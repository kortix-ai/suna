# Project emoji icons — design

**Date:** 2026-07-31
**Branch:** `emoji` (worktree `/Users/jay/root/kortix/suna-emoji`)
**Status:** approved

---

## 1. Problem

A project has no visual identity in the projects grid.

`ProjectCard` renders `EntityAvatar` with `label={project.name}`
(`apps/web/src/features/projects/project-card.tsx:51`). `EntityAvatar` derives a
background from a hash of the name and prints the first letter
(`apps/web/src/components/ui/entity-avatar.tsx:41`).

In the 3-column grid at `apps/web/src/app/(app)/projects/page.tsx:489`, every
card is a coloured square holding one letter. Users cannot scan the grid for a
specific project. They read names instead.

Give the user one emoji per project, chosen at create time, rendered on the card.

## 2. Scope

**In scope**

1. An emoji trigger button beside the project-name input in the create-project modal.
2. A frimousse emoji picker in a Popover: search, skin-tone selector, loading state,
   empty state, colourful hover buttons, active-emoji footer preview.
3. Selection sets the project icon and closes the popover.
4. The icon persists on create through all three create paths.
5. The project card renders the icon.
6. `Cancel` action in the modal footer; `Create` disabled while the name is empty.

**Out of scope (v1)**

1. Editing the icon after creation. `rename-project-modal.tsx` stays name-only.
   Tracked as a separate follow-up issue.
2. Icons on sessions, accounts, or marketplace items.
3. Custom image upload.
4. Localised emoji labels. frimousse `locale` stays `en`; it is not wired to next-intl.

## 3. Data model

Store the icon on the existing `projects.metadata` jsonb column:

```
metadata.icon: string   // one emoji grapheme cluster, e.g. "🚀"
```

**No database migration.** `kortix.projects.metadata` already exists
(`packages/db/src/schema/kortix.ts:330`).

This follows the established pattern in this codebase. The comment at
`apps/api/src/projects/routes/r5.ts:706` states it for onboarding state:
metadata is used "so we avoid a schema migration — the projects.metadata jsonb
already exists and is already exposed by serializeProject". `metadata.experimental`,
`metadata.default_agent`, and `metadata.default_sandbox_provider` use the same
mechanism.

### 3.1 Concurrency

Every write uses `metadataMerge` from `apps/api/src/projects/lib/metadata-merge.ts`.
That helper performs the merge SQL-side under the write's own row lock, so a
concurrent writer holding a stale snapshot cannot clobber the sandbox-provider pin.

`icon` is a new **top-level** metadata key. The module docblock in
`metadata-merge.ts` maintains an audited list of disjoint top-level namespaces
(`default_agent`, `triggers_paused`, `onboarding_completed_at`, `experimental`,
`meet`, `default_sandbox_slug`). Add `icon` to that list in the same change.

### 3.2 Serialization

`serializeProject` (`apps/api/src/projects/lib/serializers.ts:164`) gains a
top-level field:

```ts
icon: string | null
```

derived from `metadata.icon` and passed through the same validator used on write.

This mirrors `default_sandbox_provider` (`serializers.ts:200`), which is stored in
metadata but exposed as a validated top-level field. Clients read `project.icon`.
No client casts `metadata` to reach it.

### 3.3 Validation

One helper, `apps/api/src/projects/lib/project-icon.ts`:

```ts
export function normalizeProjectIcon(input: unknown): string | null
```

Rules:

1. Not a string → `null`.
2. Empty after trimming → `null`.
3. Longer than 64 bytes → `null`.
4. Not exactly one grapheme cluster → `null`.
5. Not an **emoji** grapheme → `null`. A grapheme qualifies when **any** of:
   - it contains an `Extended_Pictographic` code point, **or**
   - it is exactly a regional-indicator pair (`/^\p{Regional_Indicator}{2}$/u`) — country flags, **or**
   - it is exactly a keycap: `/^[0-9#*]️?⃣$/`.

Both alternates are **anchored**. An unanchored keycap test (merely "contains
U+20E3") accepts a bare combining mark `"⃣"` with no base character, and
`"A⃣"` — neither is an emoji, both would render as junk on a project card,
and a direct API caller could write either. Verified against the shipped
validator before anchoring: `'⃣' → "⃣"`, `'A⃣' → "A⃣"`, `'z⃣' → "z⃣"`. The
anchored form accepts `0️⃣ 1️⃣ 9️⃣ #️⃣ *️⃣` and bare `1⃣`, and rejects all three.
6. Otherwise return the trimmed string.

Rule 5 is deliberately wider than `Extended_Pictographic` alone. That property is
false for country flags (`🇺🇸`, `🇬🇧` — regional-indicator pairs) and for keycaps
(`1️⃣`, `#️⃣`), both of which the frimousse picker offers as full categories.
Testing only `Extended_Pictographic` would let a user select ~270 flags and every
keycap, then silently store no icon with no error shown. Measured:

| Emoji | Graphemes | `Extended_Pictographic` | Qualifies via |
|---|---|---|---|
| `🚀` `👍🏽` `👩‍💻` `❤️` | 1 | true | pictographic |
| `🏴󠁧󠁢󠁳󠁣󠁴󠁿` (tag flag) | 1 | true | pictographic |
| `🇺🇸` `🇬🇧` | 1 | **false** | regional-indicator pair |
| `1️⃣` `#️⃣` | 1 | **false** | U+20E3 keycap |

The widening does not weaken the guard: `"abc"`, `"A"`, `"1"`, `"🚀🚀"`, `"🇺🇸🇬🇧"`
(two graphemes), and a lone regional indicator `U+1F1FA` are all still rejected.

The 64-byte cap is measured, not guessed. Verified byte lengths:

| Emoji | Bytes | Graphemes |
|---|---|---|
| `🚀` | 4 | 1 |
| `👍🏽` | 8 | 1 |
| `👩‍💻` | 11 | 1 |
| `👨‍👩‍👧‍👦` | 25 | 1 |
| `🏴󠁧󠁢󠁳󠁣󠁴󠁿` (tag flag) | 28 | 1 |
| `👩🏽‍❤️‍💋‍👨🏿` | **35** | 1 |

A 32-byte cap would reject `👩🏽‍❤️‍💋‍👨🏿`, which the picker can produce. 64 bytes
admits every RGI sequence with headroom and still rejects an abuse string.

Returning `null` means "no icon"; it never throws and never blocks project
creation. A malformed icon must not fail a create.

Without rules 3 and 4, any authenticated caller can write an arbitrary-length
string into `metadata.icon`, and it renders directly into `ProjectCard`.

Use `Intl.Segmenter` with `granularity: 'grapheme'` for rule 4. It is available in
Bun and in every browser this app supports. The helper runs server-side only; the
client does not re-validate, because the picker cannot produce an invalid value.

## 4. API changes — `apps/api`

Three create routes accept an optional `icon` field in the request body:

| Route | File | SDK caller |
|---|---|---|
| `POST /v1/projects/provision` | `apps/api/src/projects/routes/r1.ts:406` | `provisionProject` |
| `POST /v1/projects/create-repo` | `apps/api/src/projects/routes/r2.ts:235` | `createProjectRepo` |
| `POST /v1/projects/link-repository` | `apps/api/src/projects/routes/r2.ts:95` | `linkRepository` |

Each route:

1. Reads `body.icon`.
2. Passes it through `normalizeProjectIcon`.
3. When non-null, writes `{ icon }` into the project's metadata via `metadataMerge`.

`serializeProject` exposes the derived `icon` on every project response. The read
path needs no route changes — `GET /projects`, `GET /projects/:projectId`, and
every other response already run through `serializeProject`.

`PATCH /v1/projects/:projectId` is **not** changed in v1. Editing is out of scope,
and an API capability with no consumer and no test is dead code.

## 5. SDK changes — `packages/sdk`

`packages/sdk` is a published npm package. `packages/sdk/AGENTS.md` and
`packages/sdk/PROGRESS.md` govern this work: read both first, claim the task in
`PROGRESS.md`, write the failing test first, and end the change with the gates run
and their real output pasted.

Exported-type changes (all additive; no existing name is renamed or removed):

| Type | File | Change |
|---|---|---|
| `KortixProject` | `core/rest/projects-client/projects.ts:39` | `+ icon?: string \| null` |
| `ProvisionProjectInput` | `core/rest/projects-client/projects.ts:196` | `+ icon?: string` |
| `CreateProjectRepoInput` | `core/rest/projects-client/projects.ts:185` | `+ icon?: string` |
| `LinkRepositoryInput` | `core/rest/projects-client/github.ts:40` | `+ icon?: string` |

All four are additions of optional members to existing exported interfaces. No new
export is added, so the three-synchronized-edits rule for new exports does not
apply.

## 6. Web changes — `apps/web`

### 6.1 `components/ui/emoji-picker.tsx` — new

The frimousse primitive, styled with Kortix tokens. Composed from
`EmojiPicker.Root` / `Search` / `Viewport` / `List` / `Loading` / `Empty`, plus
`SkinToneSelector` and `ActiveEmoji`.

- **Search** — `EmojiPicker.Search`, placeholder "Search emoji".
- **Skin tone** — `EmojiPicker.SkinToneSelector`, in the footer row.
- **Loading** — `EmojiPicker.Loading` renders the shared `Loading` component from
  `@/components/ui/loading`. Per the global rule, the loading indicator is
  `Loading`, never a spinning icon.
- **Empty** — `EmojiPicker.Empty` uses its render-callback form to print the
  current search term: `({ search }) => <>No emoji for "{search}"</>`.
- **Footer preview** — `EmojiPicker.ActiveEmoji` render callback shows the hovered
  emoji and its label. When nothing is hovered it shows a resting hint, so the
  footer does not collapse and shift the popover height.
- **Colourful buttons** — a 6-tint rotation applied on `data-[active]`, offset by
  three positions on alternating rows, using the `:nth-child` pattern from the
  frimousse "Colorful Buttons" docs section for the *column* index.

**Row parity must NOT come from `group-odd`/`group-even`.** The docs' pattern
assumes a static list. frimousse virtualises: a row's `:nth-child()` index counts
only the rows currently mounted, and is further offset by an `aria-hidden`
measurement element and by a spacer inserted before every row that starts a
category. Measured in a real browser: logical row 17 resolved to `:nth-child(2)`,
row 18 to `:nth-child(3)`, and parity flipped mid-list at a category boundary and
again on every scroll — so the tints visibly reshuffle while scrolling.

The one stable source is `aria-rowindex`, which frimousse derives from the logical
row index (confirmed present in frimousse 0.3.0). The `Row` component reads it and
stamps `data-row="even" | "odd"`; the button variants key off
`group-data-[row=even]/row:` and `group-data-[row=odd]/row:`. Column index still
comes from `nth-[6n+k]`, which is correct because frimousse renders nothing into a
row but emoji buttons.

Variant order is not the risk — Tailwind 4.3.2 compiles both `data-[active]`-first
and `data-[active]`-last to working selectors. The DOM was the risk.

**The active state is a pale fill plus a 1px inset ring, not a fill alone.** A pale
tint at L 86-88% measures 1.26-1.40:1 against `--popover`, where WCAG 1.4.11 asks
3:1 for a state indicator — and emoji buttons are `tabIndex={-1}` with no focus
ring, so the tint is a sighted keyboard user's only cue. Reaching 3:1 with fill
alone forces L down to 46-63%, i.e. saturated mid-tones, which is louder than this
product's calm-neutral standard. So the fill stays pale and the ring carries the
contrast. Screen readers are unaffected either way — frimousse renders a
visually-hidden `aria-live` region naming the active emoji.

Values live as `@theme` custom properties in `globals.css` using `light-dark()`,
not as raw `bg-[hsl(...)]` utilities with a hand-written `dark:` block — the
design system forbids raw hex/oklch and manual dark palette hacks. `light-dark()`
resolves because `:root` and `.dark` set `color-scheme`.

Tints are low-chroma HSL in the `chalkColors` idiom already used by `EntityAvatar`
(`packages/shared/src/utils/chalk-colors.ts`), not raw Tailwind `red-100` /
`green-100` / `blue-100`. Rationale: the docs' `-100` shades are near-invisible on
a dark background and read as foreign next to the rest of `apps/web`. Six tints
rather than three, because frimousse defaults to `columns: 10` and a 3-tint
rotation over 10 columns produces visible vertical banding that the even-row
offset only partly breaks up.

Tailwind v4 is confirmed in `apps/web/package.json:191`, so `nth-[6n+k]`,
`group-odd:`, and `group-even:` variants compile with no plugin and no custom CSS.

### 6.2 `features/projects/modal/project-icon-field.tsx` — new

Composes `Popover` + trigger button + `EmojiPicker`.

- Trigger renders the selected emoji, or a neutral fallback glyph when unset.
- `aria-label` is "Choose project icon"; when set it is "Project icon: {label}".
- `onEmojiSelect` sets the icon and closes the popover.
- Controlled: takes `value: string | null` and `onChange`.

### 6.3 `features/projects/modal/project-create-modal.tsx` — edit

The file is already 1290 lines across four modes. The picker and the popover
composition live in the two new files above, so this file gains roughly 15 lines,
not 150.

1. Add `const [icon, setIcon] = useState<string | null>(null)`.
2. Render `ProjectIconField` beside the name `Input` in the `managedForm` body
   (covers `managed` and `github-create`, which share that form).
3. Render it beside the name `Input` in the `githubForm` body (`github-import`).
4. Pass `icon ?? undefined` into all three mutation payloads in `handleCreate`
   and `handleLinkGitHub`.
5. Reset `icon` to `null` in `resetAndClose`.
6. Add a `Cancel` button to both `ModalFooter`s, calling `resetAndClose`.
7. Disable `Create` while the trimmed name is empty, in addition to the existing
   `submitting` / `effectiveAccountId` conditions.

Point 7 applies to the `managedForm` footer only. The `github-import` footer keeps
its existing gating on `selectedInstallationId` and `selectedRepo`, because its
name field is optional and falls back to the repository name
(`project-create-modal.tsx:940`). Adding a name gate there would block a currently
valid flow.

### 6.4 `components/ui/entity-avatar.tsx` — edit

Add one optional prop:

```ts
emoji?: string
```

Render precedence: `emoji` > `icon` > initial. Every existing caller is unaffected.

When `emoji` is set, the tile drops the `chalkColors` background for a neutral
surface. An emoji on a saturated hash-derived tile reads as noise; the emoji is
already the colour.

**A neutral fill alone is not enough in dark mode.** Measured on the real card
composite: the emoji tile reads **1.22:1** against the card and its border
**1.07:1**, while an initial's chalk tile reads 8.72:1 — **7.1× louder**. At
1.07:1 the border is imperceptible, so the glyph floats with no tile around it
and emoji'd projects look lighter-weight than lettered ones in a mixed grid.
`bg-muted` is not the fix — it measures 1.08:1, equally quiet.

So the emoji tile carries a **hairline lift**: a stronger border token plus the
codebase's `shadow-2xs`. That restores the tile as an object in dark mode without
reintroducing colour. This matters more than it looks — `project-switcher.tsx`
renders projects at `xs`/`sm`, the two tightest sizes, and is the next surface to
take an emoji.

### 6.5 `features/projects/project-card.tsx` — edit

Pass the icon through:

```tsx
<EntityAvatar label={project.name} emoji={project.icon ?? undefined} size="lg" />
```

## 7. Dependency

```
pnpm add frimousse --filter Kortix-Computer-Frontend
```

Install the package and hand-author `components/ui/emoji-picker.tsx` against
Kortix tokens. Do **not** use `npx shadcn@latest add`: it emits a component styled
for stock shadcn defaults, which would need rewriting to meet the design standard
in `CLAUDE.md`, and it writes to the workspace without going through pnpm.

## 8. Verification

| Layer | Evidence required |
|---|---|
| `normalizeProjectIcon` | Co-located `bun:test`. Accepts `"🚀"`, a skin-toned emoji, and a ZWJ-sequence emoji. Rejects `"abc"`, `""`, `"🚀🚀"`, a 5 KB string, `null`, and `42`. |
| SDK | Failing test first per `AGENTS.md`. Gates run, real output pasted, explicit shippable YES/NO. |
| API | Real HTTP against local `:8008` with a minted Supabase JWT. For each of the three routes: create with `icon` → assert `201`, then `GET /v1/projects/:id` → assert `icon` in the body. Then create with a 5 KB `icon` → assert the project is created and `icon` is `null`. |
| Web | Playwright against the real modal. Open modal → click the icon trigger → type in Search → assert results narrow → click an emoji → assert the popover closes and the trigger shows that emoji → submit → assert the outgoing POST payload contains `icon` → assert the new card renders it. Also assert `Create` is disabled with an empty name and enabled once a name is typed. |
| Dev | PR merged to `main`, Deploy Dev run completed, deployed artifact contains the merged SHA, and the create flow re-run on `dev.kortix.com` with the icon visible on the resulting card. |

Local verification and dev verification are both required, per `CLAUDE.md`.

## 9. Known risks

1. **Banding in the picker grid.** A 6-tint rotation over 10 columns repeats every
   30 cells, which should break up vertical banding. This is not provable until it
   renders. If banding persists, adjust the tint count — not the mechanism.
2. **`packages/sdk` is the slow path.** It is a published package with mandatory
   TDD and a public-API contract. That work, not the picker, sets the pace.
3. **No edit-after-create.** A user who picks the wrong emoji cannot change it in
   v1. Accepted deliberately; tracked as a follow-up.

## 10. Delivery

Branch `emoji` → PR into `main` → required checks → merge → follow the Deploy Dev
workflow to completion → verify on `dev.kortix.com`. Per `CLAUDE.md`, work is not
done when the PR is open, and a `/health` response is not deployment proof.
